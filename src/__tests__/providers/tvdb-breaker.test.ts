import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getTvdbSeriesId, getTvdbToken, clearTvdbCache } from "@/lib/tvdb"

function loginOk() {
  return Promise.resolve(Response.json({ status: "success", data: { token: "mock-jwt" } }))
}

function searchOk(tvdbId: number) {
  return Promise.resolve(
    Response.json({ status: "success", data: [{ series: { id: tvdbId } }] }),
  )
}

function statusRes(status: number, retryAfter?: string) {
  return Promise.resolve({
    ok: false,
    status,
    headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? retryAfter ?? null : null) },
    json: async () => ({}),
  } as unknown as Response)
}

type FetchMock = (...args: unknown[]) => Promise<unknown>

// Breaker TVDB dedicato (Phase 4): 5 fallimenti → 60s cooldown, fail-open
// con fallback all'ordinamento standard nei caller. clearTvdbCache() azzera
// anche il breaker: ogni test riparte da zero senza modifiche ai test esistenti.
describe("TVDB breaker (fail-open, 5 fails → 60s)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearTvdbCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    clearTvdbCache()
  })

  it("opens after 5 failures and short-circuits without fetching", async () => {
    const fetchMock = vi.fn<FetchMock>(async () => {
      throw new Error("upstream down")
    })
    vi.stubGlobal("fetch", fetchMock)

    // Ogni getTvdbSeriesId tenta il login (1 fetch, 1 failure).
    for (let i = 0; i < 5; i++) expect(await getTvdbSeriesId("tt0903747", "k")).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(5)

    // Breaker aperto: sesto tentativo ritorna subito null senza rete.
    expect(await getTvdbSeriesId("tt0903747", "k")).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it("recovers via half-open trial after the 60s window", async () => {
    const fetchMock = vi.fn<FetchMock>(async () => {
      throw new Error("upstream down")
    })
    vi.stubGlobal("fetch", fetchMock)

    for (let i = 0; i < 5; i++) await getTvdbSeriesId("tt0903747", "k")
    expect(fetchMock).toHaveBeenCalledTimes(5)

    vi.setSystemTime(Date.now() + 61_000)
    fetchMock.mockImplementationOnce(() => loginOk()).mockImplementationOnce(() => searchOk(75710))
    expect(await getTvdbSeriesId("tt0903747", "k")).toBe(75710)

    // Breaker richiuso; il token del trial è in cache: basta la search.
    fetchMock.mockImplementationOnce(() => searchOk(123))
    expect(await getTvdbSeriesId("tt0000001", "k")).toBe(123)
  })

  it("429 with Retry-After extends the window to the upstream value", async () => {
    const fetchMock = vi.fn(() => loginOk())
    vi.stubGlobal("fetch", fetchMock)
    expect(await getTvdbToken("k")).toBe("mock-jwt") // token in cache: poi solo search

    fetchMock.mockImplementation(() => statusRes(429, "120"))
    for (let i = 0; i < 5; i++) expect(await getTvdbSeriesId("ttA", "k")).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(6) // 1 login + 5 search

    const t0 = Date.now()
    vi.setSystemTime(t0 + 61_000)
    // Finestra custom 120s ancora aperta: niente rete.
    expect(await getTvdbSeriesId("ttB", "k")).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(6)

    vi.setSystemTime(t0 + 121_000)
    fetchMock.mockImplementationOnce(() => searchOk(999))
    expect(await getTvdbSeriesId("ttB", "k")).toBe(999)
  })

  it("401 (bad key) fails fast without tripping the breaker", async () => {
    const fetchMock = vi.fn(() => statusRes(401))
    vi.stubGlobal("fetch", fetchMock)

    for (let i = 0; i < 6; i++) expect(await getTvdbToken("bad-key")).toBeNull()
    // Mai short-circuit: il sesto tentativo tocca ancora la rete.
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  // Ultimo: re-import con budget ridotto via env (i const sono module-level).
  // Timer reali: le pagine lente (2s) oltre il budget da 6s interrompono il loop.
  it("episodes pagination respects the total budget on slow upstream", { timeout: 20000 }, async () => {
    vi.useRealTimers()
    vi.stubEnv("PICTORIUM_TVDB_EPISODES_BUDGET_MS", "6000")
    vi.resetModules()
    const tvdb = await import("@/lib/tvdb")
    tvdb.clearTvdbCache()

    let episodeCalls = 0
    const slowPages = vi.fn(async (url: unknown) => {
      const u = String(url)
      if (u.endsWith("/login")) return Response.json({ status: "success", data: { token: "t" } })
      episodeCalls++
      await new Promise((r) => setTimeout(r, 2000))
      return Response.json({
        status: "success",
        data: { episodes: [{ id: episodeCalls, seasonNumber: 1, number: episodeCalls }] },
        links: { total_pages: 50 },
      })
    })
    vi.stubGlobal("fetch", slowPages)

    const t0 = Date.now()
    const eps = await tvdb.getTvdbEpisodes(75710, "ita", "k")
    const elapsed = Date.now() - t0

    // ~3 pagine da 2s invece di 50: il budget interrompe, con risultati parziali.
    expect(episodeCalls).toBeLessThan(6)
    expect(eps.length).toBe(episodeCalls)
    expect(elapsed).toBeLessThan(15000)
  })
})
