import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  detectCatalogProvider,
  fetchUnifiedCatalogItems,
  fetchUnifiedCatalogResult,
} from "@/lib/custom-catalog-providers"
import { cacheInvalidate } from "@/lib/cache"

const CLIENT_ID = "test-trakt-popular-client-id"
const POPULAR_URL = "https://app.trakt.tv/discover/popular?mode=movie"

// Official GET /movies/popular shape: BARE movie records (no `watchers` /
// `list_count` wrapper) — [{ title, year, ids }].
function popularMovie(imdb: string | null, tmdb: number | null, title: string, year: number) {
  return { title, year, ids: { trakt: 1000 + (tmdb ?? 0), slug: "x", imdb, tmdb } }
}

describe("detectCatalogProvider: Trakt popular (film)", () => {
  it("detects app.trakt.tv/discover/popular?mode=movie as trakt/movie", () => {
    const res = detectCatalogProvider(POPULAR_URL)
    expect(res).not.toBeNull()
    expect(res?.provider).toBe("trakt")
    expect(res?.nameSuggestion).toBe("Trakt Popular Movies")
    expect(res?.defaultType).toBe("movie")
  })

  it("accepts the www and bare trakt.tv hosts for popular", () => {
    for (const url of [
      "https://www.trakt.tv/discover/popular?mode=movie",
      "https://trakt.tv/discover/popular?mode=movie",
    ]) {
      const res = detectCatalogProvider(url)
      expect(res?.provider).toBe("trakt")
      expect(res?.defaultType).toBe("movie")
    }
  })

  it("routes unknown/missing popular modes to trakt for an explicit unsupported status", () => {
    for (const url of [
      "https://app.trakt.tv/discover/popular",
      "https://app.trakt.tv/discover/popular?mode=shows",
      "https://app.trakt.tv/discover/popular?mode=series",
      "https://app.trakt.tv/discover/popular?mode=all",
      // mode=media has its own mixed support (trakt-discovery-media.test.ts).
    ]) {
      const res = detectCatalogProvider(url)
      expect(res?.provider).toBe("trakt")
      expect(res?.defaultType).toBe("movie")
    }
  })

  it("rejects lookalike hosts (exact host restriction)", () => {
    expect(detectCatalogProvider("https://trakt.tv.evil.com/discover/popular?mode=movie")).toBeNull()
    expect(detectCatalogProvider("https://app.trakt.tv.evil.com/discover/popular?mode=movie")).toBeNull()
  })
})

describe("fetchUnifiedCatalogResult: Trakt popular movies via official API", () => {
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

  it("yields resolvable movie items in API order from bare records (never bare Trakt ids)", async () => {
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
          popularMovie("tt0371746", 1726, "Iron Man", 2008),
          popularMovie("tt0800080", 1724, "Hulk", 2008),
        ],
      })
    }) as unknown as typeof fetch

    const result = await fetchUnifiedCatalogResult(POPULAR_URL)
    expect(result.status).toBe("ok")
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({ imdb: "tt0371746", tmdb: 1726, title: "Iron Man", year: 2008, mediatype: "movie" })
    expect(result.items[1]).toMatchObject({ imdb: "tt0800080", tmdb: 1724, title: "Hulk", mediatype: "movie" })
    expect(seenUrls[0]).toContain("api.trakt.tv/movies/popular")
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
          popularMovie("tt0371746", 1726, "Iron Man", 2008),
          { title: "No Ids", year: 2030, ids: { trakt: 9, slug: "x", imdb: null, tmdb: null } },
          { error: "upstream hiccup" },
          popularMovie(null, 9999, "Tmdb Only", 2029),
        ],
      })
    ) as unknown as typeof fetch

    const items = await fetchUnifiedCatalogItems(POPULAR_URL)
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
          ? Array.from({ length: 100 }, (_, i) => popularMovie(null, page * 1000 + i, `M${page * 1000 + i}`, 2030))
          : []
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "X-Pagination-Page-Count": "10" }),
        json: async () => payload,
      })
    }) as unknown as typeof fetch

    const result = await fetchUnifiedCatalogResult(POPULAR_URL, { limit: 150 })
    expect(result.status).toBe("ok")
    expect(result.items).toHaveLength(150)
    expect(global.fetch).toHaveBeenCalledTimes(2)
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

    const result = await fetchUnifiedCatalogResult(POPULAR_URL)
    expect(result.items).toEqual([])
    expect(result.status).toBe("unavailable")
  })

  it("maps key_missing/private/not_found/rate_limited distinctly", async () => {
    delete process.env.PICTORIUM_TRAKT_CLIENT_ID
    global.fetch = vi.fn(() => Promise.reject(new Error("must not fetch"))) as unknown as typeof fetch
    expect((await fetchUnifiedCatalogResult(POPULAR_URL)).status).toBe("key_missing")
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
      expect((await fetchUnifiedCatalogResult(`${POPULAR_URL}&t=${status}`)).status).toBe(expected)
    }
  })

  it("rejects unsupported popular modes without network access", async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error("must not fetch"))) as unknown as typeof fetch
    const result = await fetchUnifiedCatalogResult("https://app.trakt.tv/discover/popular?mode=shows")
    expect(result.items).toEqual([])
    expect(result.status).toBe("unsupported")
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
