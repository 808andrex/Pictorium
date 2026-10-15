// TASK B — MDBList new media API migration + per-source minimum-votes filter.
//
// New provider contract (verified live 2026-10-15, six authorized samples):
//   GET https://api.mdblist.com/imdb/{movie|show|any}/{imdbId}/?apikey=KEY
//   GET https://api.mdblist.com/tmdb/... (task C, NOT this task)
// Response root: { type: "movie"|"show", score: 0-100, year: number,
// released: ISO, ratings: [{ source, value, score, votes }] } where score is
// ALWAYS 0-100 (even < 10) and votes is integer|null (field name exactly
// "votes", no aliases). Keyless calls are futile (auth required): the client
// must not attempt them against the real base (mock override excepted).
//
// Env: no real network/credentials anywhere; `fetch` is stubbed per test.
// Fixtures below reuse the verified anonymous sample values (tt0111161 movie,
// show with null popcorn votes) — titles/years only, no account data.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cacheClear } from "@/lib/cache"
import * as cacheModule from "@/lib/cache"
import {
  buildMdbRatingsUrl,
  fetchAggregatedRating,
  isMdblistBreakerOpen,
  mdbMediaSegment,
  RATING_MIN_VOTES_DEFAULT,
  resolveRatingMinVotes,
  __resetMdblistBreaker,
  __resetRatingsNullForTest,
} from "@/lib/ratings"
import { __resetMdbQuotaForTests } from "@/lib/mdblist-quota"
import { computeVote } from "@/lib/rating-weights"

async function resetMdbRaw(): Promise<void> {
  const mod = (await import("@/lib/ratings")) as unknown as Record<string, unknown>
  const fn = mod.__resetMdbRawForTest
  if (typeof fn === "function") (fn as () => void)()
}

function jsonOk(body: unknown): unknown {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body }
}

// Verified 2026-10-15 anonymous sample: imdb/movie/tt0111161 (subset of the
// observed ratings[], values as returned — no account data).
const SHAWSHANK = {
  type: "movie",
  title: "The Shawshank Redemption",
  year: 1994,
  released: "1994-09-23",
  score: 89,
  ratings: [
    { source: "imdb", value: 9.3, score: 93, votes: 3251848 },
    { source: "metacritic", value: 82, score: 82, votes: 22 },
    { source: "metacriticuser", value: 9.2, score: 92, votes: 2246 },
    { source: "trakt", value: 91, score: 91, votes: 48287 },
    { source: "tomatoes", value: 89, score: 89, votes: 147 },
    { source: "popcorn", value: 98, score: 98, votes: 53483 },
    { source: "tmdb", value: 87, score: 87, votes: 31580 },
    { source: "letterboxd", value: 4.6, score: 92, votes: 3179221 },
    { source: "rogerebert", value: 3.5, score: null, votes: null },
    { source: "myanimelist", value: null, score: null, votes: null },
  ],
}

// Show sample: popcorn votes null must be kept (missing counts never filter).
const SHOW = {
  type: "show",
  title: "Sample Show",
  year: 2008,
  released: "2008-01-20",
  score: 87,
  ratings: [
    { source: "imdb", value: 9.5, score: 95, votes: 2100000 },
    { source: "popcorn", value: 85, score: 85, votes: null },
    { source: "tmdb", value: 8.9, score: 89, votes: 15000 },
  ],
}

beforeEach(async () => {
  delete process.env.MDBLIST_API_URL
  vi.unstubAllEnvs()
  cacheClear()
  __resetMdblistBreaker()
  __resetRatingsNullForTest()
  __resetMdbQuotaForTests()
  await resetMdbRaw()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  delete process.env.MDBLIST_API_URL
  cacheClear()
  __resetMdblistBreaker()
  __resetRatingsNullForTest()
  __resetMdbQuotaForTests()
  await resetMdbRaw()
  vi.restoreAllMocks()
})

