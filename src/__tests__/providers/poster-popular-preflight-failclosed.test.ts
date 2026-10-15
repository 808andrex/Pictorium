// Poster popular/trending preflight must fail closed on upstream errors.
//
// Regression for the correction-cycle-2 audit: the JW preflight branch in
// src/app/api/poster/[type]/[id]/route.ts shared one outer
// `.catch(() => mapping?.badgeRank ?? mapping?.trendRank ?? null)` for both
// the legacy charts fetch and the new popular/trending fetch. A popular (or
// trending) upstream failure therefore resurrected a stored mapping rank from
// a different source, violating the no-fallback contract. The fix scopes the
// mapping fallback to the legacy charts path only; popular/trending resolve
// null on error. The charts fallback and the explicit `?rank=` override are
// pinned here as preserved contracts.
import sharp from "sharp"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { GET } from "@/app/api/poster/[type]/[id]/route"
import { getById } from "@/lib/store"
import { getServerDefaults } from "@/lib/server-defaults"
import { getDetails, getImages, getExternalIds } from "@/lib/tmdb"
import { getJWRankings } from "@/lib/justwatch"
import { fetchTop20Ranking } from "@/lib/top20-ranking"
import { cacheClear } from "@/lib/cache"
import { __resetImageBytesForTest } from "@/lib/image-bytes-cache"
import { __resetTMDBSessionCache } from "@/lib/tmdb-session-cache"
import { fetchAggregatedRating } from "@/lib/ratings"

vi.mock("@/lib/custom-rating", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/custom-rating")>()),
  fetchCustomRatings: vi.fn(async () => []),
}))

vi.mock("@/lib/multi-rating-renderer", () => ({ renderMultiRatings: vi.fn(async () => null) }))

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ ok: true, retAfter: 0 })),
  rateLimitKey: vi.fn(() => "test"),
  rateLimitResponse: vi.fn(() => new Response("rate limited", { status: 429 })),
}))

vi.mock("@/lib/store", () => ({
  getAll: vi.fn(async () => []),
  getById: vi.fn(),
  upsert: vi.fn(),
  getImdbAlias: vi.fn(async () => null),
}))

vi.mock("@/lib/server-defaults", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/server-defaults")>()
  const mocked = vi.fn(() => ({}))
  return {
    ...mod,
    getServerDefaults: mocked,
    getServerDefaultsChecked: vi.fn(async () => mocked()),
    getServerDefaultsForUser: vi.fn(async () => mocked()),
  }
})

vi.mock("@/lib/poster-auto-fit", () => ({
  selectBestLogoFitPosterPath: vi.fn(async () => ({ posterPath: "/best-fit.jpg" })),
}))

vi.mock("@/lib/svg-badge", () => ({
  renderGenreBadge: vi.fn(async () => null),
  renderRankingBadge: vi.fn(async () => null),
  renderExtraBadge: vi.fn(async () => null),
  renderQualityBadge: vi.fn(async () => null),
}))

vi.mock("@/lib/justwatch", () => ({
  getJWRankings: vi.fn(async () => []),
  getJWTitleQuality: vi.fn(async () => null),
  // Task D freshness readers: fail-closed null in route tests (legacy TTL path).
  jwRankingsRemainingMs: vi.fn(() => null),
  jwTitlesRemainingMs: vi.fn(() => null),
  jwAvailabilityRemainingMs: vi.fn(() => null),
  JW_DIGITAL_MONETIZATION_TYPES: ["FLATRATE", "FREE", "BUY", "RENT", "ADS"],
}))

vi.mock("@/lib/top20-ranking", () => ({
  fetchTop20Ranking: vi.fn(async () => ({ status: "empty", items: [], period: "popular" })),
}))

vi.mock("@/lib/stream-quality", () => ({
  resolveStreamQuality: vi.fn(async () => null),
}))

vi.mock("@/lib/awards", () => ({
  fetchAllWikidata: vi.fn(async () => ({ awards: [], nominations: [], studios: [], director: null })),
  getAwardBadgeLabel: vi.fn(),
  getNominationBadgeLabel: vi.fn(),
  matchTMDBStudios: vi.fn(() => []),
  matchDirectorName: vi.fn((name: string | null) => name),
  directorBadgeLabel: vi.fn((name: string | null) => name),
  isValidWikidataQid: (v: unknown): v is string => typeof v === "string" && /^Q\d+$/.test(v),
}))

vi.mock("@/lib/mdblist", () => ({
  fetchMDBList: vi.fn(async () => []),
  // Task D freshness reader: fail-closed null in route tests (legacy TTL path).
  mdblistRemainingMs: vi.fn(() => null),
}))

vi.mock("@/lib/ratings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ratings")>()
  return {
    ...actual,
    fetchAggregatedRating: vi.fn(async () => null),
  }
})

vi.mock("@/lib/tmdb", () => ({
  getDetails: vi.fn(),
  getDetailsWithExternalIds: vi.fn(async () => ({ id: 0, title: "", genres: [], external_ids: { imdb_id: null } })),
  getImages: vi.fn(),
  getExternalIds: vi.fn(async () => ({ imdb_id: null })),
  getKeywords: vi.fn(async () => []),
  resolveRequestApiKey: vi.fn(() => undefined),
  resolveUserApiKeys: vi.fn(async () => {
    const none = { key: undefined, source: "none" } as const
    return { tmdb: none, mdblist: none, tvdb: none }
  }),
}))

vi.mock("@/lib/imdb-resolver", () => ({
  resolveImdbToTmdb: vi.fn(async () => null),
}))

