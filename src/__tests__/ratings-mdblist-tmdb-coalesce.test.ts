// Task C correction-1 — simultaneous known-pair coalescing + strict id validation.
//
// A caller-known IMDb+TMDB pair (same call: imdbId + tmdbId with explicit
// type) and a TMDB-only lookup for the same typed id must share ONE upstream
// fetch when concurrent, in EITHER arrival order: the first arrival owns the
// transport (IMDb-first when the first caller has IMDb, TMDB otherwise) and
// the joiner reuses the owned inflight — never a second call, never extra
// alias resolution or network. Sequential semantics are unchanged: unknown
// aliases stay separate, conflicting evidence publishes no alias, film/show
// and key/policy isolation hold, and one caller's abort never kills the other.
//
// Id validation: TMDB ids must be safe integers on BOTH branches (an unsafe
// 2^53 number previously rounded through); IMDb ids reject whitespace and
// query/fragment junk. Either invalid input costs zero MDBList requests.
//
// Env: no real network/credentials; `fetch` is stubbed per test. Concurrent
// pairs are started back-to-back (synchronous prefixes register/join the
// owned inflight before any microtask runs) with the upstream gated, exactly
// like the same-identity coalescing tests in ratings-mdblist-raw.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cacheClear } from "@/lib/cache"
import {
  fetchAggregatedRating,
  isValidImdbId,
  parseTmdbId,
  __resetMdblistBreaker,
  __resetRatingsNullForTest,
} from "@/lib/ratings"
import { __resetMdbQuotaForTests } from "@/lib/mdblist-quota"

async function resetMdbRaw(): Promise<void> {
  const mod = (await import("@/lib/ratings")) as unknown as Record<string, unknown>
  const fn = mod.__resetMdbRawForTest
  if (typeof fn === "function") (fn as () => void)()
}

function jsonOk(body: unknown): unknown {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body }
}

function notFound(): unknown {
  return { ok: false, status: 404, headers: new Headers(), json: async () => ({ error: "Item not found" }) }
}

function mdblistCalls(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("mdblist.com"))
}

// Same shape as the verified anonymous samples in ratings-mdblist-tmdb.test.ts
// (titles/years only, no account data). No imdb_id/tmdb_id fields: the pair
// is caller-known, never response-observed here.
const MOVIE = {
  type: "movie",
  title: "The Shawshank Redemption",
  year: 1994,
  released: "1994-09-23",
  score: 89,
  ratings: [
    { source: "imdb", value: 9.3, score: 93, votes: 3251848 },
    { source: "tmdb", value: 8.7, score: 87, votes: 31580 },
  ],
}

const SHOW = {
  type: "show",
  title: "Sample Show",
  year: 2008,
  released: "2008-01-20",
  score: 87,
  ratings: [
    { source: "imdb", value: 9.5, score: 95, votes: 2100000 },
    { source: "tmdb", value: 8.9, score: 89, votes: 15000 },
  ],
}

beforeEach(async () => {
  cacheClear()
  __resetMdblistBreaker()
  __resetRatingsNullForTest()
  __resetMdbQuotaForTests()
  await resetMdbRaw()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  delete process.env.MDBLIST_API_URL
  cacheClear()
  __resetMdblistBreaker()
  __resetRatingsNullForTest()
  __resetMdbQuotaForTests()
  await resetMdbRaw()
  vi.restoreAllMocks()
})

