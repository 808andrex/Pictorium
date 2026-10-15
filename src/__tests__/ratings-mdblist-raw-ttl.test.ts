import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  fetchAggregatedRating,
  mdbRawTtlForData,
  MDB_RAW_TTL_MS,
  MDB_RAW_OLD_MOVIE_TTL_MS,
  RATINGS_SUCCESS_TTL_MS,
  __resetMdblistBreaker,
  __resetMdbRawForTest,
  __resetRatingsNullForTest,
} from "@/lib/ratings"
import { cacheClear } from "@/lib/cache"
import * as cacheModule from "@/lib/cache"

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
// 1° gennaio 2026 mezzogiorno UTC: i film 2025 restano "recenti" (finestra
// 14 giorni), i 2024 e precedenti sono vecchi.
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)

function okRatings(body: unknown) {
  return { ok: true, json: async () => body }
}

function mdblistCalls(mock: ReturnType<typeof vi.fn>): number {
  return mock.mock.calls.filter(([input]) => String(input).includes("mdblist.com")).length
}

const SOURCES = [
  { source: "imdb", value: 84, score: 84 },
  { source: "metacritic", value: 75, score: 75 },
]

const NO_TIMING = { ratings: SOURCES }
const OLD_MOVIE = { type: "movie", released: "2020-05-04", ratings: SOURCES }
const RECENT_MOVIE = { type: "movie", released: "2025-12-30", ratings: SOURCES }
const OLD_SERIES = { type: "show", status: "Ended", released: "2010-04-05", ratings: SOURCES }

beforeEach(() => {
  cacheClear()
  __resetMdblistBreaker()
  __resetRatingsNullForTest()
  __resetMdbRawForTest()
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  cacheClear()
  __resetMdbRawForTest()
  __resetRatingsNullForTest()
})

