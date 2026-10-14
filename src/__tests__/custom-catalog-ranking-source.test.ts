import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { GET } from "@/app/catalog/[type]/[id]/route"
import { cacheClear, cacheInvalidate } from "@/lib/cache"
import { __clearTMDBCache } from "@/lib/tmdb"
import { __clearImdbCache } from "@/lib/imdb-cache"
import { encodeConfig } from "@/lib/config-token"
import { getById } from "@/lib/store"
import { resolveRankingSource } from "@/lib/ranking-source"
import { buildStremioPosterSearchParams } from "@/lib/stremio-poster-params"
import { computeBadge } from "@/lib/badge-priority"

vi.mock("@/lib/store", () => ({
  getById: vi.fn(),
}))

vi.mock("@/lib/server-defaults", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/server-defaults")>()
  const mocked = vi.fn(() => ({}))
  return { ...mod, getServerDefaults: mocked, getServerDefaultsChecked: vi.fn(async () => mocked()) }
})

const mockedGetById = vi.mocked(getById)

interface MockItem {
  tmdb?: number
  imdb?: string
  title: string
  year?: number
  mediatype?: string
}

/**
 * Routes every outbound fetch by URL: MDBList custom list (mock host via
 * MDBLIST_API_URL), TMDB /details, /external_ids and /images. Fail-closed.
 */
function mockRouter(mdblistItems: MockItem[]): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
    const u = String(url)
    if (u.includes("/lists/custom/")) {
      return Response.json({ items: mdblistItems })
    }
    if (u.includes("/external_ids") || u.includes("/images")) {
      const m = u.match(/\/movie\/(\d+)|\/tv\/(\d+)/)
      const id = Number(m?.[1] ?? m?.[2] ?? 0)
      if (u.includes("/external_ids")) {
        return Response.json({ id, imdb_id: `tt1000${String(id).padStart(3, "0")}` })
      }
      return Response.json({ id, backdrops: [], posters: [], logos: [] })
    }
    if (/\/movie\/\d+/.test(u) || /\/tv\/\d+/.test(u)) {
      const m = u.match(/\/(?:movie|tv)\/(\d+)/)
      const id = Number(m?.[1] ?? 0)
      return Response.json({
        id,
        title: `Title ${id}`,
        name: `Title ${id}`,
        genres: [],
        vote_average: 7.5,
        vote_count: 100,
        release_date: "2024-01-01",
        first_air_date: "2024-01-01",
        backdrop_path: null,
        overview: `Overview ${id}`,
      })
    }
    return Response.json({}, { status: 404 })
  })
}

/**
 * Import token for a custom list with NO ranking-source selection: JustWatch
 * stays the effective Top 20 source (the reported bug scenario).
 */
function importTokenNoRankingSource(cid: string, type: "movie" | "series" | "mixed" = "movie"): string {
  return encodeConfig({
    globalBadges: true,
    rankingBadges: true,
    badgeStyle: "pill",
    rankingBadgeStyle: "pill",
    blurEnabled: true,
    blurIntensity: 12,
    blurFade: 45,
    blurDarkness: 55,
    gradientHeight: 50,
    networkLogo: true,
    autoRotateClean: false,
    customCatalogs: [
      { id: cid, name: `Imported ${cid}`, type, url: "https://mdblist.com/lists/u/imported-list", enabled: true },
    ],
  })
}

async function getCustomCatalog(cid: string, stType: "movie" | "series", token: string) {
  const req = new NextRequest(
    `http://localhost:3000/catalog/${stType}/pictorium-custom-${stType}-${cid}.json?api_key=test-key&config=${token}`,
  )
  const res = await GET(req, { params: Promise.resolve({ type: stType, id: `pictorium-custom-${stType}-${cid}.json` }) })
  const body = await res.json()
  return { res, body: body as { metas: Array<{ id: string; name: string; poster: string }> } }
}

function posterParams(posterUrl: string): URLSearchParams {
  return new URL(posterUrl).searchParams
}

beforeEach(() => {
  mockedGetById.mockResolvedValue(null)
  vi.stubEnv("MDBLIST_API_URL", "https://mdblist-mock.test")
})

afterEach(() => {
  vi.restoreAllMocks()
  mockedGetById.mockReset()
  cacheClear()
  cacheInvalidate("custom_catalogs")
  cacheInvalidate("mdblist")
  __clearTMDBCache()
  __clearImdbCache()
  vi.unstubAllEnvs()
})

describe("imported list must not become a ranking source (JW selected)", () => {
  it("movie: custom catalog posters carry no list-positional animerank", async () => {
    mockRouter([
      { tmdb: 9401, title: "Imported One" },
      { tmdb: 9402, title: "Imported Two" },
    ])
    const cid = "rank-import-movie"
    const { res, body } = await getCustomCatalog(cid, "movie", importTokenNoRankingSource(cid, "movie"))

    expect(res.status).toBe(200)
    expect(body.metas).toHaveLength(2)
    for (const meta of body.metas) {
      // The list position must NOT travel as an anime rank: the explicitly
      // selected source (JustWatch here) governs badges via live trendRank.
      expect(posterParams(meta.poster).get("animerank")).toBeNull()
    }
  })

  it("series: custom catalog posters carry no list-positional animerank", async () => {
    mockRouter([
      { tmdb: 9501, title: "Imported Show One" },
      { tmdb: 9502, title: "Imported Show Two" },
    ])
    const cid = "rank-import-series"
    const { res, body } = await getCustomCatalog(cid, "series", importTokenNoRankingSource(cid, "series"))

    expect(res.status).toBe(200)
    expect(body.metas).toHaveLength(2)
    for (const meta of body.metas) {
      expect(posterParams(meta.poster).get("animerank")).toBeNull()
    }
  })

  it("importing a list leaves the ranking-source selection untouched (JW default)", () => {
    const selection = {
      customCatalogs: [
        { id: "imported", name: "Imported", type: "movie", url: "https://mdblist.com/lists/u/imported-list", enabled: true },
      ],
      rankingSourceMovie: "",
      rankingSourceSeries: "",
    } as const
    expect(resolveRankingSource(selection, "movie")).toEqual({ kind: "justwatch" })
    expect(resolveRankingSource(selection, "series")).toEqual({ kind: "justwatch" })
  })

  it("explicit custom ranking selection still resolves (intentional source preserved)", () => {
    const selection = {
      customCatalogs: [
        { id: "mylist", name: "My List", type: "movie", url: "https://mdblist.com/lists/u/my-list", enabled: true },
      ],
      rankingSourceMovie: "mylist",
      rankingSourceSeries: "",
    } as const
    expect(resolveRankingSource(selection, "movie")).toEqual({ kind: "custom", customId: "mylist" })
    expect(resolveRankingSource(selection, "series")).toEqual({ kind: "justwatch" })
  })

  it("explicit ranking disable still hides the rank badge (ranking=0 respected)", () => {
    const params = buildStremioPosterSearchParams({ rankingBadges: false })
    expect(params.get("ranking")).toBe("0")
  })

  it("genuine anime rank still outranks trend rank (badge precedence untouched)", () => {
    const t = (key: string) => key
    const badge = computeBadge(
      {
        mediaType: "movie",
        upcomingRelease: null,
        isNewMovie: false,
        isNewSeries: false,
        animeRank: 4,
        trendRank: 2,
        award: null,
        nomination: null,
        studio: null,
        director: null,
        extra: null,
      },
      t,
      ["rank"],
    )
    // Precedence logic itself is unchanged: only the inappropriate injection
    // of custom-list positions into this channel is removed.
    expect(badge).toMatchObject({ type: "rank", rank: 4 })
  })
})