describe("strict id validation: unsafe numerics and junk IMDb cost zero fetches", () => {
  it("parseTmdbId requires safe integers on both branches", () => {
    expect(parseTmdbId(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
    expect(parseTmdbId("9007199254740991")).toBe(9007199254740991)
    // 2^53 rounds to itself as a double but is not a safe integer.
    expect(parseTmdbId(2 ** 53)).toBeNull()
    expect(parseTmdbId(9007199254740993)).toBeNull()
    expect(parseTmdbId("9007199254740993")).toBeNull()
    expect(parseTmdbId("9007199254740992")).toBeNull()
  })

  it("unsafe TMDB ids (number and string) reach no MDBList upstream", async () => {
    const fetchMock = vi.fn(async (_url: unknown) => jsonOk(MOVIE))
    vi.stubGlobal("fetch", fetchMock)
    expect(await fetchAggregatedRating(null, "k", undefined, { tmdbId: 2 ** 53, mediaType: "movie" })).toBeNull()
    expect(
      await fetchAggregatedRating(null, "k", undefined, { tmdbId: "9007199254740993", mediaType: "movie" }),
    ).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("isValidImdbId rejects whitespace/query junk, keeps existing fixture ids", () => {
    // Fixture-style ids used across the suite stay valid (no mass migration).
    for (const ok of ["tt0111161", "tt_show1", "TT1234567", "tt_wrongtype", "tt_c1", "tt_u1", "tt_raw_share"]) {
      expect(isValidImdbId(ok)).toBe(true)
    }
    for (const bad of [
      "tt 0111161",
      "tt0111161 ",
      " tt0111161",
      "tt0111161?apikey=x",
      "tt0111161#frag",
      "tt0111161/extra",
      "tt0111161&x=1",
      "tt0111161\\x",
    ]) {
      expect(isValidImdbId(bad)).toBe(false)
    }
  })

  it("junk IMDb ids reach no MDBList upstream", async () => {
    const fetchMock = vi.fn(async (_url: unknown) => jsonOk(MOVIE))
    vi.stubGlobal("fetch", fetchMock)
    expect(await fetchAggregatedRating("tt0111161?apikey=x", "k", undefined, { mediaType: "movie" })).toBeNull()
    expect(await fetchAggregatedRating("tt 0111161", "k", undefined, { mediaType: "movie" })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("simultaneous known pair: one fetch in either arrival order (movie)", () => {
  it("IMDb-first: single /imdb/ fetch shared with the TMDB-only caller", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchMock = vi.fn(async (_url: unknown) => {
      await gate
      return jsonOk(MOVIE)
    })
    vi.stubGlobal("fetch", fetchMock)
    const p1 = fetchAggregatedRating("tt0111161", "k", undefined, { tmdbId: 278, mediaType: "movie" })
    const p2 = fetchAggregatedRating(null, "k", undefined, { tmdbId: 278, mediaType: "movie" })
    release()
    const [a, b] = await Promise.all([p1, p2])
    const urls = mdblistCalls(fetchMock)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toBe("https://api.mdblist.com/imdb/movie/tt0111161/?apikey=k")
    expect(a?.sources.imdb).toBe(9.3)
    expect(b?.sources).toEqual(a?.sources)
  })

  it("TMDB-first: single /tmdb/ fetch shared with the IMDb+pair caller", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchMock = vi.fn(async (_url: unknown) => {
      await gate
      return jsonOk(MOVIE)
    })
    vi.stubGlobal("fetch", fetchMock)
    const p1 = fetchAggregatedRating(null, "k", undefined, { tmdbId: 278, mediaType: "movie" })
    const p2 = fetchAggregatedRating("tt0111161", "k", undefined, { tmdbId: 278, mediaType: "movie" })
    release()
    const [a, b] = await Promise.all([p1, p2])
    const urls = mdblistCalls(fetchMock)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toBe("https://api.mdblist.com/tmdb/movie/278/?apikey=k")
    expect(a?.sources.imdb).toBe(9.3)
    expect(b?.sources).toEqual(a?.sources)
  })
})

describe("simultaneous known pair: one fetch in either arrival order (show)", () => {
  it("IMDb-first show: single /imdb/ fetch shared with the TMDB-only caller", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchMock = vi.fn(async (url: unknown) => {
      await gate
      expect(String(url)).toContain("/imdb/show/tt_showpair/")
      return jsonOk(SHOW)
    })
    vi.stubGlobal("fetch", fetchMock)
    const p1 = fetchAggregatedRating("tt_showpair", "k", undefined, { tmdbId: 1399, mediaType: "tv" })
    const p2 = fetchAggregatedRating(null, "k", undefined, { tmdbId: 1399, mediaType: "tv" })
    release()
    const [a, b] = await Promise.all([p1, p2])
    expect(mdblistCalls(fetchMock)).toHaveLength(1)
    expect(a?.sources.imdb).toBe(9.5)
    expect(b?.sources).toEqual(a?.sources)
  })

  it("TMDB-first show: single /tmdb/show/ fetch shared with the IMDb+pair caller", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchMock = vi.fn(async (url: unknown) => {
      await gate
      expect(String(url)).toContain("/tmdb/show/1399/")
      return jsonOk(SHOW)
    })
    vi.stubGlobal("fetch", fetchMock)
    const p1 = fetchAggregatedRating(null, "k", undefined, { tmdbId: 1399, mediaType: "tv" })
    const p2 = fetchAggregatedRating("tt_showpair", "k", undefined, { tmdbId: 1399, mediaType: "tv" })
    release()
    const [a, b] = await Promise.all([p1, p2])
    expect(mdblistCalls(fetchMock)).toHaveLength(1)
    expect(a?.sources.imdb).toBe(9.5)
    expect(b?.sources).toEqual(a?.sources)
  })
})

describe("known-pair isolation: type and key stay separate", () => {
  it("film278 vs show278 stay separate entries (own upstream each)", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchMock = vi.fn(async (url: unknown) => {
      await gate
      return String(url).includes("/show/") ? jsonOk(SHOW) : jsonOk(MOVIE)
    })
    vi.stubGlobal("fetch", fetchMock)
    const p1 = fetchAggregatedRating("tt0111161", "k", undefined, { tmdbId: 278, mediaType: "movie" })
    const p2 = fetchAggregatedRating(null, "k", undefined, { tmdbId: 278, mediaType: "tv" })
    release()
    const [a, b] = await Promise.all([p1, p2])
    expect(mdblistCalls(fetchMock)).toHaveLength(2)
    expect(a?.sources.imdb).toBe(9.3)
    expect(b?.sources.imdb).toBe(9.5)
  })

  it("different api keys stay isolated (same pair, own upstream each)", async () => {
    const fetchMock = vi.fn(async (_url: unknown) => jsonOk(MOVIE))
    vi.stubGlobal("fetch", fetchMock)
    await fetchAggregatedRating("tt0111161", "keyA", undefined, { tmdbId: 278, mediaType: "movie" })
    await fetchAggregatedRating(null, "keyB", undefined, { tmdbId: 278, mediaType: "movie" })
    expect(mdblistCalls(fetchMock)).toHaveLength(2)
  })
})

describe("conflicting pair publishes no unsafe alias", () => {
  it("simultaneous conflict joins once, but the counterpart stays unaliased after", async () => {
    const conflict = {
      type: "movie",
      title: "Conflict",
      year: 2020,
      released: "2020-01-01",
      score: 80,
      tmdb_id: 999,
      ratings: [{ source: "imdb", value: 8.1, score: 81, votes: 5000 }],
    }
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url)
      if (u.includes("/imdb/movie/tt_c9/")) {
        await gate
        return jsonOk(conflict)
      }
      if (u.includes("/tmdb/movie/278/")) return jsonOk(MOVIE)
      return notFound()
    })
    vi.stubGlobal("fetch", fetchMock)
    // Simultaneous conflicting claims: the shared IMDb response refutes the
    // TMDB-only joiner's pair (observed 999 vs claimed 278), so the joiner
    // consumes nothing, publishes nothing, and refetches its own genuine
    // entry on the TMDB transport (two fetches, no malignant alias anywhere).
    const p1 = fetchAggregatedRating("tt_c9", "k", undefined, { tmdbId: 278, mediaType: "movie" })
    const p2 = fetchAggregatedRating(null, "k", undefined, { tmdbId: 278, mediaType: "movie" })
    release()
    const [a, b] = await Promise.all([p1, p2])
    expect(mdblistCalls(fetchMock)).toHaveLength(2)
    expect(a?.sources.imdb).toBe(8.1)
    expect(b?.sources.imdb).toBe(9.3)
    // The observed contradiction (caller 278 vs response 999) publishes no
    // alias: the TMDB-only lookup refetches its own genuine entry.
    const c = await fetchAggregatedRating(null, "k", undefined, { tmdbId: 278, mediaType: "movie" })
    expect(mdblistCalls(fetchMock)).toHaveLength(2)
    expect(c?.sources.imdb).toBe(9.3)
    // The conflicted IMDb identity keeps its own genuine entry (no extra fetch).
    const d = await fetchAggregatedRating("tt_c9", "k", undefined, { tmdbId: 278, mediaType: "movie" })
    expect(mdblistCalls(fetchMock)).toHaveLength(2)
    expect(d?.sources.imdb).toBe(8.1)
  })
})

describe("pair abort survival: one abort leaves the other on a single fetch", () => {
  it("aborted IMDb+pair caller resolves null, TMDB-only survivor completes", async () => {
    const fetchMock = vi.fn(async (_url: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return jsonOk(MOVIE)
    })
    vi.stubGlobal("fetch", fetchMock)
    const ctrl = new AbortController()
    const p1 = fetchAggregatedRating("tt0111161", "k", ctrl.signal, { tmdbId: 278, mediaType: "movie" })
    const p2 = fetchAggregatedRating(null, "k", undefined, { tmdbId: 278, mediaType: "movie" })
    ctrl.abort()
    const [a, b] = await Promise.all([p1, p2])
    expect(a).toBeNull()
    expect(b?.sources.imdb).toBe(9.3)
    expect(mdblistCalls(fetchMock)).toHaveLength(1)
  })

  it("aborted TMDB-only caller resolves null, IMDb+pair survivor completes", async () => {
    const fetchMock = vi.fn(async (_url: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return jsonOk(MOVIE)
    })
    vi.stubGlobal("fetch", fetchMock)
    const ctrl = new AbortController()
    const p1 = fetchAggregatedRating(null, "k", ctrl.signal, { tmdbId: 278, mediaType: "movie" })
    const p2 = fetchAggregatedRating("tt0111161", "k", undefined, { tmdbId: 278, mediaType: "movie" })
    ctrl.abort()
    const [a, b] = await Promise.all([p1, p2])
    expect(a).toBeNull()
    expect(b?.sources.imdb).toBe(9.3)
    expect(mdblistCalls(fetchMock)).toHaveLength(1)
  })
})
