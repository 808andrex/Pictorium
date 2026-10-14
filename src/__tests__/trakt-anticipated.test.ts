import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  detectCatalogProvider,
  fetchUnifiedCatalogItems,
  fetchUnifiedCatalogResult,
} from "@/lib/custom-catalog-providers"
import { cacheInvalidate } from "@/lib/cache"

const CLIENT_ID = "test-trakt-anticipated-client-id"

function anticipatedItem(imdb: string | null, tmdb: number | null, title: string, year: number, listCount = 1) {
  return {
    list_count: listCount,
    movie: { title, year, ids: { trakt: 1000 + (tmdb ?? 0), slug: "x", imdb, tmdb } },
  }
}

describe("detectCatalogProvider: Trakt anticipated (film-only)", () => {
  it("detects app.trakt.tv/discover/anticipated?mode=movie as trakt/movie", () => {
    const res = detectCatalogProvider("https://app.trakt.tv/discover/anticipated?mode=movie")
    expect(res).not.toBeNull()
    expect(res?.provider).toBe("trakt")
    expect(res?.nameSuggestion).toBe("Trakt Anticipated Movies")
    expect(res?.defaultType).toBe("movie")
  })

  it("accepts the www and bare trakt.tv hosts for anticipated", () => {
    for (const url of [
      "https://www.trakt.tv/discover/anticipated?mode=movie",
      "https://trakt.tv/discover/anticipated?mode=movie",
    ]) {
      const res = detectCatalogProvider(url)
      expect(res?.provider).toBe("trakt")
      expect(res?.defaultType).toBe("movie")
    }
  })

  it("routes unknown/missing anticipated modes to trakt for an explicit unsupported status", () => {
    // Conservative: no implicit movie default, no series without requirement.
    // Detection routes (typed `unsupported` at fetch, save stays blocked)
    // instead of falling into the MDBList fallback with a generic `empty`.
    for (const url of [
      "https://app.trakt.tv/discover/anticipated",
      "https://app.trakt.tv/discover/anticipated?mode=shows",
      "https://app.trakt.tv/discover/anticipated?mode=series",
      "https://app.trakt.tv/discover/anticipated?mode=all",
    ]) {
      const res = detectCatalogProvider(url)
      expect(res?.provider).toBe("trakt")
      expect(res?.defaultType).toBe("movie")
    }
    // Other discovery pages are out of scope (trending has its own support).
    expect(detectCatalogProvider("https://app.trakt.tv/discover/popular?mode=movie")).toBeNull()
  })

  it("rejects lookalike hosts (exact host restriction)", () => {
    expect(detectCatalogProvider("https://trakt.tv.evil.com/users/x/lists/y")).toBeNull()
    expect(detectCatalogProvider("https://app.trakt.tv.evil.com/discover/anticipated?mode=movie")).toBeNull()
  })
})

describe("detectCatalogProvider: app.trakt.tv public lists", () => {
  it("detects app.trakt.tv user lists like trakt.tv ones", () => {
    const res = detectCatalogProvider("https://app.trakt.tv/users/donxy/lists/marvel-cinematic-universe")
    expect(res).not.toBeNull()
    expect(res?.provider).toBe("trakt")
    expect(res?.nameSuggestion).toBe("Marvel Cinematic Universe")
    expect(res?.defaultType).toBe("mixed")
  })

  it("detects app.trakt.tv bare lists", () => {
    const res = detectCatalogProvider("https://app.trakt.tv/lists/55-some-list")
    expect(res?.provider).toBe("trakt")
    expect(res?.defaultType).toBe("mixed")
  })

  it("keeps watchlist recognition on the app host (still unsupported at fetch)", () => {
    const res = detectCatalogProvider("https://app.trakt.tv/users/donxy/watchlist")
    expect(res?.provider).toBe("trakt")
  })
})

