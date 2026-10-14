import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"

vi.mock("@/lib/http", () => ({ userFetch: vi.fn() }))
vi.mock("@/lib/guest-guard", () => ({
  isProfilelessOnMultiUser: vi.fn().mockResolvedValue(false),
  notifyProfilelessOnce: vi.fn(),
  shouldSkipServerSync: vi.fn().mockResolvedValue(false),
}))
vi.mock("sonner", () => ({ toast: { warning: vi.fn(), info: vi.fn() } }))

import { userFetch } from "@/lib/http"
import { shouldSkipServerSync } from "@/lib/guest-guard"
import { useRankingSources } from "@/lib/useRankingSources"

const mockedFetch = vi.mocked(userFetch)
const mockedSkip = vi.mocked(shouldSkipServerSync)

function memStore(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    get: (k: string) => map.get(k) ?? null,
    set: (k: string, v: string) => {
      map.set(k, v)
    },
    raw: map,
  }
}

const okEmptyGet = { ok: true, json: async () => ({}) } as unknown as Response
const okPut = { ok: true, status: 200, json: async () => ({}) } as unknown as Response
const failPut = { ok: false, status: 500 } as unknown as Response

function putCalls() {
  return mockedFetch.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "PUT")
}

function putBodies(): Array<Record<string, unknown>> {
  return putCalls().map(([, init]) => JSON.parse(String((init as RequestInit)?.body)) as Record<string, unknown>)
}

/** Deferred PUTs: GET resolves instantly, every PUT waits for its resolver. */
function deferredPuts() {
  const resolvers: Array<(v: Response) => void> = []
  mockedFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") return new Promise<Response>((res) => resolvers.push(res))
    return okEmptyGet
  })
  return resolvers
}

