import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  detectCatalogProvider,
  fetchUnifiedCatalogItems,
  fetchUnifiedCatalogResult,
} from "@/lib/custom-catalog-providers"
import { cacheInvalidate } from "@/lib/cache"

const CLIENT_ID = "test-trakt-trending-client-id"
const TRENDING_URL = "https://app.trakt.tv/discover/trending?mode=movie"
const SMART_URL =
  "https://app.trakt.tv/lists/smart/view/films-5b36850652cd19c0?mode=movie"

function trendingItem(
  imdb: string | null,
  tmdb: number | null,
  title: string,
  year: number,
  watchers = 1,
) {
  return {
    watchers,
    movie: { title, year, ids: { trakt: 1000 + (tmdb ?? 0), slug: "x", imdb, tmdb } },
  }
}

describe("detectCatalogProvider: Trakt trending (film-only)", () => {
  it("detects app.trakt.tv/discover/trending?mode=movie as trakt/movie", () => {
    const res = detectCatalogProvider(TRENDING_URL)
    expect(res).not.toBeNull()
    expect(res?.provider).toBe("trakt")
    expect(res?.nameSuggestion).toBe("Trakt Trending Movies")
    expect(res?.defaultType).toBe("movie")
  })

  it("accepts the www and bare trakt.tv hosts for trending", () => {
    for (const url of [
      "https://www.trakt.tv/discover/trending?mode=movie",
      "https://trakt.tv/discover/trending?mode=movie",
    ]) {
      const res = detectCatalogProvider(url)
      expect(res?.provider).toBe("trakt")
      expect(res?.defaultType).toBe("movie")
    }
  })

  it("routes unknown/missing trending modes to trakt for an explicit unsupported status", () => {
    for (const url of [
      "https://app.trakt.tv/discover/trending",
      "https://app.trakt.tv/discover/trending?mode=shows",
      "https://app.trakt.tv/discover/trending?mode=series",
      "https://app.trakt.tv/discover/trending?mode=all",
    ]) {
      const res = detectCatalogProvider(url)
      expect(res?.provider).toBe("trakt")
      expect(res?.defaultType).toBe("movie")
    }
  })

  it("rejects lookalike hosts (exact host restriction)", () => {
    expect(detectCatalogProvider("https://trakt.tv.evil.com/discover/trending?mode=movie")).toBeNull()
    expect(detectCatalogProvider("https://app.trakt.tv.evil.com/discover/trending?mode=movie")).toBeNull()
  })
})

describe("detectCatalogProvider: Trakt smart-list web view (opaque)", () => {
  it("routes the supplied smart link to trakt (explicit unsupported at fetch, never MDBList)", () => {
    const res = detectCatalogProvider(SMART_URL)
    expect(res).not.toBeNull()
    expect(res?.provider).toBe("trakt")
  })

  it("rejects lookalike hosts for smart view", () => {
    expect(
      detectCatalogProvider("https://app.trakt.tv.evil.com/lists/smart/view/films-5b36850652cd19c0?mode=movie"),
    ).toBeNull()
  })
})

