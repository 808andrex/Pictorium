import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  fetchAggregatedRating,
  RATINGS_SUCCESS_TTL_MS,
  MDB_RAW_TTL_MS,
  __resetMdblistBreaker,
  __resetRatingsNullForTest,
} from "@/lib/ratings"
import { __resetCinemetaBreaker, __resetCinemetaNullForTest } from "@/lib/cinemeta"
import { __resetAnimeBreakers, __resetAnimeNullForTest } from "@/lib/anime-ratings"
import { __resetSimklBreaker, __resetSimklNullForTest } from "@/lib/simkl"
import { cacheClear } from "@/lib/cache"
import * as cacheModule from "@/lib/cache"

function okRatings(body: unknown) {
  return { ok: true, json: async () => body }
}

function hangingFetch(signal?: AbortSignal | null): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (!signal) return // mai risolto: solo con budget esterni che abortiscono
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
  })
}

// Attesa abortibile guidata dai timer (reali o fake): il fallback dimostra
// così di avere residuo utilizzabile senza introdurre attese reali.
function abortableDelay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const timer = setTimeout(() => resolve(), ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(new DOMException("Aborted", "AbortError"))
      },
      { once: true },
    )
  })
}

beforeEach(() => {
  __resetMdblistBreaker()
  __resetRatingsNullForTest()
  __resetCinemetaBreaker()
  __resetCinemetaNullForTest()
  __resetAnimeBreakers()
  __resetAnimeNullForTest()
  __resetSimklBreaker()
  __resetSimklNullForTest()
  cacheClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe("ratings provider routing (selezione per fonte)", () => {
  it("TMDB-only con voto diretto genuino: zero upstream di rating", async () => {
    const fetchMock = vi.fn(async () => okRatings({ ratings: [] }))
    vi.stubGlobal("fetch", fetchMock)

    const first = await fetchAggregatedRating("tt_route_tmdb", "k", undefined, {
      requestedSources: ["tmdb"],
      ratingWaitMs: 1500,
      tmdbFallbackVote: 7.34,
    })
    expect(first?.sources).toEqual({ tmdb: 7.3 })
    expect(first?.average).toBe(7.3)
    expect(fetchMock).not.toHaveBeenCalled()

    // Seconda chiamata: voto diretto ricalcolato, ancora zero rete. Mai un
    // cache-hit success: il voto diretto request-specific non è mai cachato
    // (congelarlo maschererebbe il recovery del provider).
    const second = await fetchAggregatedRating("tt_route_tmdb", "k", undefined, {
      requestedSources: ["tmdb"],
      ratingWaitMs: 1500,
      tmdbFallbackVote: 7.34,
    })
    expect(second?.sources).toEqual({ tmdb: 7.3 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("TMDB-only senza voto diretto: fallback MDBList, mai chiamate TMDB extra", async () => {
    const seen: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        seen.push(String(input))
        return okRatings({ ratings: [{ source: "tmdb", value: 82, score: 82 }] })
      }),
    )

    const result = await fetchAggregatedRating("tt_route_tmdb_miss", "k", undefined, {
      requestedSources: ["tmdb"],
      ratingWaitMs: 1500,
    })
    expect(result?.sources.tmdb).toBe(8.2)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((u) => u.includes("mdblist.com"))).toBe(true)
  })

  it("IMDb-only: Cinemeta primario, zero MDBList sul hit", async () => {
    const seen: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        seen.push(url)
        if (url.includes("/meta/")) return okRatings({ meta: { imdbRating: "8.4" } })
        return okRatings({ ratings: [] })
      }),
    )

    const result = await fetchAggregatedRating("tt_route_imdb", "k", undefined, {
      requestedSources: ["imdb"],
      ratingWaitMs: 1500,
    })
    expect(result?.sources.imdb).toBe(8.4)
    expect(seen.some((u) => u.includes("/meta/"))).toBe(true)
    expect(seen.some((u) => u.includes("mdblist.com"))).toBe(false)
  })

  it("IMDb-only con miss Cinemeta: fallback MDBList sul residuo di budget", async () => {
    const seen: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        seen.push(url)
        if (url.includes("/meta/")) return okRatings({ meta: {} })
        return okRatings({ ratings: [{ source: "imdb", value: 77, score: 77 }] })
      }),
    )

    const result = await fetchAggregatedRating("tt_route_imdb_fb", "k", undefined, {
      requestedSources: ["imdb"],
      ratingWaitMs: 1500,
    })
    expect(result?.sources.imdb).toBe(7.7)
    expect(seen.some((u) => u.includes("/meta/"))).toBe(true)
    expect(seen.some((u) => u.includes("mdblist.com"))).toBe(true)
  })

  it("IMDb+TMDB con voto diretto e Cinemeta hit: tmdb diretto, zero MDBList", async () => {
    const seen: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        seen.push(url)
        if (url.includes("/meta/")) return okRatings({ meta: { imdbRating: "9.3" } })
        return okRatings({ ratings: [{ source: "imdb", value: 1.1 }] })
      }),
    )

    const result = await fetchAggregatedRating("tt_route_imdb_tmdb", "k", undefined, {
      requestedSources: ["imdb", "tmdb"],
      ratingWaitMs: 1500,
      tmdbFallbackVote: 8.0,
    })
    expect(result?.sources).toEqual({ imdb: 9.3, tmdb: 8.0 })
    expect(seen.some((u) => u.includes("mdblist.com"))).toBe(false)
  })

  it("fonti MDBList-exclusive (metacritic): MDBList primaria, mai Cinemeta se imdb non richiesto", async () => {
    const seen: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        seen.push(url)
        return okRatings({ ratings: [{ source: "metacritic", value: 85, score: 85 }] })
      }),
    )

    const result = await fetchAggregatedRating("tt_route_meta", "k", undefined, {
      requestedSources: ["metacritic"],
      ratingWaitMs: 1500,
    })
    expect(result?.sources.metacritic).toBe(8.5)
    expect(seen.some((u) => u.includes("mdblist.com"))).toBe(true)
    expect(seen.some((u) => u.includes("/meta/"))).toBe(false)
  })

  it("simkl-only: direct provider, zero MDBList e zero Cinemeta", async () => {
    const seen: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        seen.push(url)
        if (url.includes("/redirect")) {
          return {
            status: 301,
            headers: { get: (n: string) => (n.toLowerCase() === "location" ? "https://simkl.com/movies/999/" : null) },
          }
        }
        return okRatings({ ratings: { simkl: { rating: 8.6 } } })
      }),
    )

    const result = await fetchAggregatedRating("tt_route_simkl", undefined, undefined, {
      simklKey: "test-simkl-key",
      requestedSources: ["simkl"],
      ratingWaitMs: 1500,
    })
    expect(result?.sources.simkl).toBe(8.6)
    expect(seen.some((u) => u.includes("mdblist.com"))).toBe(false)
    expect(seen.some((u) => u.includes("/meta/"))).toBe(false)
  })

  it("anilist-only: direct provider via AniZip, zero MDBList", async () => {
    const seen: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        void init
        const url = String(input)
        seen.push(url)
        if (url.includes("/mappings?")) return okRatings({ mappings: { anilist_id: 21, kitsu_id: null } })
        if (url.includes("anilist")) return okRatings({ data: { Media: { averageScore: 85 } } })
        return okRatings({})
      }),
    )

    const result = await fetchAggregatedRating("tt_route_anilist", undefined, undefined, {
      tmdbId: 9999999,
      mediaType: "movie",
      requestedSources: ["anilist"],
      ratingWaitMs: 1500,
    })
    expect(result?.sources.anilist).toBe(8.5)
    expect(seen.some((u) => u.includes("mdblist.com"))).toBe(false)
  })

  it("voto diretto ignorato quando tmdb non è richiesto (mai leak in simkl-only)", async () => {
    const seen: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        seen.push(url)
        if (url.includes("/redirect")) {
          return {
            status: 301,
            headers: { get: (n: string) => (n.toLowerCase() === "location" ? "https://simkl.com/movies/998/" : null) },
          }
        }
        return okRatings({ ratings: { simkl: { rating: 7.1 } } })
      }),
    )

    const result = await fetchAggregatedRating("tt_route_simkl_noleak", undefined, undefined, {
      simklKey: "test-simkl-key",
      requestedSources: ["simkl"],
      ratingWaitMs: 1500,
      tmdbFallbackVote: 9.9,
    })
    expect(result?.sources).toEqual({ simkl: 7.1 })
  })

  it("cache isolata per selezione: stesso key a ordine diverso, key diverse per policy diverse (v3)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okRatings({ ratings: [{ source: "imdb", value: 80, score: 80 }] })))
    const keys: string[] = []
    const originalSet = cacheModule.cacheSet
    const spy = vi.spyOn(cacheModule, "cacheSet").mockImplementation((k: string, v: unknown, tags?: string[], ttlMs?: number) => {
      // Solo la cache aggregata per-selezione: la cache grezza MDBList
      // (mdb:raw:…, condivisa tra selezioni) scrive anch'essa via cacheSet.
      if (k.startsWith("mdb:ratings:")) keys.push(k)
      originalSet(k, v, tags, ttlMs)
    })
    try {
      await fetchAggregatedRating("tt_route_key", "k", undefined, { requestedSources: ["tmdb", "imdb"], ratingWaitMs: 1500 })
      // Stesse fonti in ordine display diverso → stessa entry (sort/dedupe).
      await fetchAggregatedRating("tt_route_key", "k", undefined, { requestedSources: ["imdb", "tmdb"], ratingWaitMs: 1500 })
      await fetchAggregatedRating("tt_route_key", "k", undefined, { requestedSources: ["metacritic"], ratingWaitMs: 1500 })
      // Legacy senza selezione → namespace separato.
      await fetchAggregatedRating("tt_route_key", "k")

      expect(keys).toHaveLength(3)
      expect(keys[0]).toMatch(/^mdb:ratings:v3:tt_route_key:/)
      expect(keys[0]).toContain(":sel:imdb,tmdb")
      expect(keys).not.toContain(keys[0] + ":dup")
      expect(keys[1]).toContain(":sel:metacritic")
      expect(keys[2]).toContain(":sel:all")
      expect(keys[0]).not.toContain("keyAAA")
      // Il TTL reale passato a cacheSet è 6h su ogni scrittura aggregata
      // success, non solo la costante esportata (prova contro
      // l'avvelenamento). La grezza (mdb:raw:…) vive più a lungo: 24h di
      // default quando il body non porta data+tipo affidabili (task 2), mai
      // in chiaro la chiave (solo hash nel nome).
      // Conta solo le scritture aggregate: la grezza (mdb:raw:…) condivide
      // il canale ma ha TTL proprio ed è fuori dal conteggio per-selezione.
      expect(spy.mock.calls.filter(([k]) => String(k).startsWith("mdb:ratings:"))).toHaveLength(3)
      for (const call of spy.mock.calls.filter(([k]) => String(k).startsWith("mdb:ratings:"))) {
        expect(call[3]).toBe(RATINGS_SUCCESS_TTL_MS)
      }
      for (const call of spy.mock.calls.filter(([k]) => String(k).startsWith("mdb:raw:"))) {
        expect(call[3]).toBe(MDB_RAW_TTL_MS)
      }
      expect(MDB_RAW_TTL_MS).toBe(24 * 60 * 60 * 1000)
      expect(RATINGS_SUCCESS_TTL_MS).toBe(6 * 60 * 60 * 1000)
    } finally {
      spy.mockRestore()
    }
  })

  it("legacy senza selezione: comportamento all-source invariato (media aritmetica)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okRatings({ ratings: [{ source: "imdb", value: 80, score: 80 }, { source: "tmdb", value: 60, score: 60 }] })),
    )
    const result = await fetchAggregatedRating("tt_route_legacy", "k")
    expect(result?.sources.imdb).toBe(8.0)
    expect(result?.sources.tmdb).toBe(6.0)
    expect(result?.average).toBe(7.0)
    expect(result?.count).toBe(2)
  })

  it("transizione con->senza nativo (tmdb-only): nessun congelamento in cache", async () => {
    const seen: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        seen.push(String(input))
        return okRatings({ ratings: [{ source: "tmdb", value: 82, score: 82 }] })
      }),
    )
    const withNative = await fetchAggregatedRating("tt_route_trans_tmdb", "k", undefined, {
      requestedSources: ["tmdb"],
      ratingWaitMs: 1500,
      tmdbFallbackVote: 7.0,
    })
    expect(withNative?.sources).toEqual({ tmdb: 7.0 })
    expect(seen).toHaveLength(0)
    const without = await fetchAggregatedRating("tt_route_trans_tmdb", "k", undefined, {
      requestedSources: ["tmdb"],
      ratingWaitMs: 1500,
    })
    expect(without?.sources.tmdb).toBe(8.2)
    expect(seen.length).toBeGreaterThan(0)
    const callsBefore = seen.length
    const withAgain = await fetchAggregatedRating("tt_route_trans_tmdb", "k", undefined, {
      requestedSources: ["tmdb"],
      ratingWaitMs: 1500,
      tmdbFallbackVote: 7.0,
    })
    expect(withAgain?.sources.tmdb).toBe(7.0)
    expect(seen.length).toBe(callsBefore)
  })

  it("transizione con->senza nativo (imdb+tmdb family): base cachata senza diretto", async () => {
    const seen: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        seen.push(url)
        if (url.includes("/meta/")) return okRatings({ meta: { imdbRating: "9.3" } })
        return okRatings({ ratings: [{ source: "tmdb", value: 82, score: 82 }] })
      }),
    )
    const withNative = await fetchAggregatedRating("tt_route_trans_fam", "k", undefined, {
      requestedSources: ["imdb", "tmdb"],
      ratingWaitMs: 1500,
      tmdbFallbackVote: 7.0,
    })
    expect(withNative?.sources).toEqual({ imdb: 9.3, tmdb: 7.0 })
    // Base parziale non cachata con nativo (fallback tmdb saltato): il senza
    // rifetcha e completa dal provider.
    const without = await fetchAggregatedRating("tt_route_trans_fam", "k", undefined, {
      requestedSources: ["imdb", "tmdb"],
      ratingWaitMs: 1500,
    })
    expect(without?.sources).toEqual({ imdb: 9.3, tmdb: 8.2 })
    expect(seen.some((u) => u.includes("mdblist.com"))).toBe(true)
  })

  it("transizione con->senza nativo (outage/main): base cachata, overlay solo con nativo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okRatings({ ratings: [{ source: "metacritic", value: 80, score: 80 }, { source: "tmdb", value: 82, score: 82 }] })))
    const withNative = await fetchAggregatedRating("tt_route_trans_main", "k", undefined, {
      requestedSources: ["metacritic", "tmdb"],
      ratingWaitMs: 1500,
      tmdbFallbackVote: 7.0,
    })
    expect(withNative?.sources.metacritic).toBe(8.0)
    expect(withNative?.sources.tmdb).toBe(7.0)
    const fetchMock = vi.mocked(fetch)
    const callsBefore = fetchMock.mock.calls.length
    const without = await fetchAggregatedRating("tt_route_trans_main", "k", undefined, {
      requestedSources: ["metacritic", "tmdb"],
      ratingWaitMs: 1500,
    })
    expect(without?.sources.tmdb).toBe(8.2)
    expect(fetchMock.mock.calls.length).toBe(callsBefore)
  })

  it("miss->nativo: negativa provider ma nativo valido senza refetch", async () => {
    let n = 0
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/meta/")) return okRatings({ meta: {} })
      n++
      return okRatings({ ratings: [] })
    }))
    const miss = await fetchAggregatedRating("tt_route_trans_miss", "k", undefined, {
      requestedSources: ["imdb", "tmdb"],
      ratingWaitMs: 1500,
    })
    expect(miss).toBeNull()
    const callsBefore = n
    const native = await fetchAggregatedRating("tt_route_trans_miss", "k", undefined, {
      requestedSources: ["imdb", "tmdb"],
      ratingWaitMs: 1500,
      tmdbFallbackVote: 7.5,
    })
    expect(native?.sources).toEqual({ tmdb: 7.5 })
    expect(n).toBe(callsBefore)
  })

  it("misto imdb+simkl senza exclusive: Cinemeta primario + join diretto, MDBList solo irrisolti", async () => {
    const seen: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        seen.push(url)
        if (url.includes("/meta/")) return okRatings({ meta: { imdbRating: "8.4" } })
        if (url.includes("/redirect")) {
          return {
            status: 301,
            headers: { get: (h: string) => (h.toLowerCase() === "location" ? "https://simkl.com/movies/999/" : null) },
          }
        }
        if (url.includes("simkl.com")) return okRatings({ ratings: { simkl: { rating: 8.6 } } })
        return okRatings({ ratings: [] })
      }),
    )
    const result = await fetchAggregatedRating("tt_route_mixed", undefined, undefined, {
      simklKey: "test-simkl-key",
      requestedSources: ["imdb", "simkl"],
      ratingWaitMs: 1500,
    })
    expect(result?.sources.imdb).toBe(8.4)
    expect(result?.sources.simkl).toBe(8.6)
    expect(seen.some((u) => u.includes("mdblist.com"))).toBe(false)
  })

  it("tmdb+simkl con nativo: zero MDBList", async () => {
    const seen: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        seen.push(url)
        if (url.includes("/redirect")) {
          return {
            status: 301,
            headers: { get: (h: string) => (h.toLowerCase() === "location" ? "https://simkl.com/movies/997/" : null) },
          }
        }
        if (url.includes("simkl.com")) return okRatings({ ratings: { simkl: { rating: 7.7 } } })
        return okRatings({ ratings: [] })
      }),
    )
    const result = await fetchAggregatedRating("tt_route_tmdb_simkl", undefined, undefined, {
      simklKey: "test-simkl-key",
      requestedSources: ["tmdb", "simkl"],
      ratingWaitMs: 1500,
      tmdbFallbackVote: 8.1,
    })
    expect(result?.sources).toEqual({ tmdb: 8.1, simkl: 7.7 })
    expect(seen.some((u) => u.includes("mdblist.com"))).toBe(false)
    expect(seen.some((u) => u.includes("/meta/"))).toBe(false)
  })

  it("success TTL resta 6h, mai avvelenamento da transient", async () => {
    expect(RATINGS_SUCCESS_TTL_MS).toBe(6 * 60 * 60 * 1000)
  })
})