const mockedGetById = vi.mocked(getById)
const mockedDefaults = vi.mocked(getServerDefaults)
const mockedGetJWRankings = vi.mocked(getJWRankings)
const mockedFetchTop20 = vi.mocked(fetchTop20Ranking)
const mockedGetDetails = vi.mocked(getDetails)
const mockedGetImages = vi.mocked(getImages)
const mockedGetExternalIds = vi.mocked(getExternalIds)

async function imageBuffer(): Promise<Buffer> {
  return sharp({ create: { width: 500, height: 750, channels: 4, background: "#101010" } })
    .png()
    .toBuffer()
}

function savedMapping(tmdbId: number) {
  return {
    tmdbId,
    mediaType: "movie",
    title: `Saved ${tmdbId}`,
    posterPath: "/saved-choice.jpg",
    logoPath: null,
    originalPosterPath: null,
    language: "it",
    showBadges: true,
    rankingBadges: true,
    badgeRank: 7,
    badgeLabel: "Film",
    trendRank: 7,
    updatedAt: "2026-07-16T10:15:30.000Z",
  } as never
}

describe("GET /api/poster popular/trending preflight fail-closed", () => {
  beforeEach(() => {
    __resetImageBytesForTest()
    cacheClear()
    __resetTMDBSessionCache()
    mockedGetById.mockReset()
    mockedDefaults.mockReset()
    mockedDefaults.mockReturnValue({})
    mockedGetJWRankings.mockReset().mockResolvedValue([])
    mockedFetchTop20.mockReset().mockResolvedValue({ status: "empty", items: [], period: "popular" })
    mockedGetDetails.mockReset().mockResolvedValue({
      id: 0,
      title: "Saved",
      genres: [{ id: 18, name: "Drama" }],
      vote_average: 7,
      vote_count: 10,
      original_language: "en",
      release_date: "2024-01-15",
      networks: [],
      production_companies: [],
    } as never)
    mockedGetImages.mockReset().mockResolvedValue({ id: 0, posters: [], logos: [], backdrops: [] } as never)
    mockedGetExternalIds.mockReset().mockResolvedValue({ imdb_id: null })
    vi.mocked(fetchAggregatedRating).mockReset().mockResolvedValue(null)
    vi.stubEnv("PICTORIUM_CUSTOM_RATING_ENABLED", "false")
  })

  afterEach(() => {
    cacheClear()
    __resetTMDBSessionCache()
  })

  it("resolves null (no stored-rank fallback) when the popular fetch fails", async () => {
    const poster = await imageBuffer()
    mockedGetById.mockResolvedValue(savedMapping(77101))
    mockedDefaults.mockReturnValue({ region: "IT", rankingSourceMovie: "jw:popular" })
    mockedFetchTop20.mockRejectedValueOnce(new Error("JW POPULAR down"))
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array(poster), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": String(poster.length) },
        }),
    )

    const res = await GET(new NextRequest("http://localhost:3000/api/poster/movie/77101?debug=1"), {
      params: Promise.resolve({ type: "movie", id: "77101" }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    // Fail-closed: an upstream popular error must not resurrect the stored
    // rank 7 from another source.
    expect(body.rankings.justwatch).toBeNull()
    expect(body.rankings.finalRank).toBeNull()
  })

  it("resolves null (no stored-rank fallback) when the trending fetch fails", async () => {
    const poster = await imageBuffer()
    mockedGetById.mockResolvedValue(savedMapping(77102))
    mockedDefaults.mockReturnValue({ region: "IT", rankingSourceSeries: "jw:trending" })
    mockedFetchTop20.mockRejectedValueOnce(new Error("JW TRENDING down"))
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array(poster), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": String(poster.length) },
        }),
    )

    const res = await GET(new NextRequest("http://localhost:3000/api/poster/series/77102?debug=1"), {
      params: Promise.resolve({ type: "series", id: "77102" }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rankings.justwatch).toBeNull()
    expect(body.rankings.finalRank).toBeNull()
  })

  it("keeps the legacy charts fallback to the saved rank on fetch failure", async () => {
    const poster = await imageBuffer()
    mockedGetById.mockResolvedValue(savedMapping(77103))
    mockedDefaults.mockReturnValue({ region: "IT" })
    mockedGetJWRankings.mockRejectedValueOnce(new Error("JW down"))
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array(poster), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": String(poster.length) },
        }),
    )

    const res = await GET(new NextRequest("http://localhost:3000/api/poster/movie/77103?debug=1"), {
      params: Promise.resolve({ type: "movie", id: "77103" }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    // Preserved charts contract (see poster-route-mapping.test.ts): outage →
    // degraded with the saved rank.
    expect(body.rankings.finalRank).toBe(7)
  })

  it("keeps the explicit ?rank= override on popular upstream failure", async () => {
    const poster = await imageBuffer()
    mockedGetById.mockResolvedValue(savedMapping(77104))
    mockedDefaults.mockReturnValue({ region: "IT", rankingSourceMovie: "jw:popular" })
    mockedFetchTop20.mockRejectedValueOnce(new Error("JW POPULAR down"))
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array(poster), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": String(poster.length) },
        }),
    )

    const res = await GET(new NextRequest("http://localhost:3000/api/poster/movie/77104?debug=1&rank=4"), {
      params: Promise.resolve({ type: "movie", id: "77104" }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rankings.finalRank).toBe(4)
    expect(body.rankings.qRank).toBe("4")
  })
})
