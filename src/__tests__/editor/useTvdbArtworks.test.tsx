import { beforeEach, describe, expect, it, vi, afterEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { PictoriumProvider } from "@/lib/context"
import { PosterEditorProvider } from "@/lib/contexts/PosterEditorContext"
import { ThemeProvider } from "@/lib/contexts/ThemeContext"
import { MOCK_CTX } from "@/__tests__/test-utils"
import type { SearchResult } from "@/lib/types"
import { useTvdbArtworks, __resetTvdbArtworksClientCache } from "@/lib/useTvdbArtworks"
import { isTvdbGalleryPayload, tvdbGalleryKindList } from "@/lib/tvdb-gallery-types"

const uuidState = vi.hoisted(() => ({ value: null as string | null }))
vi.mock("@/lib/user-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/user-token")>()
  return { ...actual, currentPathUuid: () => uuidState.value }
})

const SEL_A = { id: 7, media_type: "movie", title: "A", poster_path: "/a.jpg" } as unknown as SearchResult
const SEL_B = { id: 8, media_type: "movie", title: "B", poster_path: "/b.jpg" } as unknown as SearchResult
const SEL_TV = { id: 9, media_type: "tv", title: "C", poster_path: "/c.jpg" } as unknown as SearchResult

let currentSel: SearchResult | null = null
function DynWrapper({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <PosterEditorProvider>
        <PictoriumProvider value={{ ...MOCK_CTX, selected: currentSel }}>{children}</PictoriumProvider>
      </PosterEditorProvider>
    </ThemeProvider>
  )
}

const IMG = (p: string) => `https://artworks.thetvdb.com${p}`

function galleryPayload(over: Record<string, unknown> = {}) {
  return {
    posters: [
      {
        url: IMG("/banners/v4/poster/1.jpg"),
        thumbnail: IMG("/banners/v4/poster/1_t.jpg"),
        language: "eng",
        width: 680,
        height: 1000,
        includesText: false,
        score: 7.5,
        source: "tvdb",
        type: 2,
      },
      {
        url: IMG("/banners/v4/poster/2.jpg"),
        thumbnail: null,
        language: null,
        width: 680,
        height: 1000,
        score: 3,
        source: "tvdb",
        type: 2,
      },
    ],
    backdrops: [
      {
        url: IMG("/banners/v4/fanart/1.jpg"),
        thumbnail: null,
        language: "ita",
        width: 1920,
        height: 1080,
        score: 5,
        source: "tvdb",
        type: 3,
      },
    ],
    logos: [],
    source: "tvdb",
    ...over,
  }
}

const okRes = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload })
const errRes = (status: number, payload: unknown) => ({ ok: false, status, json: async () => payload })

// Provider shells (PosterEditorProvider/useDefaults) fetch on mount: only
// /api/tvdb/ calls are assertions-relevant, everything else 404s (same
// pattern as the existing PosterOptions fanart tests).
function mockTvdbFetch(tvdbImpl: (url: string) => Promise<unknown> | unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(((url: unknown) => {
    if (String(url).includes("/api/tvdb/")) return Promise.resolve(tvdbImpl(String(url)))
    return Promise.resolve(errRes(404, {}))
  }) as unknown as typeof fetch)
}

function tvdbCalls(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/api/tvdb/"))
}

function mockFetchOnce(payload: unknown) {
  return mockTvdbFetch(() => okRes(payload))
}

function useAll(enabled: boolean) {
  const posters = useTvdbArtworks(enabled, "posters")
  const backdrops = useTvdbArtworks(enabled, "backdrops")
  const logos = useTvdbArtworks(enabled, "logos")
  return { posters, backdrops, logos }
}

