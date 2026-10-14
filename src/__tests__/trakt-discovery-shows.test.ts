import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  detectCatalogProvider,
  fetchUnifiedCatalogItems,
  fetchUnifiedCatalogResult,
} from "@/lib/custom-catalog-providers"
import { cacheInvalidate } from "@/lib/cache"

const CLIENT_ID = "test-trakt-discovery-shows-client-id"

const SHOW_URLS = {
  trending: "https://app.trakt.tv/discover/trending?mode=show",
  anticipated: "https://app.trakt.tv/discover/anticipated?mode=show",
  popular: "https://app.trakt.tv/discover/popular?mode=show",
} as const

const SHOW_ENDPOINTS = {
  trending: "api.trakt.tv/shows/trending",
  anticipated: "api.trakt.tv/shows/anticipated",
  popular: "api.trakt.tv/shows/popular",
} as const

function showIds(imdb: string | null, tmdb: number | null, tvdb: number | null = null) {
  return { trakt: 2000 + (tmdb ?? tvdb ?? 0), slug: "y", imdb, tmdb, tvdb }
}

// Official shapes mirror the movie variants with the `show` key:
// trending [{ watchers, show }], anticipated [{ list_count, show }],
// popular bare [{ title, year, ids }].
function trendingShow(imdb: string | null, tmdb: number | null, title: string, year: number, tvdb: number | null = null, watchers = 7) {
  return { watchers, show: { title, year, ids: showIds(imdb, tmdb, tvdb) } }
}

function anticipatedShow(imdb: string | null, tmdb: number | null, title: string, year: number, tvdb: number | null = null, listCount = 7) {
  return { list_count: listCount, show: { title, year, ids: showIds(imdb, tmdb, tvdb) } }
}

function popularShow(imdb: string | null, tmdb: number | null, title: string, year: number, tvdb: number | null = null) {
  return { title, year, ids: showIds(imdb, tmdb, tvdb) }
}

const PAYLOADS = {
  trending: () => [
    trendingShow("tt0903747", 1396, "Breaking Bad", 2008, 81189, 42),
    trendingShow("tt0944947", 1399, "Game of Thrones", 2011, 121361, 41),
  ],
  anticipated: () => [
    anticipatedShow("tt0903747", 1396, "Breaking Bad", 2008, 81189, 42),
    anticipatedShow("tt0944947", 1399, "Game of Thrones", 2011, 121361, 41),
  ],
  popular: () => [
    popularShow("tt0903747", 1396, "Breaking Bad", 2008, 81189),
    popularShow("tt0944947", 1399, "Game of Thrones", 2011, 121361),
  ],
} as const

describe.each([
  ["trending", "Trakt Trending Shows"],
  ["anticipated", "Trakt Anticipated Shows"],
  ["popular", "Trakt Popular Shows"],
] as const)("detectCatalogProvider: Trakt %s (serie)", (kind, name) => {
  it(`detects app.trakt.tv/discover/${kind}?mode=show as trakt/series`, () => {
    const res = detectCatalogProvider(SHOW_URLS[kind])
    expect(res).not.toBeNull()
    expect(res?.provider).toBe("trakt")
    expect(res?.nameSuggestion).toBe(name)
    expect(res?.defaultType).toBe("series")
  })

  it("accepts the www and bare trakt.tv hosts", () => {
    for (const url of [
      `https://www.trakt.tv/discover/${kind}?mode=show`,
      `https://trakt.tv/discover/${kind}?mode=show`,
    ]) {
      const res = detectCatalogProvider(url)
      expect(res?.provider).toBe("trakt")
      expect(res?.defaultType).toBe("series")
    }
  })

  it("keeps the movie detect for mode=movie", () => {
    const res = detectCatalogProvider(`https://app.trakt.tv/discover/${kind}?mode=movie`)
    expect(res?.provider).toBe("trakt")
    expect(res?.defaultType).toBe("movie")
  })

  it("rejects lookalike hosts (exact host restriction)", () => {
    expect(detectCatalogProvider(`https://trakt.tv.evil.com/discover/${kind}?mode=show`)).toBeNull()
    expect(detectCatalogProvider(`https://app.trakt.tv.evil.com/discover/${kind}?mode=show`)).toBeNull()
  })
})

