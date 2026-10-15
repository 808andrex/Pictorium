// Task C correction-2 — hydrated joiners must not renew the raw absolute expiry.
//
// Concrete TTL bug (ratings.ts ~968-970 pre-fix): a simultaneous known-pair
// joiner published its own raw alias (`cacheSet(rawKey, shared.sources,
// shared.rawTtlMs)` + disk L2) for ANY shared success. A shared operation
// hydrated from KV/disk/L1 close to the original expiry carries only the
// policy default (24h) in `rawTtlMs` — never the remaining lifetime — so the
// joiner copied near-expired data under a fresh 24h alias, renewing expired
// data and violating the raw absolute expiry. Fix: `MdbListFetchResult`
// carries `hydrated` (true for every L1/KV/disk path, unset for genuine
// upstream); the joiner publishes its alias ONLY for fresh upstream and
// serves hydrated data without new writes. Sequential counterpart reuse
// (TMDB-only cached with no observed IMDb, later IMDb known pair) likewise
// serves the counterpart L1 entry WITHOUT copying (no cacheSet, no disk
// write, no fresh network), so the original expiry is never reset.
//
// Env: no real network/credentials; `fetch` is stubbed per test. The KV-gate
// mock below stands in for a near-expiry KV envelope: the ratings layer
// cannot know the remaining lifetime through `cacheGetShared` (no generic
// cache metadata API is added for this), hence it must not publish at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cacheClear } from "@/lib/cache"
import * as cacheModule from "@/lib/cache"
import * as rawCacheModule from "@/lib/mdblist-raw-cache"
import {
  fetchAggregatedRating,
  MDB_RAW_TTL_MS,
  MDB_RAW_OLD_MOVIE_TTL_MS,
  __resetMdblistBreaker,
  __resetMdbRawForTest,
  __resetRatingsNullForTest,
} from "@/lib/ratings"
import { __resetMdbQuotaForTests } from "@/lib/mdblist-quota"

function jsonOk(body: unknown): unknown {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body }
}

function mdblistCalls(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("mdblist.com"))
}

function spyCacheSet() {
  const originalSet = cacheModule.cacheSet
  return vi
    .spyOn(cacheModule, "cacheSet")
    .mockImplementation((k: string, v: unknown, tags?: string[], ttlMs?: number) => {
      originalSet(k, v, tags ?? [], ttlMs)
    })
}

function rawTtls(spy: ReturnType<typeof vi.spyOn>): Array<number | undefined> {
  return (spy.mock.calls as Array<[string, unknown, string[]?, number?]>)
    .filter(([k]) => String(k).startsWith("mdb:raw:"))
    .map(([, , , ttl]) => ttl)
}

// Old-movie body (type + released beyond the recent window): legit 7d raw
// TTL. No imdb_id/tmdb_id fields: the pair is caller-known, never observed.
const OLD_7D = {
  type: "movie",
  title: "Old Movie",
  year: 2015,
  released: "2015-06-01",
  score: 87,
  ratings: [{ source: "imdb", value: 8.7, score: 87, votes: 5000 }],
}

// No timing metadata: default 24h raw TTL. No observed counterpart fields.
const DEFAULT_24 = {
  title: "Untimed Title",
  score: 72,
  ratings: [{ source: "imdb", value: 7.2, score: 72, votes: 5000 }],
}

beforeEach(async () => {
  cacheClear()
  __resetMdblistBreaker()
  __resetRatingsNullForTest()
  __resetMdbQuotaForTests()
  __resetMdbRawForTest()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  cacheClear()
  __resetMdblistBreaker()
  __resetRatingsNullForTest()
  __resetMdbQuotaForTests()
  __resetMdbRawForTest()
})

describe("correction-2: hydrated simultaneous joiner publishes no alias (no renewal)", () => {
  it("TMDB-first, KV-hydrated shared: joiner served, zero raw writes, zero disk writes, zero network", async () => {
    const fetchMock = vi.fn(async (_url: unknown) => jsonOk(DEFAULT_24))
    vi.stubGlobal("fetch", fetchMock)
    const setSpy = spyCacheSet()
    const diskSpy = vi.spyOn(rawCacheModule, "setPersistedMdbRaw")
    let releaseKv!: (value: Record<string, number> | null) => void
    const kvGate = new Promise<Record<string, number> | null>((resolve) => {
      releaseKv = resolve
    })
    const kvSpy = vi
      .spyOn(cacheModule, "cacheGetShared")
      .mockImplementation((async () => kvGate) as unknown as typeof cacheModule.cacheGetShared)
    try {
      // TMDB-first: the TMDB-only caller owns the transport; the IMDb+pair
      // caller joins via the pre-registered counterpart key. This is the
      // order that reaches the joiner alias publish (joiner owns an imdbId).
      const p1 = fetchAggregatedRating(null, "k", undefined, { tmdbId: 278, mediaType: "movie" })
      const p2 = fetchAggregatedRating("tt_hyd_alias1", "k", undefined, { tmdbId: 278, mediaType: "movie" })
      await new Promise((r) => setTimeout(r, 20))
      // Gated KV hit near the original expiry (remaining lifetime unknown to
      // the ratings layer): both subscribers share the single hydration.
      releaseKv({ imdb: 7.2 })
      const [a, b] = await Promise.all([p1, p2])
      expect(a?.sources.imdb).toBe(7.2)
      expect(b?.sources).toEqual(a?.sources)
      // One shared KV lookup, never a second; zero MDBList network.
      expect(kvSpy).toHaveBeenCalledTimes(1)
      expect(mdblistCalls(fetchMock)).toHaveLength(0)
      // No alias renewal: no raw cacheSet (fresh 24h) and no disk L2 write.
      // Pre-fix this published one 24h alias (+ disk) for the joiner.
      expect(rawTtls(setSpy)).toEqual([])
      expect(diskSpy).not.toHaveBeenCalled()
    } finally {
      releaseKv(null)
    }
  })

  it("IMDb-first, KV-hydrated shared: zero raw writes, zero disk writes, zero network", async () => {
    const fetchMock = vi.fn(async (_url: unknown) => jsonOk(DEFAULT_24))
    vi.stubGlobal("fetch", fetchMock)
    const setSpy = spyCacheSet()
    const diskSpy = vi.spyOn(rawCacheModule, "setPersistedMdbRaw")
    let releaseKv!: (value: Record<string, number> | null) => void
    const kvGate = new Promise<Record<string, number> | null>((resolve) => {
      releaseKv = resolve
    })
    const kvSpy = vi
      .spyOn(cacheModule, "cacheGetShared")
      .mockImplementation((async () => kvGate) as unknown as typeof cacheModule.cacheGetShared)
    try {
      const p1 = fetchAggregatedRating("tt_hyd_alias2", "k", undefined, { tmdbId: 279, mediaType: "movie" })
      const p2 = fetchAggregatedRating(null, "k", undefined, { tmdbId: 279, mediaType: "movie" })
      await new Promise((r) => setTimeout(r, 20))
      releaseKv({ imdb: 7.2 })
      const [a, b] = await Promise.all([p1, p2])
      expect(a?.sources.imdb).toBe(7.2)
      expect(b?.sources).toEqual(a?.sources)
      expect(kvSpy).toHaveBeenCalledTimes(1)
      expect(mdblistCalls(fetchMock)).toHaveLength(0)
      expect(rawTtls(setSpy)).toEqual([])
      expect(diskSpy).not.toHaveBeenCalled()
    } finally {
      releaseKv(null)
    }
  })
})