beforeEach(() => {
  __resetTvdbArtworksClientCache()
  uuidState.value = null
  currentSel = null
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("useTvdbArtworks idle/lazy", () => {
  it("never fetches when disabled or without a selected title", () => {
    currentSel = SEL_A
    const fetchSpy = mockFetchOnce(galleryPayload())
    const { result } = renderHook(() => useTvdbArtworks(false, "posters"), { wrapper: DynWrapper })
    expect(result.current.status).toBe("idle")
    expect(result.current.items).toEqual([])
    expect(tvdbCalls(fetchSpy)).toHaveLength(0)

    currentSel = null
    const { result: noSel } = renderHook(() => useTvdbArtworks(true, "posters"), { wrapper: DynWrapper })
    expect(noSel.current.status).toBe("idle")
    expect(tvdbCalls(fetchSpy)).toHaveLength(0)
  })

  it("requests /api/tvdb/{id}/artworks?type=movie|tv with no key material in the URL", async () => {
    currentSel = SEL_A
    const fetchSpy = mockFetchOnce(galleryPayload())
    const { result } = renderHook(() => useTvdbArtworks(true, "posters"), { wrapper: DynWrapper })
    await waitFor(() => expect(result.current.status).toBe("ready"))
    const urls = tvdbCalls(fetchSpy)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain("/api/tvdb/7/artworks?type=movie")
    expect(urls[0]).not.toMatch(/key|token|auth|secret|password/i)
  })

  it("uses type=tv for series", async () => {
    currentSel = SEL_TV
    const fetchSpy = mockFetchOnce(galleryPayload())
    const { result } = renderHook(() => useTvdbArtworks(true, "backdrops"), { wrapper: DynWrapper })
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("/api/tvdb/9/artworks?type=tv")
  })
})

describe("useTvdbArtworks mapping", () => {
  it("maps tiles TMDB-compatible (absolute file_path, honest textness flag) with honest meta", async () => {
    currentSel = SEL_A
    mockFetchOnce(galleryPayload())
    const { result } = renderHook(() => useTvdbArtworks(true, "posters"), { wrapper: DynWrapper })
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.items).toHaveLength(2)
    expect(result.current.items[0]).toMatchObject({
      file_path: IMG("/banners/v4/poster/1.jpg"),
      iso_639_1: null,
      width: 680,
      height: 1000,
    })
    // Only genuinely textless (includesText === false) reads as clean;
    // unknown textness stays honestly non-clean ("xx" sentinel here).
    expect(result.current.items[1]).toMatchObject({
      file_path: IMG("/banners/v4/poster/2.jpg"),
      iso_639_1: "xx",
    })
    // Meta preserves the raw 3-letter code, thumbnail, textless flag and type.
    expect(result.current.meta[0]).toMatchObject({
      language: "eng",
      thumbnail: IMG("/banners/v4/poster/1_t.jpg"),
      includesText: false,
      score: 7.5,
      type: 2,
    })
    // Null language stays null (unknown) — never rewritten to textless.
    expect(result.current.meta[1]).toMatchObject({ language: null, thumbnail: null })
  })

  it("derives per-kind status truthfully from one shared gallery", async () => {
    currentSel = SEL_A
    const fetchSpy = mockFetchOnce(galleryPayload())
    const { result } = renderHook(() => useAll(true), { wrapper: DynWrapper })
    await waitFor(() => expect(result.current.posters.status).toBe("ready"))
    await waitFor(() => expect(result.current.backdrops.status).toBe("ready"))
    // One fresh request for all three galleries — no triple fetch.
    expect(tvdbCalls(fetchSpy)).toHaveLength(1)
    expect(result.current.posters.items).toHaveLength(2)
    expect(result.current.backdrops.items).toHaveLength(1)
    // Empty kind is honest-empty, not borrowed.
    expect(result.current.logos.status).toBe("empty")
    expect(result.current.logos.items).toEqual([])
  })
})

describe("useTvdbArtworks stale guards", () => {
  it("discards a late response for a previous title (never shows old tiles)", async () => {
    currentSel = SEL_A
    const resolvers = new Map<number, (v: unknown) => void>()
    mockTvdbFetch((url) => {
      const m = /\/api\/tvdb\/(\d+)\//.exec(url)
      const id = m ? Number(m[1]) : -1
      return new Promise((resolve) => { resolvers.set(id, resolve) })
    })
    const payloadA = galleryPayload()
    const payloadB = galleryPayload({
      posters: [
        {
          url: IMG("/banners/v4/poster/NEW.jpg"),
          thumbnail: null,
          language: "spa",
          width: 680,
          height: 1000,
          score: 9,
          source: "tvdb",
          type: 2,
        },
      ],
    })

    const { result, rerender } = renderHook(() => useTvdbArtworks(true, "posters"), { wrapper: DynWrapper })
    expect(result.current.status).toBe("loading")
    // Switch title while A is still pending.
    currentSel = SEL_B
    rerender()
    expect(result.current.status).toBe("loading")
    expect(result.current.items).toEqual([])
    // Late A resolves first: must be discarded.
    resolvers.get(7)?.(okRes(payloadA))
    await waitFor(() => expect(resolvers.has(8)).toBe(true))
    // Flush the late-A continuation.
    await new Promise((r) => setTimeout(r, 20))
    expect(result.current.items).toEqual([])
    // B resolves: only B tiles are shown.
    resolvers.get(8)?.(okRes(payloadB))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0]?.file_path).toBe(IMG("/banners/v4/poster/NEW.jpg"))
    expect(result.current.meta[0]).toMatchObject({ language: "spa" })
  })

  it("discards a late response after a user (namespace) switch", async () => {
    uuidState.value = "11111111-1111-4111-8111-111111111111"
    currentSel = SEL_A
    const seen: string[] = []
    let firstResolve!: (v: unknown) => void
    const gate = new Promise((resolve) => { firstResolve = resolve })
    mockTvdbFetch((url) => {
      seen.push(url)
      if (seen.length === 1) return gate
      return okRes(galleryPayload())
    })

    const { result, rerender } = renderHook(() => useTvdbArtworks(true, "posters"), { wrapper: DynWrapper })
    expect(result.current.status).toBe("loading")
    // Switch user while the first request is pending.
    uuidState.value = "22222222-2222-4222-8222-222222222222"
    rerender()
    firstResolve(okRes(galleryPayload()))
    await waitFor(() => expect(seen.length).toBe(2))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    // The second (new-user) request carries the new namespace; the stale
    // first result never overwrote the fresh key's state machine.
    expect(seen[1]).toContain("u=22222222-2222-4222-8222-222222222222")
    expect(result.current.items).toHaveLength(2)
  })
})