describe.each(["trending", "anticipated", "popular"] as const)(
  "fetchUnifiedCatalogResult: Trakt %s shows via official API",
  (kind) => {
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

    it("yields resolvable tv items in API order (never bare Trakt ids)", async () => {
      const seenUrls: string[] = []
      let seenKey = ""
      global.fetch = vi.fn().mockImplementation((url: string, opts?: { headers?: Record<string, string> }) => {
        seenUrls.push(String(url))
        seenKey = String(opts?.headers?.["trakt-api-key"] || "")
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => PAYLOADS[kind](),
        })
      }) as unknown as typeof fetch

      const result = await fetchUnifiedCatalogResult(SHOW_URLS[kind])
      expect(result.status).toBe("ok")
      expect(result.items).toHaveLength(2)
      expect(result.items[0]).toMatchObject({
        imdb: "tt0903747",
        tmdb: 1396,
        title: "Breaking Bad",
        year: 2008,
        mediatype: "tv",
      })
      expect(result.items[1]).toMatchObject({
        imdb: "tt0944947",
        tmdb: 1399,
        title: "Game of Thrones",
        mediatype: "tv",
      })
      expect(seenUrls[0]).toContain(SHOW_ENDPOINTS[kind])
      expect(seenUrls[0]).toContain("limit=100")
      expect(seenKey).toBe(CLIENT_ID)
    })

    it("keeps the show TVDB id as fallback when IMDb/TMDB are missing", async () => {
      const payload =
        kind === "popular"
          ? [popularShow(null, null, "Tvdb Only", 2026, 37552)]
          : kind === "trending"
            ? [trendingShow(null, null, "Tvdb Only", 2026, 37552)]
            : [anticipatedShow(null, null, "Tvdb Only", 2026, 37552)]
      global.fetch = vi.fn().mockImplementation(() =>
        Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => payload })
      ) as unknown as typeof fetch

      const items = await fetchUnifiedCatalogItems(SHOW_URLS[kind])
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ tvdb: 37552, mediatype: "tv" })
    })

    it("skips unresolvable entries instead of emitting them", async () => {
      const badMedia = { title: "No Ids", year: 2030, ids: { trakt: 9, slug: "x", imdb: null, tmdb: null, tvdb: null } }
      const payload =
        kind === "popular"
          ? [popularShow("tt0903747", 1396, "Breaking Bad", 2008), badMedia]
          : kind === "trending"
            ? [trendingShow("tt0903747", 1396, "Breaking Bad", 2008), { watchers: 1, show: badMedia }]
            : [anticipatedShow("tt0903747", 1396, "Breaking Bad", 2008), { list_count: 1, show: badMedia }]
      global.fetch = vi.fn().mockImplementation(() =>
        Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => payload })
      ) as unknown as typeof fetch

      const items = await fetchUnifiedCatalogItems(SHOW_URLS[kind])
      expect(items).toHaveLength(1)
      expect(items[0].title).toBe("Breaking Bad")
    })

    it("rejects unsupported modes without network access", async () => {
      global.fetch = vi.fn(() => Promise.reject(new Error("must not fetch"))) as unknown as typeof fetch
      for (const url of [
        `https://app.trakt.tv/discover/${kind}`,
        `https://app.trakt.tv/discover/${kind}?mode=shows`,
        `https://app.trakt.tv/discover/${kind}?mode=series`,
        `https://app.trakt.tv/discover/${kind}?mode=all`,
        // mode=media has its own mixed support (trakt-discovery-media.test.ts).
      ]) {
        const result = await fetchUnifiedCatalogResult(url)
        expect(result.items).toEqual([])
        expect(result.status).toBe("unsupported")
      }
      expect(global.fetch).not.toHaveBeenCalled()
    })
  },
)