describe("correction-2: fresh simultaneous known pair still publishes the legit TTL", () => {
  it("TMDB-first fresh old movie: single fetch, alias preserves the legit 7d", async () => {
    const fetchMock = vi.fn(async (_url: unknown) => jsonOk(OLD_7D))
    vi.stubGlobal("fetch", fetchMock)
    const setSpy = spyCacheSet()
    try {
      const p1 = fetchAggregatedRating(null, "k", undefined, { tmdbId: 280, mediaType: "movie" })
      const p2 = fetchAggregatedRating("tt_fresh7d", "k", undefined, { tmdbId: 280, mediaType: "movie" })
      const [a, b] = await Promise.all([p1, p2])
      expect(mdblistCalls(fetchMock)).toHaveLength(1)
      expect(a?.sources.imdb).toBe(8.7)
      expect(b?.sources).toEqual(a?.sources)
      // Primary + joiner alias, both with the legit 7d (never 24h here).
      expect(rawTtls(setSpy).sort()).toEqual([MDB_RAW_OLD_MOVIE_TTL_MS, MDB_RAW_OLD_MOVIE_TTL_MS])
    } finally {
      setSpy.mockRestore()
    }
  })

  it("IMDb-first fresh untimed title: single fetch, alias preserves the default 24h", async () => {
    const fetchMock = vi.fn(async (_url: unknown) => jsonOk(DEFAULT_24))
    vi.stubGlobal("fetch", fetchMock)
    const setSpy = spyCacheSet()
    try {
      const p1 = fetchAggregatedRating("tt_fresh24", "k", undefined, { tmdbId: 281, mediaType: "movie" })
      const p2 = fetchAggregatedRating(null, "k", undefined, { tmdbId: 281, mediaType: "movie" })
      const [a, b] = await Promise.all([p1, p2])
      expect(mdblistCalls(fetchMock)).toHaveLength(1)
      expect(a?.sources.imdb).toBe(7.2)
      expect(b?.sources).toEqual(a?.sources)
      // Owner primary + owner alias loop, both default 24h.
      expect(rawTtls(setSpy).sort()).toEqual([MDB_RAW_TTL_MS, MDB_RAW_TTL_MS])
    } finally {
      setSpy.mockRestore()
    }
  })
})

describe("correction-2: sequential counterpart reuse without renewal", () => {
  it("TMDB-only cached (no observed IMDb), later IMDb known pair reuses it: no fresh network, no TTL copy", async () => {
    const fetchMock = vi.fn(async (_url: unknown) => jsonOk(DEFAULT_24))
    vi.stubGlobal("fetch", fetchMock)
    const setSpy = spyCacheSet()
    const diskSpy = vi.spyOn(rawCacheModule, "setPersistedMdbRaw")
    try {
      const first = await fetchAggregatedRating(null, "k", undefined, { tmdbId: 282, mediaType: "movie" })
      expect(first?.sources.imdb).toBe(7.2)
      expect(mdblistCalls(fetchMock)).toHaveLength(1)
      // TMDB-primary with no observed IMDb writes only its own entry.
      expect(rawTtls(setSpy)).toEqual([MDB_RAW_TTL_MS])
      const diskCallsAfterFirst = diskSpy.mock.calls.length

      // Later caller-known pair: must reuse the counterpart raw cache with
      // zero fresh network and WITHOUT copying/resetting the TTL (no new
      // raw write, no disk write). Pre-fix this fetched a second upstream.
      const second = await fetchAggregatedRating("tt_seq_reuse1", "k", undefined, {
        tmdbId: 282,
        mediaType: "movie",
      })
      expect(second?.sources).toEqual(first?.sources)
      expect(mdblistCalls(fetchMock)).toHaveLength(1)
      expect(rawTtls(setSpy)).toEqual([MDB_RAW_TTL_MS])
      expect(diskSpy.mock.calls.length).toBe(diskCallsAfterFirst)
    } finally {
      setSpy.mockRestore()
    }
  })
})