describe("useTvdbArtworks error contracts", () => {
  it("maps 503/code tvdb_not_configured to not_configured (never empty)", async () => {
    currentSel = SEL_A
    mockTvdbFetch(() => errRes(503, { error: "nope", code: "tvdb_not_configured" }))
    const { result } = renderHook(() => useAll(true), { wrapper: DynWrapper })
    await waitFor(() => expect(result.current.posters.status).toBe("not_configured"))
    expect(result.current.backdrops.status).toBe("not_configured")
    expect(result.current.logos.status).toBe("not_configured")
    expect(result.current.posters.items).toEqual([])
  })

  it("maps 502 to unavailable with a retry that refetches", async () => {
    currentSel = SEL_A
    const fetchSpy = mockTvdbFetch(() => errRes(502, { error: "down", code: "tvdb_unavailable" }))
    const { result } = renderHook(() => useTvdbArtworks(true, "posters"), { wrapper: DynWrapper })
    await waitFor(() => expect(result.current.status).toBe("unavailable"))
    expect(result.current.items).toEqual([])
    // Retry refetches (failures are never cached) and can recover.
    fetchSpy.mockImplementation(((url: unknown) => {
      if (String(url).includes("/api/tvdb/")) return Promise.resolve(okRes(galleryPayload()))
      return Promise.resolve(errRes(404, {}))
    }) as unknown as typeof fetch)
    result.current.reload()
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.items).toHaveLength(2)
    expect(tvdbCalls(fetchSpy)).toHaveLength(2)
  })

  it("maps wrong-shape payloads and network throws to unavailable", async () => {
    currentSel = SEL_A
    mockTvdbFetch(() => okRes({ posters: "nope", backdrops: [], logos: [], source: "tvdb" }))
    const { result } = renderHook(() => useTvdbArtworks(true, "posters"), { wrapper: DynWrapper })
    await waitFor(() => expect(result.current.status).toBe("unavailable"))

    __resetTvdbArtworksClientCache()
    vi.restoreAllMocks()
    mockTvdbFetch(() => { throw new Error("boom") })
    const { result: net } = renderHook(() => useTvdbArtworks(true, "posters"), { wrapper: DynWrapper })
    await waitFor(() => expect(net.current.status).toBe("unavailable"))
  })

  it("reports all-empty galleries as empty per kind", async () => {
    currentSel = SEL_A
    mockFetchOnce(galleryPayload({ posters: [], backdrops: [], logos: [] }))
    const { result } = renderHook(() => useAll(true), { wrapper: DynWrapper })
    await waitFor(() => expect(result.current.posters.status).toBe("empty"))
    expect(result.current.backdrops.status).toBe("empty")
    expect(result.current.logos.status).toBe("empty")
  })
})