describe("new media API transport (single typed IMDb endpoint, no legacy)", () => {
  it("movie → /imdb/movie/{id}/ with apikey query, no legacy params", async () => {
    const fetchMock = vi.fn(async (_url: unknown) => jsonOk(SHAWSHANK))
    vi.stubGlobal("fetch", fetchMock)
    const r = await fetchAggregatedRating("tt0111161", "k", undefined, { mediaType: "movie" })
    expect(r?.sources.imdb).toBe(9.3)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toBe("https://api.mdblist.com/imdb/movie/tt0111161/?apikey=k")
    expect(url).not.toContain("?i=")
    expect(url).not.toContain("mdblist.com/api")
  })

  it("tv/series → /imdb/show/, unspecified/anime → /imdb/any/, no wrong-type retry", async () => {
    const fetchMock = vi.fn(async (_url: unknown) => jsonOk(SHOW))
    vi.stubGlobal("fetch", fetchMock)
    await fetchAggregatedRating("tt_show1", "k", undefined, { mediaType: "tv" })
    await fetchAggregatedRating("tt_show2", "k", undefined, { mediaType: "series" })
    await fetchAggregatedRating("tt_any1", "k", undefined, {})
    await fetchAggregatedRating("tt_any2", "k", undefined, { mediaType: "anime" })
    const urls = fetchMock.mock.calls.map(([u]) => String(u))
    expect(urls[0]).toBe("https://api.mdblist.com/imdb/show/tt_show1/?apikey=k")
    expect(urls[1]).toBe("https://api.mdblist.com/imdb/show/tt_show2/?apikey=k")
    expect(urls[2]).toBe("https://api.mdblist.com/imdb/any/tt_any1/?apikey=k")
    expect(urls[3]).toBe("https://api.mdblist.com/imdb/any/tt_any2/?apikey=k")

    // Wrong-type 404: single fetch on the requested path, genuine miss, no
    // automatic retry on another type. Repeat on the same identity is served
    // from the 60s negative cache (no extra fetch); another media type is an
    // independent identity (its own upstream call).
    const notFoundMock = vi.fn(async (_url: unknown) => ({ ok: false, status: 404, headers: new Headers(), json: async () => ({ error: "Item not found" }) }))
    vi.stubGlobal("fetch", notFoundMock)
    expect(await fetchAggregatedRating("tt_wrongtype", "k", undefined, { mediaType: "movie" })).toBeNull()
    expect(notFoundMock).toHaveBeenCalledTimes(1)
    expect(String(notFoundMock.mock.calls[0][0])).toBe("https://api.mdblist.com/imdb/movie/tt_wrongtype/?apikey=k")
    // Same identity (same imdb + same segment + same policy): negative cached.
    expect(await fetchAggregatedRating("tt_wrongtype", "k", undefined, { mediaType: "movie" })).toBeNull()
    expect(notFoundMock).toHaveBeenCalledTimes(1)
    // Other media type: independent identity, its own single upstream call.
    expect(await fetchAggregatedRating("tt_wrongtype", "k", undefined, { mediaType: "tv" })).toBeNull()
    expect(notFoundMock).toHaveBeenCalledTimes(2)
    expect(String(notFoundMock.mock.calls[1][0])).toBe("https://api.mdblist.com/imdb/show/tt_wrongtype/?apikey=k")
  })

  it("mdbMediaSegment normalizes caller media types", () => {
    expect(mdbMediaSegment("movie")).toBe("movie")
    expect(mdbMediaSegment("tv")).toBe("show")
    expect(mdbMediaSegment("series")).toBe("show")
    expect(mdbMediaSegment("show")).toBe("show")
    expect(mdbMediaSegment(undefined)).toBe("any")
    expect(mdbMediaSegment(null)).toBe("any")
    expect(mdbMediaSegment("anime")).toBe("any")
    expect(mdbMediaSegment("")).toBe("any")
  })

  it("buildMdbRatingsUrl honors the MDBLIST_API_URL mock override with new paths", () => {
    expect(buildMdbRatingsUrl("tt0111161", "k", "movie")).toBe(
      "https://api.mdblist.com/imdb/movie/tt0111161/?apikey=k",
    )
    process.env.MDBLIST_API_URL = "http://mock.test/md"
    expect(buildMdbRatingsUrl("tt0111161", "k", "show")).toBe(
      "http://mock.test/md/imdb/show/tt0111161/?apikey=k",
    )
    expect(buildMdbRatingsUrl("tt0111161", undefined, "any")).toBe(
      "http://mock.test/md/imdb/any/tt0111161/",
    )
  })
})