describe("MDBList raw TTL policy (task 2, pura)", () => {
  it("espone le costanti attese (24h default, 7d film vecchi, 6h aggregata invariata)", () => {
    expect(MDB_RAW_TTL_MS).toBe(24 * HOUR)
    expect(MDB_RAW_OLD_MOVIE_TTL_MS).toBe(7 * DAY)
    expect(RATINGS_SUCCESS_TTL_MS).toBe(6 * HOUR)
  })

  it("default 24h senza metadati temporali", () => {
    for (const body of [null, undefined, {}, { ratings: SOURCES }, { type: "movie" }, { released: "2020-05-04" }]) {
      expect(mdbRawTtlForData(body, T0)).toBe(MDB_RAW_TTL_MS)
    }
  })

  it("7d solo per film con uscita oltre la finestra recente", () => {
    expect(mdbRawTtlForData({ type: "movie", released: "2020-05-04" }, T0)).toBe(MDB_RAW_OLD_MOVIE_TTL_MS)
    // Type esatto case-insensitive: "Movie" vale; "film"/"movies"/"shows"
    // non sono mai normalizzati in "movie".
    expect(mdbRawTtlForData({ type: "Movie", released: "2020-05-04" }, T0)).toBe(MDB_RAW_OLD_MOVIE_TTL_MS)
    expect(mdbRawTtlForData({ type: "film", released: "2020-05-04" }, T0)).toBe(MDB_RAW_TTL_MS)
    expect(mdbRawTtlForData({ type: "movies", released: "2020-05-04" }, T0)).toBe(MDB_RAW_TTL_MS)
  })

  it("chiavi alias non documentate: mai vecchio (solo type/released/year espliciti)", () => {
    // Nessuna fixture checked-in documenta alias per il detail endpoint:
    // solo i campi espliciti contano.
    expect(mdbRawTtlForData({ type: "movie", release_date: "2020-05-04" }, T0)).toBe(MDB_RAW_TTL_MS)
    expect(mdbRawTtlForData({ mediatype: "movie", released: "2020-05-04" }, T0)).toBe(MDB_RAW_TTL_MS)
    expect(mdbRawTtlForData({ media_type: "movie", released: "2020-05-04" }, T0)).toBe(MDB_RAW_TTL_MS)
    expect(mdbRawTtlForData({ kind: "movie", released: "2020-05-04" }, T0)).toBe(MDB_RAW_TTL_MS)
    expect(mdbRawTtlForData({ type: "movie", release_year: 2020 }, T0)).toBe(MDB_RAW_TTL_MS)
    expect(mdbRawTtlForData({ type: "movie", releaseYear: 2020 }, T0)).toBe(MDB_RAW_TTL_MS)
  })

  it("date calendario impossibili: 24h (Date.parse le normalizza, non ritorna NaN)", () => {
    // 30 febbraio / 31 aprile / mese 13 / giorno 0 non esistono: Date.parse
    // li sposta al mese dopo invece di fallire — devono restare 24h.
    for (const bad of ["2020-02-30", "2021-02-29", "2020-13-01", "2020-00-10", "2020-04-31", "2019-02-29"]) {
      expect(mdbRawTtlForData({ type: "movie", released: bad }, T0)).toBe(MDB_RAW_TTL_MS)
    }
    // Bisestile reale: 29 febbraio 2020 esiste → vecchio.
    expect(mdbRawTtlForData({ type: "movie", released: "2020-02-29" }, T0)).toBe(MDB_RAW_OLD_MOVIE_TTL_MS)
    // Datetime ISO con parte data impossibile: stessa regola.
    expect(mdbRawTtlForData({ type: "movie", released: "2020-02-30T12:00:00.000Z" }, T0)).toBe(MDB_RAW_TTL_MS)
  })

  it("film recente (<=14 giorni) resta 24h, con confronto coerente alla soglia", () => {
    // 2 giorni fa: recente.
    expect(mdbRawTtlForData({ type: "movie", released: "2025-12-30" }, T0)).toBe(MDB_RAW_TTL_MS)
    // Futuro: mai vecchio.
    expect(mdbRawTtlForData({ type: "movie", released: "2026-02-01" }, T0)).toBe(MDB_RAW_TTL_MS)
    // Soglia 14 giorni coerente coi badge novità (età < 14d = nuovo).
    const fourteenDaysAgo = new Date(T0 - 14 * DAY).toISOString()
    expect(mdbRawTtlForData({ type: "movie", released: fourteenDaysAgo }, T0)).toBe(MDB_RAW_OLD_MOVIE_TTL_MS)
    const justInside = new Date(T0 - 14 * DAY + 60_000).toISOString()
    expect(mdbRawTtlForData({ type: "movie", released: justInside }, T0)).toBe(MDB_RAW_TTL_MS)
  })

  it("data non parsabile o tipo ignoto: mai vecchio", () => {
    expect(mdbRawTtlForData({ type: "movie", released: "non una data" }, T0)).toBe(MDB_RAW_TTL_MS)
    expect(mdbRawTtlForData({ type: "game", released: "2000-01-01" }, T0)).toBe(MDB_RAW_TTL_MS)
    expect(mdbRawTtlForData({ released: "2000-01-01" }, T0)).toBe(MDB_RAW_TTL_MS)
  })

  it("serie sempre 24h, anche vecchie e concluse (niente 7d per le serie)", () => {
    for (const type of ["show", "series", "tv", "anime"]) {
      expect(mdbRawTtlForData({ type, released: "2010-04-05" }, T0)).toBe(MDB_RAW_TTL_MS)
    }
    expect(mdbRawTtlForData({ type: "show", status: "Ended", released: "2010-04-05" }, T0)).toBe(MDB_RAW_TTL_MS)
    expect(mdbRawTtlForData({ type: "movie", show: true, released: "2010-04-05" }, T0)).toBe(MDB_RAW_TTL_MS)
  })

  it("anno-solo affidabile: prova la vecchiaia solo oltre il margine di gennaio", () => {
    // Anno passato certo (2020, ora 2026): vecchio.
    expect(mdbRawTtlForData({ type: "movie", year: 2020 }, T0)).toBe(MDB_RAW_OLD_MOVIE_TTL_MS)
    // Anno precedente a ridosso del confine: a inizio gennaio non prova nulla.
    expect(mdbRawTtlForData({ type: "movie", year: 2025 }, Date.UTC(2026, 0, 10))).toBe(MDB_RAW_TTL_MS)
    expect(mdbRawTtlForData({ type: "movie", released: "2025" }, Date.UTC(2026, 0, 10))).toBe(MDB_RAW_TTL_MS)
    // Dal 15 gennaio l'anno precedente è certamente oltre i 14 giorni.
    expect(mdbRawTtlForData({ type: "movie", year: 2025 }, Date.UTC(2026, 0, 20))).toBe(MDB_RAW_OLD_MOVIE_TTL_MS)
    // Boundary esatto: un anno-solo può significare fino al 31 dicembre
    // 23:59, quindi servono >14 giorni pieni — Jan 15 00:00:00.000 esatti non
    // bastano, 1ms dopo sì.
    expect(mdbRawTtlForData({ type: "movie", year: 2025 }, Date.UTC(2026, 0, 15))).toBe(MDB_RAW_TTL_MS)
    expect(mdbRawTtlForData({ type: "movie", year: 2025 }, Date.UTC(2026, 0, 15) + 1)).toBe(MDB_RAW_OLD_MOVIE_TTL_MS)
    expect(mdbRawTtlForData({ type: "movie", released: "2025" }, Date.UTC(2026, 0, 15))).toBe(MDB_RAW_TTL_MS)
    expect(mdbRawTtlForData({ type: "movie", released: "2025" }, Date.UTC(2026, 0, 15) + 1)).toBe(MDB_RAW_OLD_MOVIE_TTL_MS)
    // Anno corrente o futuro: mai vecchio.
    expect(mdbRawTtlForData({ type: "movie", year: 2026 }, T0)).toBe(MDB_RAW_TTL_MS)
    expect(mdbRawTtlForData({ type: "movie", year: 2027 }, T0)).toBe(MDB_RAW_TTL_MS)
  })
})