describe("useRankingSources save lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedSkip.mockResolvedValue(false)
    mockedFetch.mockResolvedValue(okEmptyGet)
  })

  it("overlapping save: B success then C failure restores server-confirmed B", async () => {
    const store = memStore()
    const resolvers = deferredPuts()
    const { result } = renderHook(() => useRankingSources(store.get, store.set))
    const nonceBefore = result.current.rankSourceNonce

    // B picked; its PUT body is captured before C is ever selected.
    let pB!: Promise<boolean>
    await act(async () => {
      pB = result.current.setRankingSource("movie", "B")
    })
    await waitFor(() => expect(putCalls()).toHaveLength(1))
    expect(putBodies()[0]).toMatchObject({ rankingSourceMovie: "B", rankingSourceSeries: "" })

    // C picked while B is still in flight (parallel-slot path, e.g.
    // removeCustomCatalog clearing both slots at once).
    let pC!: Promise<boolean>
    await act(async () => {
      pC = result.current.setRankingSource("movie", "C")
    })
    expect(result.current.rankingSourceMovie).toBe("C")
    expect(result.current.rankingSourceStatus).toBe("saving")

    // B's PUT succeeds while C is still pending: the stale success must not
    // mark the newer intent saved, bump the nonce, or flip to ready.
    await act(async () => {
      resolvers.shift()!(okPut)
      await pB
    })
    await waitFor(() => expect(putCalls()).toHaveLength(2))
    expect(result.current.rankingSourceStatus).toBe("saving")
    expect(result.current.rankSourceNonce).toBe(nonceBefore)

    // C's PUT fails: rollback targets the last actually persisted payload
    // (B), never the unsaved C.
    let rB = false
    let rC = true
    await act(async () => {
      resolvers.shift()!(failPut)
      const [a, b] = await Promise.all([pB, pC])
      rB = a
      rC = b
    })
    expect(rB).toBe(true)
    expect(rC).toBe(false)
    expect(result.current.rankingSourceMovie).toBe("B")
    expect(result.current.rankingSourceStatus).toBe("error")
    expect(result.current.rankSourceNonce).toBe(nonceBefore)
  })

  it("overlapping saves that both succeed emit a single nonce for the converged intent", async () => {
    const store = memStore()
    const resolvers = deferredPuts()
    const { result } = renderHook(() => useRankingSources(store.get, store.set))
    const nonceBefore = result.current.rankSourceNonce

    let pB!: Promise<boolean>
    await act(async () => {
      pB = result.current.setRankingSource("movie", "B")
    })
    await waitFor(() => expect(putCalls()).toHaveLength(1))
    let pC!: Promise<boolean>
    await act(async () => {
      pC = result.current.setRankingSource("movie", "C")
    })
    await act(async () => {
      resolvers.shift()!(okPut)
      await pB
    })
    await waitFor(() => expect(putCalls()).toHaveLength(2))
    let rB = false
    let rC = false
    await act(async () => {
      resolvers.shift()!(okPut)
      const [a, b] = await Promise.all([pB, pC])
      rB = a
      rC = b
    })
    expect(rB).toBe(true)
    expect(rC).toBe(true)
    expect(result.current.rankingSourceMovie).toBe("C")
    expect(result.current.rankingSourceStatus).toBe("ready")
    // One acknowledged intent change, one nonce: the stale B success must not
    // trigger an obsolete rank refetch on top of C's.
    expect(result.current.rankSourceNonce).toBe(nonceBefore + 1)
    const bodies = putBodies()
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toMatchObject({ rankingSourceMovie: "C", rankingSourceSeries: "" })
  })

  it("parallel slot saves converge with sequential writes and a single nonce", async () => {
    const store = memStore()
    const resolvers = deferredPuts()
    const { result } = renderHook(() => useRankingSources(store.get, store.set))
    const nonceBefore = result.current.rankSourceNonce

    let pM!: Promise<boolean>
    let pS!: Promise<boolean>
    await act(async () => {
      pM = result.current.setRankingSource("movie", "cat_m")
      pS = result.current.setRankingSource("series", "cat_s")
    })
    await waitFor(() => expect(putCalls()).toHaveLength(1))
    await act(async () => {
      resolvers.shift()!(okPut)
      await pM
    })
    await waitFor(() => expect(putCalls()).toHaveLength(2))
    let okM = false
    let okS = false
    await act(async () => {
      resolvers.shift()!(okPut)
      const [a, b] = await Promise.all([pM, pS])
      okM = a
      okS = b
    })
    expect(okM).toBe(true)
    expect(okS).toBe(true)
    expect(result.current.rankingSourceMovie).toBe("cat_m")
    expect(result.current.rankingSourceSeries).toBe("cat_s")
    // Two distinct persisted intents need sequential writes (no lost slot),
    // but only the latest completion acknowledges with a nonce.
    const bodies = putBodies()
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).not.toEqual(bodies[1])
    expect(bodies[1]).toMatchObject({ rankingSourceMovie: "cat_m", rankingSourceSeries: "cat_s" })
    expect(result.current.rankSourceNonce).toBe(nonceBefore + 1)
  })

  it("local-only skip path persists without PUT and still acknowledges once", async () => {
    mockedSkip.mockResolvedValue(true)
    const store = memStore()
    const { result } = renderHook(() => useRankingSources(store.get, store.set))
    const nonceBefore = result.current.rankSourceNonce

    let ok = false
    await act(async () => {
      ok = await result.current.setRankingSource("movie", "cat_local")
    })
    expect(ok).toBe(true)
    expect(putCalls()).toHaveLength(0)
    expect(result.current.rankingSourceMovie).toBe("cat_local")
    expect(result.current.rankingSourceStatus).toBe("ready")
    expect(result.current.rankSourceNonce).toBe(nonceBefore + 1)
  })

  it("re-saving the already persisted value sends no redundant PUT", async () => {
    const store = memStore()
    mockedFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT" ? okPut : okEmptyGet,
    )
    const { result } = renderHook(() => useRankingSources(store.get, store.set))

    await act(async () => {
      await result.current.setRankingSource("movie", "cat_x")
    })
    expect(putCalls()).toHaveLength(1)
    const nonceAfterFirst = result.current.rankSourceNonce

    let ok = false
    await act(async () => {
      ok = await result.current.setRankingSource("movie", "cat_x")
    })
    expect(ok).toBe(true)
    expect(putCalls()).toHaveLength(1)
    expect(result.current.rankingSourceMovie).toBe("cat_x")
    expect(result.current.rankSourceNonce).toBe(nonceAfterFirst)
  })

  it("re-selecting the local value after a silent GET still PUTs (local is not server truth)", async () => {
    const store = memStore({ pictorium_ranking_source_movie: "jw:popular" })
    mockedFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT" ? okPut : okEmptyGet,
    )
    const { result } = renderHook(() => useRankingSources(store.get, store.set))
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled())
    await act(async () => {})
    expect(result.current.rankingSourceMovie).toBe("jw:popular")

    // The namespace has no selection (GET {}): the server still resolves
    // charts, so re-selecting the device-local jw:popular must persist it.
    let ok = false
    await act(async () => {
      ok = await result.current.setRankingSource("movie", "jw:popular")
    })
    expect(ok).toBe(true)
    expect(putCalls()).toHaveLength(1)
    expect(putBodies()[0]).toMatchObject({ rankingSourceMovie: "jw:popular" })
  })

  it("re-selecting the local value while GET is still pending still PUTs", async () => {
    const store = memStore({ pictorium_ranking_source_movie: "jw:popular" })
    mockedFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return okPut
      return new Promise<Response>(() => {})
    })
    const { result } = renderHook(() => useRankingSources(store.get, store.set))
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled())

    let ok = false
    await act(async () => {
      ok = await result.current.setRankingSource("movie", "jw:popular")
    })
    expect(ok).toBe(true)
    expect(putCalls()).toHaveLength(1)
    expect(putBodies()[0]).toMatchObject({ rankingSourceMovie: "jw:popular" })
  })

  it("re-selecting the local value while the server is unreachable still attempts PUT", async () => {
    const store = memStore({ pictorium_ranking_source_movie: "jw:popular" })
    mockedFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return okPut
      throw new Error("offline")
    })
    const { result } = renderHook(() => useRankingSources(store.get, store.set))
    await act(async () => {})

    let ok = false
    await act(async () => {
      ok = await result.current.setRankingSource("movie", "jw:popular")
    })
    expect(ok).toBe(true)
    expect(putCalls()).toHaveLength(1)
  })

  it("re-saving the server default after a silent GET sends no redundant PUT", async () => {
    const store = memStore()
    mockedFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT" ? okPut : okEmptyGet,
    )
    const { result } = renderHook(() => useRankingSources(store.get, store.set))
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled())
    await act(async () => {})
    const nonceBefore = result.current.rankSourceNonce

    // Absent GET fields resolve to charts ("") on the server: the default is
    // already confirmed, so this is a genuine no-op.
    let ok = false
    await act(async () => {
      ok = await result.current.setRankingSource("movie", "")
    })
    expect(ok).toBe(true)
    expect(putCalls()).toHaveLength(0)
    expect(result.current.rankSourceNonce).toBe(nonceBefore)
  })

  it("concurrent same-source saves ship one PUT and emit exactly one nonce", async () => {
    const store = memStore()
    const resolvers = deferredPuts()
    const { result } = renderHook(() => useRankingSources(store.get, store.set))
    const nonceBefore = result.current.rankSourceNonce

    let pB1!: Promise<boolean>
    await act(async () => {
      pB1 = result.current.setRankingSource("movie", "B")
    })
    await waitFor(() => expect(putCalls()).toHaveLength(1))
    // Same source picked again while the first PUT is still in flight.
    let pB2!: Promise<boolean>
    await act(async () => {
      pB2 = result.current.setRankingSource("movie", "B")
    })

    let r1 = false
    let r2 = false
    await act(async () => {
      resolvers.shift()!(okPut)
      const [a, b] = await Promise.all([pB1, pB2])
      r1 = a
      r2 = b
    })
    expect(r1).toBe(true)
    expect(r2).toBe(true)
    // One confirmed change, one write: the redundant job ships no second PUT.
    expect(putCalls()).toHaveLength(1)
    expect(result.current.rankingSourceMovie).toBe("B")
    expect(result.current.rankingSourceStatus).toBe("ready")
    // ...but rank consumers must still refresh exactly once for the newly
    // confirmed payload (the stale success already suppressed its own nonce).
    expect(result.current.rankSourceNonce).toBe(nonceBefore + 1)
  })
})