describe("fetchUnifiedCatalogResult: Trakt anticipated via official API", () => {
  const ANTICIPATED_URL = "https://app.trakt.tv/discover/anticipated?mode=movie"

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.PICTORIUM_TRAKT_CLIENT_ID = CLIENT_ID
    delete process.env.TRAKT_API_URL
  })

  afterEach(() => {
    delete process.env.PICTORIUM_TRAKT_CLIENT_ID
    delete process.env.TRAKT_API_URL
    cacheInvalidate("custom_catalogs")
  })

  it("yields resolvable movie items in API order (never bare Trakt ids)", async () => {
    const seenUrls: string[] = []
    let seenKey = ""
    global.fetch = vi.fn().mockImplementation((url: string, opts?: { headers?: Record<string, string> }) => {
      seenUrls.push(String(url))
      seenKey = String(opts?.headers?.["trakt-api-key"] || "")
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => [
          anticipatedItem("tt0371746", 1726, "Iron Man", 2008, 42),
          anticipatedItem("tt0800080", 1724, "Hulk", 2008, 41),
        ],
      })
    }) as unknown as typeof fetch

    const result = await fetchUnifiedCatalogResult(ANTICIPATED_URL)
    expect(result.status).toBe("ok")
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({ imdb: "tt0371746", tmdb: 1726, title: "Iron Man", year: 2008, mediatype: "movie" })
    expect(result.items[1]).toMatchObject({ imdb: "tt0800080", tmdb: 1724, title: "Hulk", mediatype: "movie" })
    expect(seenUrls[0]).toContain("api.trakt.tv/movies/anticipated")
    expect(seenUrls[0]).toContain("limit=100")
    expect(seenKey).toBe(CLIENT_ID)
  })

  it("skips unresolvable entries and error-shaped bodies instead of emitting them", async () => {
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => [
          anticipatedItem("tt0371746", 1726, "Iron Man", 2008),
          { list_count: 5, movie: { title: "No Ids", year: 2030, ids: { trakt: 9, slug: "x", imdb: null, tmdb: null } } },
          { error: "upstream hiccup" },
          anticipatedItem(null, 9999, "Tmdb Only", 2029),
        ],
      })
    ) as unknown as typeof fetch

    const items = await fetchUnifiedCatalogItems(ANTICIPATED_URL)
    expect(items).toHaveLength(2)
    expect(items.map((i) => i.title)).toEqual(["Iron Man", "Tmdb Only"])
    for (const it of items) {
      expect(it.imdb || it.tmdb).toBeTruthy()
    }
  })

  it("bounds pagination to the requested limit", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      const page = Number(new URL(String(url)).searchParams.get("page") || "1")
      const payload =
        page <= 2
          ? Array.from({ length: 100 }, (_, i) => anticipatedItem(null, page * 1000 + i, `M${page * 1000 + i}`, 2030))
          : []
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "X-Pagination-Page-Count": "10" }),
        json: async () => payload,
      })
    }) as unknown as typeof fetch

    const result = await fetchUnifiedCatalogResult(ANTICIPATED_URL, { limit: 150 })
    expect(result.status).toBe("ok")
    expect(result.items).toHaveLength(150)
    // Two full pages then stop: no unbounded walk over all 10 pages.
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it("serves the landed prefix as incomplete on abort instead of freezing it", async () => {
    const ctrl = new AbortController()
    let page2 = 0
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown, init?: RequestInit) => {
      const u = String(input)
      if (u.includes("/movies/anticipated")) {
        if (u.includes("page=2")) {
          page2++
          const sig = init?.signal as AbortSignal | undefined
          queueMicrotask(() => ctrl.abort())
          await new Promise<void>((_res, rej) => {
            sig?.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")), { once: true })
          })
          throw new DOMException("Aborted", "AbortError")
        }
        return Response.json(Array.from({ length: 100 }, (_, i) => anticipatedItem(null, 5000 + i, `A${i}`, 2030)))
      }
      return Response.json({}, { status: 404 })
    })

    const first = await fetchUnifiedCatalogResult(ANTICIPATED_URL, { signal: ctrl.signal })
    expect(first.status).toBe("ok")
    expect(first.items).toHaveLength(100)
    expect(first.incomplete).toBe(true)
    expect(page2).toBe(1)

    // Incomplete is never long-cached: the healthy retry refetches.
    vi.restoreAllMocks()
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
      const u = String(input)
      if (u.includes("/movies/anticipated")) {
        if (u.includes("page=2")) return Response.json([anticipatedItem(null, 6000, "B", 2031)])
        return Response.json(Array.from({ length: 100 }, (_, i) => anticipatedItem(null, 5000 + i, `A${i}`, 2030)))
      }
      return Response.json({}, { status: 404 })
    })
    const second = await fetchUnifiedCatalogResult(ANTICIPATED_URL)
    expect(second.items).toHaveLength(101)
    expect(second.incomplete).toBeFalsy()
  })

  it("treats a top-level error body as transient, not as entries", async () => {
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ error: "bad gateway" }),
      })
    ) as unknown as typeof fetch

    const result = await fetchUnifiedCatalogResult(ANTICIPATED_URL)
    expect(result.items).toEqual([])
    expect(result.status).toBe("unavailable")
  })

  it("maps key_missing/private/not_found/rate_limited distinctly", async () => {
    // key_missing: never hits the network.
    delete process.env.PICTORIUM_TRAKT_CLIENT_ID
    global.fetch = vi.fn(() => Promise.reject(new Error("must not fetch"))) as unknown as typeof fetch
    expect((await fetchUnifiedCatalogResult(ANTICIPATED_URL)).status).toBe("key_missing")
    expect(global.fetch).not.toHaveBeenCalled()
    process.env.PICTORIUM_TRAKT_CLIENT_ID = CLIENT_ID

    for (const [status, expected] of [
      [401, "private"],
      [403, "private"],
      [404, "not_found"],
      [429, "rate_limited"],
    ] as const) {
      global.fetch = vi.fn().mockImplementation(() =>
        Promise.resolve({ ok: false, status, headers: new Headers(), json: async () => ({}) })
      ) as unknown as typeof fetch
      expect((await fetchUnifiedCatalogResult(`${ANTICIPATED_URL}&t=${status}`)).status).toBe(expected)
    }
  })

  it("rejects unsupported anticipated modes without network access", async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error("must not fetch"))) as unknown as typeof fetch
    const result = await fetchUnifiedCatalogResult("https://app.trakt.tv/discover/anticipated?mode=shows")
    expect(result.items).toEqual([])
    expect(result.status).toBe("unsupported")
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("fetches app.trakt.tv public lists through the same official list API", async () => {
    const seenUrls: string[] = []
    global.fetch = vi.fn().mockImplementation((url: string) => {
      seenUrls.push(String(url))
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => [
          { type: "movie", movie: { title: "Iron Man", year: 2008, ids: { trakt: 1, slug: "x", imdb: "tt0371746", tmdb: 1726 } } },
        ],
      })
    }) as unknown as typeof fetch

    const result = await fetchUnifiedCatalogResult("https://app.trakt.tv/users/donxy/lists/app-host-compat-test")
    expect(result.status).toBe("ok")
    expect(result.items).toHaveLength(1)
    expect(seenUrls[0]).toContain("api.trakt.tv/users/donxy/lists/app-host-compat-test/items/movie,show")
  })

  it("keeps watchlist/private behavior: no network, unsupported", async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error("must not fetch"))) as unknown as typeof fetch
    const result = await fetchUnifiedCatalogResult("https://app.trakt.tv/users/donxy/watchlist")
    expect(result.items).toEqual([])
    expect(result.status).toBe("unsupported")
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