describe("fetchUnifiedCatalogResult: Trakt trending via official API", () => {
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
          trendingItem("tt0371746", 1726, "Iron Man", 2008, 42),
          trendingItem("tt0800080", 1724, "Hulk", 2008, 41),
        ],
      })
    }) as unknown as typeof fetch

    const result = await fetchUnifiedCatalogResult(TRENDING_URL)
    expect(result.status).toBe("ok")
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({ imdb: "tt0371746", tmdb: 1726, title: "Iron Man", year: 2008, mediatype: "movie" })
    expect(result.items[1]).toMatchObject({ imdb: "tt0800080", tmdb: 1724, title: "Hulk", mediatype: "movie" })
    expect(seenUrls[0]).toContain("api.trakt.tv/movies/trending")
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
          trendingItem("tt0371746", 1726, "Iron Man", 2008),
          { watchers: 5, movie: { title: "No Ids", year: 2030, ids: { trakt: 9, slug: "x", imdb: null, tmdb: null } } },
          { error: "upstream hiccup" },
          trendingItem(null, 9999, "Tmdb Only", 2029),
        ],
      })
    ) as unknown as typeof fetch

    const items = await fetchUnifiedCatalogItems(TRENDING_URL)
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
          ? Array.from({ length: 100 }, (_, i) => trendingItem(null, page * 1000 + i, `M${page * 1000 + i}`, 2030))
          : []
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "X-Pagination-Page-Count": "10" }),
        json: async () => payload,
      })
    }) as unknown as typeof fetch

    const result = await fetchUnifiedCatalogResult(TRENDING_URL, { limit: 150 })
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
      if (u.includes("/movies/trending")) {
        if (u.includes("page=2")) {
          page2++
          const sig = init?.signal as AbortSignal | undefined
          queueMicrotask(() => ctrl.abort())
          await new Promise<void>((_res, rej) => {
            sig?.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")), { once: true })
          })
          throw new DOMException("Aborted", "AbortError")
        }
        return Response.json(Array.from({ length: 100 }, (_, i) => trendingItem(null, 5000 + i, `A${i}`, 2030)))
      }
      return Response.json({}, { status: 404 })
    })

    const first = await fetchUnifiedCatalogResult(TRENDING_URL, { signal: ctrl.signal })
    expect(first.status).toBe("ok")
    expect(first.items).toHaveLength(100)
    expect(first.incomplete).toBe(true)
    expect(page2).toBe(1)

    // Incomplete is never long-cached: the healthy retry refetches.
    vi.restoreAllMocks()
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
      const u = String(input)
      if (u.includes("/movies/trending")) {
        if (u.includes("page=2")) return Response.json([trendingItem(null, 6000, "B", 2031)])
        return Response.json(Array.from({ length: 100 }, (_, i) => trendingItem(null, 5000 + i, `A${i}`, 2030)))
      }
      return Response.json({}, { status: 404 })
    })
    const second = await fetchUnifiedCatalogResult(TRENDING_URL)
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

    const result = await fetchUnifiedCatalogResult(TRENDING_URL)
    expect(result.items).toEqual([])
    expect(result.status).toBe("unavailable")
  })

  it("maps key_missing/private/not_found/rate_limited distinctly", async () => {
    // key_missing: never hits the network.
    delete process.env.PICTORIUM_TRAKT_CLIENT_ID
    global.fetch = vi.fn(() => Promise.reject(new Error("must not fetch"))) as unknown as typeof fetch
    expect((await fetchUnifiedCatalogResult(TRENDING_URL)).status).toBe("key_missing")
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
      expect((await fetchUnifiedCatalogResult(`${TRENDING_URL}&t=${status}`)).status).toBe(expected)
    }
  })

  it("rejects unsupported trending modes without network access", async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error("must not fetch"))) as unknown as typeof fetch
    const result = await fetchUnifiedCatalogResult("https://app.trakt.tv/discover/trending?mode=shows")
    expect(result.items).toEqual([])
    expect(result.status).toBe("unsupported")
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe("fetchUnifiedCatalogResult: Trakt smart-list web view is opaque", () => {
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

  it("returns unsupported without network access and never calls /lists/{id}", async () => {
    const seenUrls: string[] = []
    global.fetch = vi.fn().mockImplementation((url: string) => {
      seenUrls.push(String(url))
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => [] })
    }) as unknown as typeof fetch

    const result = await fetchUnifiedCatalogResult(SMART_URL)
    expect(result.items).toEqual([])
    expect(result.status).toBe("unsupported")
    expect(global.fetch).not.toHaveBeenCalled()
    expect(seenUrls.join("\n")).not.toContain("films-5b36850652cd19c0")
  })
})