describe("new score normalization (score always 0-100 → /10)", () => {
  it("verified sample normalizes: score/10, aliases, RogerEbert fallback, root mdblist", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonOk(SHAWSHANK)))
    const r = await fetchAggregatedRating("tt0111161", "k")
    expect(r).not.toBeNull()
    expect(r?.sources.imdb).toBe(9.3)
    expect(r?.sources.metacritic).toBe(8.2)
    expect(r?.sources.metacriticuser).toBe(9.2)
    expect(r?.sources.trakt).toBe(9.1)
    expect(r?.sources.tomatoes).toBe(8.9)
    expect(r?.sources.popcorntime).toBe(9.8)
    expect(r?.sources.tmdb).toBe(8.7)
    expect(r?.sources.letterboxd).toBe(9.2)
    // RogerEbert has null score/votes: native 0-4 value fallback (3.5*2.5=8.75→8.8).
    expect(r?.sources.rogerebert).toBe(8.8)
    // Root score 89 (0-100) → mdblist 8.9.
    expect(r?.sources.mdblist).toBe(8.9)
    // myanimelist null/null is absent, not zero.
    expect(r?.sources.mal).toBeUndefined()
    // Default average stays imdb+tmdb.
    expect(r?.average).toBe((9.3 + 8.7) / 2)
  })

  it("low score 8 → 0.8 (no >10 heuristic on score)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonOk({ type: "movie", score: 50, ratings: [{ source: "trakt", value: 8, score: 8, votes: 500 }] }),
      ),
    )
    const r = await fetchAggregatedRating("tt_lowscore", "k")
    expect(r?.sources.trakt).toBe(0.8)
  })

  it("malformed scores are unavailable (no Infinity/>100/junk partials, no value reinterpretation)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonOk({
          type: "movie",
          score: 50,
          ratings: [
            { source: "trakt", value: 91, score: Infinity, votes: 500 },
            { source: "metacritic", value: 150, score: 150, votes: 500 },
            { source: "tomatoes", value: 88, score: "88abc", votes: 500 },
            { source: "popcorn", value: 92, score: "", votes: 500 },
            { source: "tmdb", value: 8.1, score: NaN, votes: 500 },
            { source: "letterboxd", value: 4.6, score: -5, votes: 500 },
            // Missing-score non-Ebert value is unavailable even when the
            // native value looks 0-10: never reinterpret a 100-scale native
            // as x/10 (no generic toTen heuristic).
            { source: "filmweb", value: 8, votes: 500 },
            // RogerEbert: exact documented native 3.5 → 8.75 → 8.8.
            { source: "rogerebert", value: 3.5, score: null, votes: null },
            // RogerEbert out-of-range native (>4) is unavailable.
            { source: "mal", value: 8.9, score: 89, votes: 500 },
          ],
        }),
      ),
    )
    const r = await fetchAggregatedRating("tt_badscore", "k")
    expect(r?.sources.trakt).toBeUndefined() // Infinity rejected
    expect(r?.sources.metacritic).toBeUndefined() // >100 rejected
    expect(r?.sources.tomatoes).toBeUndefined() // junk partial rejected
    expect(r?.sources.popcorntime).toBeUndefined() // empty rejected
    expect(r?.sources.tmdb).toBeUndefined() // NaN rejected
    expect(r?.sources.letterboxd).toBeUndefined() // negative + no native fallback
    expect(r?.sources.filmweb).toBeUndefined() // missing score, no fallback
    expect(r?.sources.rogerebert).toBe(8.8) // 3.5 * 2.5 exact
    expect(r?.sources.mal).toBe(8.9) // control: valid score still normalizes
    expect(r?.sources.mdblist).toBe(5) // root 50 → 5.0 control
  })

  it("root and RogerEbert score precedence: valid score wins, native only when score null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonOk({
          type: "movie",
          score: Infinity,
          ratings: [
            // Score present: native ignored (75 → 7.5, not 3.0*2.5).
            { source: "rogerebert", value: 3.0, score: 75, votes: null },
            // Strict numeric string scores still normalize.
            { source: "imdb", value: 93, score: "93", votes: 100 },
          ],
        }),
      ),
    )
    const r = await fetchAggregatedRating("tt_scoreprec", "k")
    expect(r?.sources.rogerebert).toBe(7.5)
    expect(r?.sources.imdb).toBe(9.3)
    // Malformed root score: no mdblist source, never rendered.
    expect(r?.sources.mdblist).toBeUndefined()
  })
})