describe("MDBList raw freshness integrata (task 2)", () => {
  type CacheSetCall = [k: string, v: unknown, tags?: string[], ttlMs?: number]
  function seenTtls(spy: ReturnType<typeof vi.spyOn>) {
    const calls = spy.mock.calls as CacheSetCall[]
    const raw = calls
      .filter(([k]) => String(k).startsWith("mdb:raw:"))
      .map(([, , , ttl]) => ttl)
    const agg = calls
      .filter(([k]) => String(k).startsWith("mdb:ratings:"))
      .map(([, , , ttl]) => ttl)
    return { raw, agg }
  }

  function spyCacheSet() {
    const originalSet = cacheModule.cacheSet
    return vi.spyOn(cacheModule, "cacheSet").mockImplementation((k: string, v: unknown, tags?: string[], ttlMs?: number) => {
      originalSet(k, v, tags ?? [], ttlMs)
    })
  }

  it("default 24h: oltre le 6h aggregate riusa la grezza senza refetch, refetch dopo 24h", async () => {
    const fetchMock = vi.fn(async () => okRatings(NO_TIMING))
    vi.stubGlobal("fetch", fetchMock)
    const spy = spyCacheSet()
    try {
      const first = await fetchAggregatedRating("tt_ttl_24", "keyA", undefined, {
        requestedSources: ["imdb"],
        ratingWaitMs: 1500,
      })
      expect(first?.sources.imdb).toBe(8.4)
      expect(mdblistCalls(fetchMock)).toBe(1)
      // Grezza a 24h (body senza data+tipo), aggregata a 6h invariata.
      expect(seenTtls(spy)).toEqual({ raw: [MDB_RAW_TTL_MS], agg: [RATINGS_SUCCESS_TTL_MS] })

      vi.setSystemTime(T0 + 6 * HOUR - 60_000)
      expect((await fetchAggregatedRating("tt_ttl_24", "keyA", undefined, {
        requestedSources: ["imdb"],
        ratingWaitMs: 1500,
      }))?.sources.imdb).toBe(8.4)
      expect(mdblistCalls(fetchMock)).toBe(1)

      // Aggregata scaduta ma grezza valida, selezione diversa: nessun
      // upstream, solo re-cache dell'aggregata.
      vi.setSystemTime(T0 + 6 * HOUR + 1_000)
      const reServed = await fetchAggregatedRating("tt_ttl_24", "keyA", undefined, {
        requestedSources: ["metacritic"],
        ratingWaitMs: 1500,
      })
      expect(reServed?.sources.metacritic).toBe(7.5)
      expect(mdblistCalls(fetchMock)).toBe(1)
      expect(seenTtls(spy).agg).toEqual([RATINGS_SUCCESS_TTL_MS, RATINGS_SUCCESS_TTL_MS])

      // Grezza scaduta (24h): di nuovo upstream.
      vi.setSystemTime(T0 + DAY + 1_000)
      expect((await fetchAggregatedRating("tt_ttl_24", "keyA", undefined, {
        requestedSources: ["imdb"],
        ratingWaitMs: 1500,
      }))?.sources.imdb).toBe(8.4)
      expect(mdblistCalls(fetchMock)).toBe(2)
    } finally {
      spy.mockRestore()
    }
  })

  it("film vecchio 7d: nessun refetch a 24h+, refetch dopo 7d", async () => {
    const fetchMock = vi.fn(async () => okRatings(OLD_MOVIE))
    vi.stubGlobal("fetch", fetchMock)
    const spy = spyCacheSet()
    try {
      await fetchAggregatedRating("tt_ttl_7d", "keyA", undefined, {
        requestedSources: ["imdb"],
        ratingWaitMs: 1500,
      })
      expect(mdblistCalls(fetchMock)).toBe(1)
      expect(seenTtls(spy)).toEqual({ raw: [MDB_RAW_OLD_MOVIE_TTL_MS], agg: [RATINGS_SUCCESS_TTL_MS] })

      vi.setSystemTime(T0 + DAY + 1_000)
      const reServed = await fetchAggregatedRating("tt_ttl_7d", "keyA", undefined, {
        requestedSources: ["metacritic"],
        ratingWaitMs: 1500,
      })
      expect(reServed?.sources.metacritic).toBe(7.5)
      expect(mdblistCalls(fetchMock)).toBe(1)

      vi.setSystemTime(T0 + 7 * DAY - 60_000)
      await fetchAggregatedRating("tt_ttl_7d", "keyA", undefined, {
        requestedSources: ["imdb"],
        ratingWaitMs: 1500,
      })
      expect(mdblistCalls(fetchMock)).toBe(1)

      vi.setSystemTime(T0 + 7 * DAY + 1_000)
      // Selezione diversa (aggregata scaduta da giorni, grezza scaduta ora):
      // di nuovo upstream.
      const refetched = await fetchAggregatedRating("tt_ttl_7d", "keyA", undefined, {
        requestedSources: ["metacritic"],
        ratingWaitMs: 1500,
      })
      expect(refetched?.sources.metacritic).toBe(7.5)
      expect(mdblistCalls(fetchMock)).toBe(2)
    } finally {
      spy.mockRestore()
    }
  })

  it("film recente e serie vecchia restano 24h", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("tt_ttl_recent")) return okRatings(RECENT_MOVIE)
      return okRatings(OLD_SERIES)
    })
    vi.stubGlobal("fetch", fetchMock)
    const spy = spyCacheSet()
    try {
      await fetchAggregatedRating("tt_ttl_recent", "keyA", undefined, {
        requestedSources: ["imdb"],
        ratingWaitMs: 1500,
      })
      await fetchAggregatedRating("tt_ttl_series", "keyA", undefined, {
        requestedSources: ["imdb"],
        ratingWaitMs: 1500,
      })
      expect(mdblistCalls(fetchMock)).toBe(2)
      expect(seenTtls(spy).raw).toEqual([MDB_RAW_TTL_MS, MDB_RAW_TTL_MS])

      vi.setSystemTime(T0 + DAY + 1_000)
      await fetchAggregatedRating("tt_ttl_recent", "keyA", undefined, {
        requestedSources: ["imdb"],
        ratingWaitMs: 1500,
      })
      await fetchAggregatedRating("tt_ttl_series", "keyA", undefined, {
        requestedSources: ["imdb"],
        ratingWaitMs: 1500,
      })
      expect(mdblistCalls(fetchMock)).toBe(4)
    } finally {
      spy.mockRestore()
    }
  })
})