describe("useTvdbArtworks reload generation guards", () => {
  const STALE_URL = IMG("/banners/v4/poster/STALE.jpg")
  const FRESH_URL = IMG("/banners/v4/poster/FRESH.jpg")
  const stalePayload = () =>
    galleryPayload({
      posters: [
        {
          url: STALE_URL,
          thumbnail: null,
          language: "eng",
          width: 680,
          height: 1000,
          includesText: false,
          score: 1,
          source: "tvdb",
          type: 2,
        },
      ],
    })
  const freshPayload = () =>
    galleryPayload({
      posters: [
        {
          url: FRESH_URL,
          thumbnail: null,
          language: "spa",
          width: 680,
          height: 1000,
          includesText: false,
          score: 9,
          source: "tvdb",
          type: 2,
        },
      ],
    })

  it("stale pre-reload success cannot replace fresh items or cache", async () => {
    currentSel = SEL_A
    let resolveOld!: (v: unknown) => void
    const oldGate = new Promise((resolve) => { resolveOld = resolve })
    let calls = 0
    mockTvdbFetch(() => {
      calls += 1
      if (calls === 1) return oldGate
      return okRes(freshPayload())
    })
    const { result } = renderHook(() => useTvdbArtworks(true, "posters"), { wrapper: DynWrapper })
    expect(result.current.status).toBe("loading")
    // Reload while the first request is still pending: the fresh request wins.
    result.current.reload()
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.items[0]?.file_path).toBe(FRESH_URL)
    // The obsolete first request settles late with a stale outcome.
    resolveOld(okRes(stalePayload()))
    await new Promise((r) => setTimeout(r, 30))
    expect(result.current.items[0]?.file_path).toBe(FRESH_URL)
    expect(result.current.status).toBe("ready")
    // The stale outcome must not have poisoned the resolved cache either.
    const callsAfter = calls
    const { result: second } = renderHook(() => useTvdbArtworks(true, "posters"), { wrapper: DynWrapper })
    await waitFor(() => expect(second.current.status).toBe("ready"))
    expect(second.current.items[0]?.file_path).toBe(FRESH_URL)
    expect(calls).toBe(callsAfter)
  })

  it("stale abort after reload cannot wipe fresh state", async () => {
    currentSel = SEL_A
    let rejectOld!: (e: unknown) => void
    const oldGate = new Promise((_resolve, reject) => { rejectOld = reject })
    let calls = 0
    mockTvdbFetch(() => {
      calls += 1
      if (calls === 1) return oldGate
      return okRes(freshPayload())
    })
    const { result } = renderHook(() => useTvdbArtworks(true, "posters"), { wrapper: DynWrapper })
    expect(result.current.status).toBe("loading")
    result.current.reload()
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.items[0]?.file_path).toBe(FRESH_URL)
    // The obsolete request aborts (reload owns it): no wipe to unavailable.
    rejectOld(new DOMException("TVDB gallery aborted", "AbortError"))
    await new Promise((r) => setTimeout(r, 30))
    expect(result.current.status).toBe("ready")
    expect(result.current.items[0]?.file_path).toBe(FRESH_URL)
    expect(calls).toBe(2)
  })
})

describe("tvdb-gallery-types guard", () => {
  it("accepts the route envelope, rejects non-arrays and foreign sources", () => {
    expect(isTvdbGalleryPayload(galleryPayload())).toBe(true)
    expect(isTvdbGalleryPayload(null)).toBe(false)
    expect(isTvdbGalleryPayload({ posters: [], backdrops: [] })).toBe(false)
    expect(isTvdbGalleryPayload({ ...galleryPayload(), source: "fanart" })).toBe(false)
    expect(isTvdbGalleryPayload({ ...galleryPayload(), posters: "x" })).toBe(false)
  })

  it("drops malformed/off-host/non-https items, keeps exact-host ones", () => {
    const payload = galleryPayload({
      posters: [
        { url: IMG("/banners/v4/poster/ok.jpg"), language: "eng", source: "tvdb", type: 2 },
        { url: "http://artworks.thetvdb.com/banners/x.jpg" },
        { url: "https://evil.example/x.jpg" },
        { url: 42 },
        null,
      ],
    })
    expect(isTvdbGalleryPayload(payload)).toBe(true)
    const list = tvdbGalleryKindList(payload, "posters")
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ url: IMG("/banners/v4/poster/ok.jpg"), language: "eng", source: "tvdb", type: 2 })
  })
})