describe("per-source minimum-votes filter (PICTORIUM_RATING_MIN_VOTES)", () => {
  const MIXED = {
    type: "movie",
    score: 70,
    ratings: [
      { source: "imdb", value: 9, score: 90, votes: 100 },
      { source: "trakt", value: 8, score: 80, votes: 9 },
      { source: "tomatoes", value: 88, score: 88, votes: 10 },
      { source: "metacritic", value: 75, score: 75, votes: 147 },
      { source: "tmdb", value: 7, score: 70, votes: null },
      { source: "letterboxd", value: 4, score: 80, votes: undefined },
      { source: "metacriticuser", value: 7, score: 70, votes: "lots" },
      { source: "rogerebert", value: 3, score: null, votes: 2 },
      // Malformed counts are unknown → kept (strict finite non-negative
      // integer required to filter): negatives, fractions, NaN, Infinity and
      // numeric strings never filter.
      { source: "filmweb", value: 76, score: 76, votes: -1 },
      { source: "filmwebcritics", value: 80, score: 80, votes: 9.5 },
      { source: "mal", value: 89, score: 89, votes: NaN },
      { source: "anilist", value: 86, score: 86, votes: Infinity },
      { source: "kitsu", value: 82, score: 82, votes: "9" },
      // Known 0..9 boundary: 0 and 5 filter at default 10.
      { source: "popcorn", value: 92, score: 92, votes: 0 },
      { source: "simkl", value: 81, score: 81, votes: 5 },
    ],
  }

  it("default 10: below filtered; equal/above/null/missing/malformed kept; RogerEbert exempt", async () => {
    expect(RATING_MIN_VOTES_DEFAULT).toBe(10)
    vi.stubGlobal("fetch", vi.fn(async () => jsonOk(MIXED)))
    const r = await fetchAggregatedRating("tt_mv1", "k")
    expect(r?.sources.imdb).toBe(9)
    expect(r?.sources.trakt).toBeUndefined() // 9 < 10
    expect(r?.sources.tomatoes).toBe(8.8) // equal kept
    expect(r?.sources.metacritic).toBe(7.5)
    expect(r?.sources.tmdb).toBe(7) // null kept
    expect(r?.sources.letterboxd).toBe(8) // missing kept
    expect(r?.sources.metacriticuser).toBe(7) // malformed kept
    expect(r?.sources.rogerebert).toBe(7.5) // exempt despite votes 2
    // Strict-integer regression: malformed counts kept as unknown.
    expect(r?.sources.filmweb).toBe(7.6) // -1 kept
    expect(r?.sources.filmwebcritics).toBe(8) // 9.5 kept
    expect(r?.sources.mal).toBe(8.9) // NaN kept
    expect(r?.sources.anilist).toBe(8.6) // Infinity kept
    expect(r?.sources.kitsu).toBe(8.2) // '9' kept
    // Known 0..9 integers filter at default 10.
    expect(r?.sources.popcorntime).toBeUndefined() // 0 < 10
    expect(r?.sources.simkl).toBeUndefined() // 5 < 10
  })

  it("low-count removal moves the selected-sources final vote (computeVote, rules preserved)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonOk(MIXED)))
    const filtered = await fetchAggregatedRating("tt_mv_vote", "k")
    // trakt (9 votes < 10) is absent: the imdb+trakt vote is imdb alone.
    expect(filtered?.sources.trakt).toBeUndefined()
    expect(computeVote(filtered, ["imdb", "trakt"])).toBe(9)
    // Filter disabled: trakt back in, the same selection averages both.
    vi.stubEnv("PICTORIUM_RATING_MIN_VOTES", "0")
    const unfiltered = await fetchAggregatedRating("tt_mv_vote0", "k")
    expect(unfiltered?.sources.trakt).toBe(8)
    expect(computeVote(unfiltered, ["imdb", "trakt"])).toBe((9 + 8) / 2)
  })

  it("0 disables the filter; malformed env falls back to default", async () => {
    vi.stubEnv("PICTORIUM_RATING_MIN_VOTES", "0")
    vi.stubGlobal("fetch", vi.fn(async () => jsonOk(MIXED)))
    const off = await fetchAggregatedRating("tt_mv2", "k")
    expect(off?.sources.trakt).toBe(8)
    expect(off?.sources.rogerebert).toBe(7.5)

    for (const bad of ["abc", "-3", "12.5", ""]) {
      vi.stubEnv("PICTORIUM_RATING_MIN_VOTES", bad)
      expect(resolveRatingMinVotes()).toBe(10)
    }
    vi.stubEnv("PICTORIUM_RATING_MIN_VOTES", "25")
    expect(resolveRatingMinVotes()).toBe(25)
    vi.stubEnv("PICTORIUM_RATING_MIN_VOTES", "0")
    expect(resolveRatingMinVotes()).toBe(0)
  })
})