describe("ratings budget/timeout/cancellazione", () => {
  it("Cinemeta primario appeso: fallback MDBList parte al 60% (180/300) e il residuo resta utilizzabile", async () => {
    vi.useFakeTimers()
    try {
      const seen: string[] = []
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input)
          seen.push(url)
          if (url.includes("/meta/")) return hangingFetch(init?.signal ?? null)
          if (url.includes("mdblist.com")) {
            // Il fallback consuma 100 dei 120ms residui: prova che il resto
            // del budget è genuinamente utilizzabile, non solo nominale.
            await abortableDelay(100, init?.signal ?? null)
            return okRatings({ ratings: [{ source: "imdb", value: 77, score: 77 }] })
          }
          throw new Error(`unexpected upstream ${url}`)
        }),
      )

      const start = Date.now()
      const pending = fetchAggregatedRating("tt_route_budget300", "k", undefined, {
        requestedSources: ["imdb"],
        ratingWaitMs: 300,
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(seen.some((u) => u.includes("/meta/"))).toBe(true)
      expect(seen.some((u) => u.includes("mdblist.com"))).toBe(false)
      // Prima del confine 60%: primario ancora pendente, nessun fallback.
      await vi.advanceTimersByTimeAsync(179)
      expect(seen.some((u) => u.includes("mdblist.com"))).toBe(false)
      // Al confine 60% (180ms) il fallback parte.
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(seen.some((u) => u.includes("mdblist.com"))).toBe(true)
      // Il fallback ritardato (100ms) completa a ~280ms: dentro la deadline.
      await vi.advanceTimersByTimeAsync(100)
      const result = await pending
      const elapsed = Date.now() - start
      expect(result?.sources.imdb).toBe(7.7)
      expect(seen.some((u) => u.includes("/meta/"))).toBe(true)
      expect(seen.some((u) => u.includes("mdblist.com"))).toBe(true)
      expect(elapsed).toBeGreaterThanOrEqual(280)
      expect(elapsed).toBeLessThanOrEqual(300)
    } finally {
      vi.useRealTimers()
    }
  })

  it("Cinemeta primario + fallback entrambi appesi: termina alla deadline assoluta (300)", async () => {
    vi.useFakeTimers()
    try {
      const seen: string[] = []
      const captured: (AbortSignal | null | undefined)[] = []
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input)
          seen.push(url)
          captured.push(init?.signal ?? null)
          return hangingFetch(init?.signal ?? null)
        }),
      )

      const start = Date.now()
      const pending = fetchAggregatedRating("tt_route_budget300_hung", "k", undefined, {
        requestedSources: ["imdb"],
        ratingWaitMs: 300,
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(seen.some((u) => u.includes("/meta/"))).toBe(true)
      expect(seen.some((u) => u.includes("mdblist.com"))).toBe(false)
      await vi.advanceTimersByTimeAsync(179)
      expect(seen.some((u) => u.includes("mdblist.com"))).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(seen.some((u) => u.includes("mdblist.com"))).toBe(true)
      // Nessun provider risponde: il flusso abortisce alla deadline (300).
      await vi.advanceTimersByTimeAsync(120)
      const result = await pending
      const elapsed = Date.now() - start
      expect(result).toBeNull()
      expect(elapsed).toBeLessThanOrEqual(300)
      expect(captured.length).toBeGreaterThan(0)
      for (const s of captured) expect(s?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("MDBList primario appeso + fallback Cinemeta: fallback al 60% (600/1000) con residuo utilizzabile", async () => {
    vi.useFakeTimers()
    try {
      const seen: string[] = []
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input)
          seen.push(url)
          if (url.includes("mdblist.com")) return hangingFetch(init?.signal ?? null)
          if (url.includes("/meta/")) {
            // Il fallback consuma 200 dei 400ms residui: residuo utilizzabile.
            await abortableDelay(200, init?.signal ?? null)
            return okRatings({ meta: { imdbRating: "8.4" } })
          }
          throw new Error(`unexpected upstream ${url}`)
        }),
      )

      const start = Date.now()
      const pending = fetchAggregatedRating("tt_route_mdb_hang", "k", undefined, {
        requestedSources: ["imdb", "metacritic"],
        ratingWaitMs: 1000,
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(seen.some((u) => u.includes("mdblist.com"))).toBe(true)
      expect(seen.some((u) => u.includes("/meta/"))).toBe(false)
      // Prima del confine 60%: primario ancora pendente, nessun fallback.
      await vi.advanceTimersByTimeAsync(599)
      expect(seen.some((u) => u.includes("/meta/"))).toBe(false)
      // Al confine 60% (600ms) il fallback IMDb parte dopo l'abort del primario.
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(seen.some((u) => u.includes("/meta/"))).toBe(true)
      // Il fallback ritardato (200ms) completa a ~800ms: dentro la deadline.
      await vi.advanceTimersByTimeAsync(200)
      const result = await pending
      const elapsed = Date.now() - start
      // Fallback IMDb dopo abort del primario MDBList; metacritic resta
      // irrisolto (primario appeso), mai atteso oltre il budget.
      expect(result?.sources.imdb).toBe(8.4)
      expect(result?.sources.metacritic).toBeUndefined()
      expect(seen.some((u) => u.includes("mdblist.com"))).toBe(true)
      expect(seen.some((u) => u.includes("/meta/"))).toBe(true)
      expect(elapsed).toBeGreaterThanOrEqual(800)
      expect(elapsed).toBeLessThanOrEqual(1000)
    } finally {
      vi.useRealTimers()
    }
  })

  it("MDBList primario + fallback entrambi appesi: termina alla deadline assoluta (1000)", async () => {
    vi.useFakeTimers()
    try {
      const seen: string[] = []
      const captured: (AbortSignal | null | undefined)[] = []
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input)
          seen.push(url)
          captured.push(init?.signal ?? null)
          return hangingFetch(init?.signal ?? null)
        }),
      )

      const start = Date.now()
      const pending = fetchAggregatedRating("tt_route_mdb_hung", "k", undefined, {
        requestedSources: ["imdb", "metacritic"],
        ratingWaitMs: 1000,
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(seen.some((u) => u.includes("mdblist.com"))).toBe(true)
      expect(seen.some((u) => u.includes("/meta/"))).toBe(false)
      await vi.advanceTimersByTimeAsync(599)
      expect(seen.some((u) => u.includes("/meta/"))).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(seen.some((u) => u.includes("/meta/"))).toBe(true)
      // Nessun provider risponde: il flusso abortisce alla deadline (1000).
      await vi.advanceTimersByTimeAsync(400)
      const result = await pending
      const elapsed = Date.now() - start
      expect(result).toBeNull()
      expect(elapsed).toBeLessThanOrEqual(1000)
      expect(captured.length).toBeGreaterThan(0)
      for (const s of captured) expect(s?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("cleanupBudget abortisce il side upstream: signal laterale abortito al ritorno", async () => {
    const captured: (AbortSignal | null | undefined)[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes("mdblist.com")) return okRatings({ ratings: [{ source: "metacritic", value: 80, score: 80 }] })
        captured.push(init?.signal ?? null)
        return hangingFetch(init?.signal ?? null)
      }),
    )

    const result = await fetchAggregatedRating("tt_route_side_abort", "k", undefined, {
      simklKey: "test-simkl-key",
      tmdbId: 9999997,
      mediaType: "movie",
      requestedSources: ["metacritic", "simkl"],
      ratingWaitMs: 600,
    })
    expect(result?.sources.metacritic).toBe(8.0)
    expect(result?.sources.simkl).toBeUndefined()
    expect(captured.length).toBeGreaterThan(0)
    for (const s of captured) expect(s?.aborted).toBe(true)
  })

  it("fallback IMDb sequenziale non resta dietro i side provider appesi (simkl/anime)", async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input)
          if (url.includes("mdblist.com")) return okRatings({ ratings: [{ source: "tmdb", value: 70, score: 70 }] })
          if (url.includes("/meta/")) return okRatings({ meta: { imdbRating: "8.1" } })
          return hangingFetch(init?.signal ?? null)
        }),
      )

      const start = Date.now()
      const pending = fetchAggregatedRating("tt_route_nodelay", "k", undefined, {
        simklKey: "test-simkl-key",
        tmdbId: 9999998,
        mediaType: "movie",
        wantSimkl: true,
        wantAnilist: true,
        wantImdb: true,
        ratingWaitMs: 1200,
      })
      // Primario + fallback immediati, i side appesi vengono joinati col
      // residuo e abortiti alla deadline: mai oltre il budget assoluto.
      await vi.advanceTimersByTimeAsync(1200)
      const result = await pending
      const elapsed = Date.now() - start
      // imdb arriva dal fallback Cinemeta anche se simkl/anizip pendono.
      expect(result?.sources.imdb).toBe(8.1)
      expect(result?.sources.tmdb).toBe(7.0)
      expect(result?.sources.simkl).toBeUndefined()
      expect(elapsed).toBeLessThanOrEqual(1200)
    } finally {
      vi.useRealTimers()
    }
  })

  it("signal del chiamante abortito: esito null immediato, upstream abortito", async () => {
    const seenAborted: boolean[] = []
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenAborted.push(init?.signal?.aborted ?? false)
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError")
      return okRatings({ ratings: [{ source: "metacritic", value: 80, score: 80 }] })
    })
    vi.stubGlobal("fetch", fetchMock)
    const ctrl = new AbortController()
    ctrl.abort()

    const start = Date.now()
    const result = await fetchAggregatedRating("tt_route_cancel", "k", ctrl.signal, {
      requestedSources: ["metacritic"],
      ratingWaitMs: 1500,
    })
    expect(result).toBeNull()
    expect(Date.now() - start).toBeLessThan(500)
    // Lo strato grezzo non avvia mai upstream con subscriber già abortito
    // (nessun lavoro reale e niente cache avvelenata); se un fetch parte lo
    // fa solo sul signal owned, mai su quello del chiamante.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(seenAborted).toEqual([])
  })
})