describe("cache identity: provider version + type + min-votes policy", () => {
  it("movie vs show vs policy: isolated raw and aggregated entries", async () => {
    const fetchMock = vi.fn(async () => jsonOk(SHAWSHANK))
    vi.stubGlobal("fetch", fetchMock)
    const seen: string[] = []
    const originalSet = cacheModule.cacheSet
    const spy = vi.spyOn(cacheModule, "cacheSet").mockImplementation((k: string, v: unknown, tags?: string[], ttlMs?: number) => {
      seen.push(k)
      originalSet(k, v, tags ?? [], ttlMs)
    })
    try {
      await fetchAggregatedRating("tt_iso", "k", undefined, { mediaType: "movie" })
      await fetchAggregatedRating("tt_iso", "k", undefined, { mediaType: "tv" })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const rawKeys = seen.filter((k) => k.startsWith("mdb:raw:"))
      expect(rawKeys).toHaveLength(2)
      expect(rawKeys[0]).toMatch(/^mdb:raw:v3:movie:tt_iso:[0-9a-f]{8}:mv10$/)
      expect(rawKeys[1]).toMatch(/^mdb:raw:v3:show:tt_iso:[0-9a-f]{8}:mv10$/)
      const aggKeys = seen.filter((k) => k.startsWith("mdb:ratings:"))
      expect(aggKeys).toHaveLength(2)
      for (const k of aggKeys) expect(k).toMatch(/^mdb:ratings:v3:/)
      expect(aggKeys[0]).toContain(":mdb:movie:mv10")
      expect(aggKeys[1]).toContain(":mdb:show:mv10")

      // Same identity, different policy → isolated again (no cross-policy reuse).
      vi.stubEnv("PICTORIUM_RATING_MIN_VOTES", "0")
      await fetchAggregatedRating("tt_iso", "k", undefined, { mediaType: "movie" })
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(seen.filter((k) => k.startsWith("mdb:raw:")).pop()).toMatch(/:mv0$/)
    } finally {
      spy.mockRestore()
    }
  })
})

describe("auth semantics: no futile keyless upstream, 401 transient", () => {
  it("keyless against the real base: zero MDBList network (no-live-no-key)", async () => {
    const fetchMock = vi.fn(async () => jsonOk(SHAWSHANK))
    vi.stubGlobal("fetch", fetchMock)
    expect(await fetchAggregatedRating("tt_nokey")).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("keyless against the mock override: deterministic new path still served", async () => {
    process.env.MDBLIST_API_URL = "http://mock.test/md"
    const fetchMock = vi.fn(async (_url: unknown) => jsonOk(SHAWSHANK))
    vi.stubGlobal("fetch", fetchMock)
    const r = await fetchAggregatedRating("tt_mockkey")
    expect(r?.sources.imdb).toBe(9.3)
    expect(String(fetchMock.mock.calls[0][0]).startsWith("http://mock.test/md/imdb/any/tt_mockkey/")).toBe(true)
  })

  it("401 is transient: no negative cache, breaker stays closed", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401, headers: new Headers(), json: async () => ({}) }))
    vi.stubGlobal("fetch", fetchMock)
    expect(await fetchAggregatedRating("tt_401a", "k")).toBeNull()
    expect(await fetchAggregatedRating("tt_401a", "k")).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(isMdblistBreakerOpen()).toBe(false)
  })
})
