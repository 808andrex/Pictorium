import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  fetchAnimeRatings,
  resolveAnimeIds,
  __resetAnimeBreakers,
  __resetAnimeNullForTest,
} from "@/lib/anime-ratings"
import { fetchAggregatedRating } from "@/lib/ratings"
import { cacheClear, cacheHas } from "@/lib/cache"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

// Trasporto deterministico "gated" per i test di ownership (vedi
// cinemeta.test.ts): pendente finché non rilasciato; abort del signal ricevuto
// → AbortError. Registra se il proprio signal è stato abortito.
function gatedFetch() {
  const pending: Array<{ release: (body: unknown) => void; aborted: boolean }> = []
  const fn = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ?? undefined
    const record: { release: (body: unknown) => void; aborted: boolean } = {
      release: () => {},
      aborted: false,
    }
    const promise = new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        record.aborted = true
        reject(new DOMException("aborted", "AbortError"))
        return
      }
      const onAbort = () => {
        record.aborted = true
        reject(new DOMException("aborted", "AbortError"))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      record.release = (body: unknown) => {
        signal?.removeEventListener("abort", onAbort)
        resolve(jsonResponse(body))
      }
    })
    pending.push(record)
    return promise
  })
  return { fn, pending }
}

/** Flush deterministico di microtask (nessun timer, nessuno sleep). */
async function flushMicrotasks(ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve()
}

// Trasporto con barriera ESPLICITA sulla lettura del body. Le URL instradate a
// `immediate` risolvono subito; le altre tornano un Response con un
// ReadableStream REALE (abort → errore dello stream, come undici) la cui
// `json()` è avvolta: la barriera scatta SOLO quando la produzione invoca
// DAVVERO `res.json()`. NON si usa il `pull()` dello stream come prova: con
// l'highWaterMark di default (1) il pull può girare proattivamente anche senza
// un consumer, quindi non dimostrerebbe l'ingresso nel body.
// `awaitBodyEntered()` espone il record con `entered` (barriera) e `settled`
// (settle reale del body-read): i test attendono `settled` prima di asserire
// cache/stato, così non dipendono dall'ordine — l'abort del subscriber può
// risolvere l'owner PRIMA che il producer condiviso abbia completato.
function bodyBarrierFetch(immediate?: (url: string) => Response | null) {
  interface BodyRecord { entered: Promise<void>; settled: Promise<void> }
  const pending: BodyRecord[] = []
  const waiters: Array<(rec: BodyRecord) => void> = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const imm = immediate?.(url)
    if (imm) return imm
    const signal = init?.signal ?? undefined
    let resolveEntered!: () => void
    let resolveSettled!: () => void
    const entered = new Promise<void>((resolve) => { resolveEntered = resolve })
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve })
    const rec: BodyRecord = { entered, settled }
    const waiter = waiters.shift()
    if (waiter) waiter(rec)
    else pending.push(rec)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (signal?.aborted) {
          controller.error(new DOMException("aborted", "AbortError"))
          return
        }
        signal?.addEventListener(
          "abort",
          () => controller.error(new DOMException("aborted", "AbortError")),
          { once: true },
        )
      },
    })
    const res = new Response(stream, { headers: { "Content-Type": "application/json" } })
    const realJson = res.json.bind(res)
    res.json = () => {
      resolveEntered()
      const body = realJson()
      // Un hop in più della continuation dell'`await res.json()` di produzione:
      // `settled` è così garantito DOPO la gestione del body-read (l'await di
      // produzione registra la propria reaction dopo la nostra).
      body.then(() => {}, () => {}).then(() => resolveSettled())
      return body
    }
    return res
  })
  async function awaitBodyEntered(): Promise<BodyRecord> {
    const rec =
      pending.length > 0
        ? pending.shift()!
        : await new Promise<BodyRecord>((resolve) => { waiters.push(resolve) })
    // Barriera vera: il record esiste già alla creazione del Response, ma
    // `entered` risolve solo all'invocazione reale di `res.json()` da parte
    // della produzione. Restituire il record senza attendere `entered`
    // permetterebbe al test di abortire prima dell'ingresso nel body-read.
    await rec.entered
    return rec
  }
  return { fn, awaitBodyEntered }
}

// Sostituisce SOLO lo scheduler di timeout (`AbortSignal.timeout`) con un
// AbortController controllabile che registra i ms richiesti; combineAbortSignals
// e il controller posseduto restano quelli reali di produzione.
function stubTimeoutScheduler() {
  const timeouts: Array<{ ms: number; controller: AbortController }> = []
  const real = AbortSignal.timeout
  AbortSignal.timeout = ((ms: number) => {
    const controller = new AbortController()
    timeouts.push({ ms, controller })
    return controller.signal
  }) as typeof AbortSignal.timeout
  return {
    timeouts,
    restore: () => { AbortSignal.timeout = real },
  }
}

// Trasporto con abort "tardivo": all'abort registra `signalAborted` ma NON
// rifiuta subito; la rejection (AbortError) è consegnata quando il test chiama
// `fail(i)`. Modella un ordine legittimo (abort rispettato, rejection consegnata
// più tardi) in cui il settle del trasporto abbandonato arriva DOPO
// l'inserimento della entry sostitutiva: è l'ordine che stressa la guardia
// d'identità `map.get(key) === entry`.
function lateAbortFetch() {
  const records: Array<{ signalAborted: boolean; fail: () => void; release: (body: unknown) => void }> = []
  const fn = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ?? undefined
    let rejectFn!: (e: unknown) => void
    let resolveFn!: (r: Response) => void
    const promise = new Promise<Response>((resolve, reject) => { resolveFn = resolve; rejectFn = reject })
    const record = {
      signalAborted: false,
      fail: () => rejectFn(new DOMException("aborted", "AbortError")),
      release: (body: unknown) => resolveFn(jsonResponse(body)),
    }
    if (signal?.aborted) {
      record.signalAborted = true
      record.fail()
    } else {
      signal?.addEventListener("abort", () => { record.signalAborted = true }, { once: true })
    }
    records.push(record)
    return promise
  })
  return { fn, records }
}

describe("anime-ratings (AniZip + AniList + Kitsu)", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    __resetAnimeBreakers()
    __resetAnimeNullForTest()
    cacheClear()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("zero chiamate se nessuna fonte anime richiesta", async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy
    expect(await fetchAnimeRatings("tt1234567", {})).toBeNull()
    expect(await fetchAnimeRatings("tt1234567")).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("resolve via tmdbId dallo snapshot locale e fetch parallelo AniList + Kitsu", async () => {
    const seen: string[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      seen.push(url)
      if (url.includes("/mappings")) {
        return jsonResponse({ mappings: { anilist_id: 21, kitsu_id: 12 } })
      }
      if (url.includes("anilist") || url.includes("/graphql")) {
        return jsonResponse({ data: { Media: { id: 21, averageScore: 87 } } })
      }
      if (url.includes("/anime/12")) {
        return jsonResponse({ data: { attributes: { averageRating: "84.01" } } })
      }
      return new Response("Not found", { status: 404 })
    })

    // tmdb:37854 è unico nello snapshot locale → {21, 12} senza /mappings.
    const ids = await resolveAnimeIds("tt0388629", 37854)
    expect(ids).toEqual({ anilistId: 21, kitsuId: 12 })
    expect(seen.some((u) => u.includes("/mappings"))).toBe(false)

    const ratings = await fetchAnimeRatings("tt0388629", { tmdbId: 37854, wantAnilist: true, wantKitsu: true })
    expect(ratings).toEqual({ anilist: 8.7, kitsu: 8.4 })
    expect(seen.some((u) => u.includes("/mappings"))).toBe(false)
  })

  it("resolve via imdbId quando tmdbId assente", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/mappings")) {
        expect(url).toContain("imdb_id=tt1000000")
        return jsonResponse({ mappings: { anilist_id: 21, kitsu_id: null } })
      }
      if (url.includes("anilist") || url.includes("/graphql")) {
        return jsonResponse({ data: { Media: { averageScore: 90 } } })
      }
      return new Response("Not found", { status: 404 })
    })

    // tt1000000 non è nello snapshot locale → percorso AniZip invariato.
    const ratings = await fetchAnimeRatings("tt1000000", { wantAnilist: true, wantKitsu: true })
    // kitsu_id null → solo anilist, nessuna chiamata Kitsu sprecata
    expect(ratings).toEqual({ anilist: 9 })
  })

  it("fallback imdb quando il mapping tmdb fa 404", async () => {
    const seen: string[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      seen.push(url)
      if (url.includes("/mappings")) {
        if (url.includes("themoviedb_id=")) return new Response("not found", { status: 404 })
        return jsonResponse({ mappings: { anilist_id: 21, kitsu_id: null } })
      }
      if (url.includes("anilist") || url.includes("/graphql")) {
        return jsonResponse({ data: { Media: { averageScore: 88 } } })
      }
      return new Response("Not found", { status: 404 })
    })

    // tmdb:999999 e tt1000001 assenti dallo snapshot → AniZip come prima.
    const ratings = await fetchAnimeRatings("tt1000001", { tmdbId: 999999, wantAnilist: true })
    expect(ratings).toEqual({ anilist: 8.8 })
    expect(seen.filter((u) => u.includes("/mappings"))).toHaveLength(2)
  })

  it("404 AniZip (non-anime) → null + negativa senza breaker", async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls++
      return new Response("not found", { status: 404 })
    })

    expect(await fetchAnimeRatings("tt0137523", { tmdbId: 550, wantAnilist: true })).toBeNull()
    // tmdb 404 → fallback imdb 404: 2 chiamate, poi la negativa copre entrambe
    expect(calls).toBe(2)
    expect(await fetchAnimeRatings("tt0137523", { tmdbId: 550, wantAnilist: true })).toBeNull()
    expect(calls).toBe(2)
  })

  it("Media null / averageRating null → miss senza 500", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/mappings")) return jsonResponse({ mappings: { anilist_id: 21, kitsu_id: 12 } })
      if (url.includes("anilist") || url.includes("/graphql")) return jsonResponse({ data: { Media: null } })
      if (url.includes("/anime/12")) return jsonResponse({ data: { attributes: { averageRating: null } } })
      return new Response("Not found", { status: 404 })
    })

    expect(await fetchAnimeRatings("tt1", { tmdbId: 1, wantAnilist: true, wantKitsu: true })).toBeNull()
  })

  it("circuit breaker: 3 errori 500 consecutivi aprono il breaker (fail-open)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("Server error", { status: 500 }))

    expect(await fetchAnimeRatings("tt_f1", { tmdbId: "f1", wantAnilist: true })).toBeNull()
    expect(await fetchAnimeRatings("tt_f2", { tmdbId: "f2", wantAnilist: true })).toBeNull()
    expect(await fetchAnimeRatings("tt_f3", { tmdbId: "f3", wantAnilist: true })).toBeNull()

    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy
    expect(await fetchAnimeRatings("tt_f4", { tmdbId: "f4", wantAnilist: true })).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("integrazione fetchAggregatedRating: popola sources.anilist/kitsu", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("mdblist.com")) {
        return jsonResponse({ score: 80, ratings: [{ source: "imdb", value: 85, score: 85 }] })
      }
      if (url.includes("/mappings")) return jsonResponse({ mappings: { anilist_id: 21, kitsu_id: 12 } })
      if (url.includes("anilist") || url.includes("/graphql")) {
        return jsonResponse({ data: { Media: { averageScore: 87 } } })
      }
      if (url.includes("/anime/12")) return jsonResponse({ data: { attributes: { averageRating: "84.01" } } })
      return new Response("Not found", { status: 404 })
    })

    const aggregated = await fetchAggregatedRating("tt_anime_agg", "fake-mdb-key", undefined, {
      tmdbId: 37854,
      wantAnilist: true,
      wantKitsu: true,
    })

    expect(aggregated).not.toBeNull()
    expect(aggregated?.sources.imdb).toBe(8.5)
    expect(aggregated?.sources.anilist).toBe(8.7)
    expect(aggregated?.sources.kitsu).toBe(8.4)
  })

  it("fetchAggregatedRating senza flag anime: nessuna chiamata AniZip", async () => {
    const seen: string[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      seen.push(url)
      if (url.includes("mdblist.com")) return jsonResponse({ ratings: [{ source: "imdb", value: 85, score: 85 }] })
      return new Response("Not found", { status: 404 })
    })

    const aggregated = await fetchAggregatedRating("tt_noanime", "k", undefined, { tmdbId: 550 })
    expect(aggregated?.sources.anilist).toBeUndefined()
    expect(seen.some((u) => u.includes("ani.zip") || u.includes("/mappings"))).toBe(false)
  })

  // --- Ownership del trasporto coalesced (owner/waiter, no secondo upstream) ---

  it("AniZip owner abort non degrada un waiter vivo (un solo upstream)", async () => {
    const t = gatedFetch()
    globalThis.fetch = t.fn as unknown as typeof fetch

    const ownerCtrl = new AbortController()
    const waiterCtrl = new AbortController()
    const owner = resolveAnimeIds("tt_az_1", 999901, ownerCtrl.signal, "movie")
    const waiter = resolveAnimeIds("tt_az_1", 999901, waiterCtrl.signal, "movie")
    expect(t.fn).toHaveBeenCalledTimes(1)

    ownerCtrl.abort()
    await expect(owner).resolves.toBeNull()

    expect(t.pending[0].aborted).toBe(false)
    t.pending[0].release({ mappings: { anilist_id: 21, kitsu_id: 12 } })
    await expect(waiter).resolves.toEqual({ anilistId: 21, kitsuId: 12 })
    expect(t.fn).toHaveBeenCalledTimes(1)
  })

  it("AniZip waiter abort esce subito (non più ostaggio); il trasporto resta vivo per l'owner", async () => {
    const t = gatedFetch()
    globalThis.fetch = t.fn as unknown as typeof fetch

    const ownerCtrl = new AbortController()
    const waiterCtrl = new AbortController()
    const owner = resolveAnimeIds("tt_az_2", 999902, ownerCtrl.signal, "movie")
    let waiterSettled = false
    const waiter = resolveAnimeIds("tt_az_2", 999902, waiterCtrl.signal, "movie").finally(() => {
      waiterSettled = true
    })
    expect(t.fn).toHaveBeenCalledTimes(1)

    waiterCtrl.abort()
    await flushMicrotasks(50)
    // Il waiter esce sul proprio budget (prima era ostaggio del trasporto).
    expect(waiterSettled).toBe(true)
    expect(t.pending[0].aborted).toBe(false)

    t.pending[0].release({ mappings: { anilist_id: 21, kitsu_id: 12 } })
    await expect(waiter).resolves.toBeNull()
    await expect(owner).resolves.toEqual({ anilistId: 21, kitsuId: 12 })
    expect(t.fn).toHaveBeenCalledTimes(1)
  })

  it("AniZip subscriber senza signal tiene vivo il trasporto condiviso", async () => {
    const t = gatedFetch()
    globalThis.fetch = t.fn as unknown as typeof fetch

    const ownerCtrl = new AbortController()
    const owner = resolveAnimeIds("tt_az_3", 999903, ownerCtrl.signal, "movie")
    // Stessa chiave inflight (stesso lato): nessun signal = trasporto tenuto vivo.
    const survivor = resolveAnimeIds("tt_az_3", 999903, undefined, "movie")
    expect(t.fn).toHaveBeenCalledTimes(1)

    ownerCtrl.abort()
    await expect(owner).resolves.toBeNull()
    expect(t.pending[0].aborted).toBe(false)

    t.pending[0].release({ mappings: { anilist_id: 5, kitsu_id: 6 } })
    await expect(survivor).resolves.toEqual({ anilistId: 5, kitsuId: 6 })
    expect(t.fn).toHaveBeenCalledTimes(1)
  })

  it("AniZip: chiamante già cancellato non avvia upstream", async () => {
    const t = gatedFetch()
    globalThis.fetch = t.fn as unknown as typeof fetch

    const ctrl = new AbortController()
    ctrl.abort()
    await expect(resolveAnimeIds("tt_az_4", 999904, ctrl.signal, "movie")).resolves.toBeNull()
    expect(t.fn).not.toHaveBeenCalled()
  })

  it("AniZip: zero subscriber abortisce il trasporto reale; late join fresco e il settle tardivo NON cancella la entry nuova", async () => {
    const t = lateAbortFetch()
    globalThis.fetch = t.fn as unknown as typeof fetch

    const c1 = new AbortController()
    const c2 = new AbortController()
    const a = resolveAnimeIds("tt_az_6", 999906, c1.signal, "movie")
    const b = resolveAnimeIds("tt_az_6", 999906, c2.signal, "movie")
    expect(t.fn).toHaveBeenCalledTimes(1)

    c1.abort()
    await expect(a).resolves.toBeNull()
    // Il solo abort dell'owner NON spegne il trasporto del waiter.
    expect(t.records[0].signalAborted).toBe(false)

    c2.abort()
    await expect(b).resolves.toBeNull()
    // Zero subscriber → il controller posseduto abortisce il trasporto reale.
    expect(t.records[0].signalAborted).toBe(true)

    // Late join: nuova entry, upstream fresco — PRIMA che il vecchio trasporto
    // consegni la propria rejection di abort.
    const fresh = resolveAnimeIds("tt_az_6", 999906, undefined, "movie")
    expect(t.fn).toHaveBeenCalledTimes(2)

    // Il trasporto abbandonato consegna ORA la rejection: il suo settle tardivo
    // non deve cancellare la entry sostitutiva.
    t.records[0].fail()
    await flushMicrotasks(20)

    // Prova d'identità: un ulteriore join coalesce ancora sulla entry nuova
    // (nessun terzo upstream) → la guardia `map.get(key) === entry` regge.
    const joiner = resolveAnimeIds("tt_az_6", 999906, undefined, "movie")
    expect(t.fn).toHaveBeenCalledTimes(2)

    t.records[1].release({ mappings: { anilist_id: 21, kitsu_id: 12 } })
    await expect(fresh).resolves.toEqual({ anilistId: 21, kitsuId: 12 })
    await expect(joiner).resolves.toEqual({ anilistId: 21, kitsuId: 12 })
    expect(t.fn).toHaveBeenCalledTimes(2)
  })

  it("abort durante la lettura body AniZip: barriera body-entered; nessuna negativa né write di cache dal trasporto abbandonato", async () => {
    const h = bodyBarrierFetch(() => null)
    globalThis.fetch = h.fn as unknown as typeof fetch

    const ctrl = new AbortController()
    const owner = resolveAnimeIds("tt_az_5", 999905, ctrl.signal, "movie")
    // Barriera esplicita: la produzione ha invocato DAVVERO res.json() (non un
    // pull proattivo dello stream); l'owner è quindi entrato nel ramo body-read.
    const body = await h.awaitBodyEntered()
    ctrl.abort()
    await expect(owner).resolves.toBeNull()
    // Attende il settle reale del body-read: l'owner può risolvere null PRIMA
    // che il producer condiviso abbia completato il ramo di abort (niente
    // asserzioni prima della sua completion).
    await body.settled

    // Il trasporto abbandonato (owned abortito) non scrive né cache positiva
    // (chiave tmdb del primo tentativo) né negativa.
    expect(cacheHas("anime:map:tmdb:movie:999905")).toBe(false)

    const spy = vi.fn(async () => jsonResponse({ mappings: { anilist_id: 21, kitsu_id: 12 } }))
    globalThis.fetch = spy as unknown as typeof fetch
    // Stessa chiave (stesso lato) del primo tentativo: nessuna negativa residua.
    await expect(resolveAnimeIds("tt_az_5", 999905, undefined, "movie")).resolves.toEqual({
      anilistId: 21,
      kitsuId: 12,
    })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  // --- Timeout interno owned: bound preservato anche con subscriber vivo ---

  it("AniZip: il timeout interno (ANIME_TIMEOUT_MS) abortisce il trasporto anche con un subscriber senza signal", async () => {
    const ts = stubTimeoutScheduler()
    try {
      const t = gatedFetch()
      globalThis.fetch = t.fn as unknown as typeof fetch

      // Nessun signal del chiamante: il subscriber resta vivo, ma il timeout
      // interno deve comunque scattare (mai aggirabile da un subscriber vivo).
      const owner = resolveAnimeIds("tt_az_to", 999920, undefined, "movie")
      expect(ts.timeouts).toHaveLength(1)
      expect(ts.timeouts[0].ms).toBe(1200)

      // Deadline owned: abort del SOLO signal di timeout (owned ancora vivo).
      ts.timeouts[0].controller.abort()
      await expect(owner).resolves.toBeNull()
      expect(t.pending[0].aborted).toBe(true)
    } finally {
      ts.restore()
    }
  })

  it("AniZip: il timeout interno conta come failure del breaker; la cancellazione no", async () => {
    const ts = stubTimeoutScheduler()
    try {
      const t = gatedFetch()
      globalThis.fetch = t.fn as unknown as typeof fetch

      // 3 timeout di trasporto (header mai arrivati) → 3 failure → breaker aperto.
      for (const id of ["a", "b", "c"]) {
        const p = resolveAnimeIds(`tt_to_${id}`, undefined, undefined, undefined)
        expect(ts.timeouts.at(-1)?.ms).toBe(1200)
        ts.timeouts.at(-1)!.controller.abort()
        await expect(p).resolves.toBeNull()
      }
      const beforeOpen = t.fn.mock.calls.length
      await expect(resolveAnimeIds("tt_to_d", undefined, undefined, undefined)).resolves.toBeNull()
      // Breaker aperto: nessun nuovo upstream (fail-open).
      expect(t.fn.mock.calls.length).toBe(beforeOpen)
    } finally {
      ts.restore()
    }
  })

  it("AniZip: la cancellazione (owned abortito a zero subscriber) NON conta come failure del breaker", async () => {
    const t = gatedFetch()
    globalThis.fetch = t.fn as unknown as typeof fetch

    // 3 cancellazioni → 0 failure → breaker ancora chiuso.
    for (const id of ["x", "y", "z"]) {
      const ctrl = new AbortController()
      const p = resolveAnimeIds(`tt_cx_${id}`, undefined, ctrl.signal, undefined)
      ctrl.abort()
      await expect(p).resolves.toBeNull()
    }

    const before = t.fn.mock.calls.length
    const p = resolveAnimeIds("tt_cx_w", undefined, undefined, undefined)
    // Breaker chiuso: parte un nuovo upstream.
    expect(t.fn.mock.calls.length).toBe(before + 1)
    t.pending.at(-1)!.release({ mappings: { anilist_id: 7, kitsu_id: null } })
    await expect(p).resolves.toEqual({ anilistId: 7, kitsuId: null })
  })

  it("AniZip: 200 header + timeout del body NON accumula failure (recordSuccess pre-body) — comportamento attuale", async () => {
    // Caratterizzazione della policy ESISTENTE (non un requisito): il
    // recordSuccess() dopo gli header riazzera i failure, quindi un timeout in
    // lettura body vale al più 1 failure per chiamata → dopo 3 body-timeout il
    // breaker resta CHIUSO. Documentato: il breaker NON scatta sui body-timeout
    // con header 200; non viene modificato (nessun fix speculativo).
    const ts = stubTimeoutScheduler()
    try {
      const h = bodyBarrierFetch(() => null)
      globalThis.fetch = h.fn as unknown as typeof fetch

      for (const id of ["b1", "b2", "b3"]) {
        const p = resolveAnimeIds(`tt_bt_${id}`, undefined, undefined, undefined)
        // Barriera esplicita: la produzione ha invocato DAVVERO res.json()
        // (recordSuccess precede sincronicamente json()).
        const body = await h.awaitBodyEntered()
        ts.timeouts.at(-1)!.controller.abort()
        await expect(p).resolves.toBeNull()
        await body.settled
      }

      const before = h.fn.mock.calls.length
      const p4 = resolveAnimeIds("tt_bt_b4", undefined, undefined, undefined)
      // Breaker ancora chiuso → nuovo upstream.
      expect(h.fn.mock.calls.length).toBe(before + 1)
      const body4 = await h.awaitBodyEntered()
      ts.timeouts.at(-1)!.controller.abort()
      await expect(p4).resolves.toBeNull()
      await body4.settled
    } finally {
      ts.restore()
    }
  })

  // --- Rating coalescing AniList/Kitsu (chiave = id, indipendente dal mapping) ---

  it("AniList: chiavi mapping diverse sullo stesso id coalescono; l'abort dell'owner non degrada il waiter vivo (id diversi restano indipendenti)", async () => {
    const mappings: string[] = []
    const anilistCalls: string[] = []
    const gates = new Map<string, (r: Response) => void>()
    // Stato del trasporto rating per id (abort reale del signal → prova).
    const transport = new Map<string, { aborted: boolean }>()
    // Gate espliciti sull'invocazione del rating (risolti sincronicamente dal
    // mock): niente assunzioni su scheduler-depth per la creazione delle entry.
    let rating41Created!: () => void
    let rating42Created!: () => void
    const rating41 = new Promise<void>((r) => { rating41Created = r })
    const rating42 = new Promise<void>((r) => { rating42Created = r })
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/mappings")) {
        mappings.push(url)
        if (url.includes("themoviedb_id=al_mapA") || url.includes("themoviedb_id=al_mapB")) {
          return jsonResponse({ mappings: { anilist_id: 41, kitsu_id: null } })
        }
        if (url.includes("themoviedb_id=al_mapC")) {
          return jsonResponse({ mappings: { anilist_id: 42, kitsu_id: null } })
        }
        return new Response("nf", { status: 404 })
      }
      if (url.includes("anilist") || url.includes("/graphql")) {
        const id = String((JSON.parse(String(init?.body)) as { variables: { id: number } }).variables.id)
        anilistCalls.push(id)
        const rec = { aborted: false }
        transport.set(id, rec)
        init?.signal?.addEventListener("abort", () => { rec.aborted = true }, { once: true })
        if (id === "41") rating41Created()
        if (id === "42") rating42Created()
        return new Promise<Response>((resolve) => { gates.set(id, resolve) })
      }
      return new Response("nf", { status: 404 })
    })

    // L'owner (A) parte per primo: crea la entry rating 41 sul proprio budget.
    const cA = new AbortController()
    const a = fetchAnimeRatings("tt_al_A", { tmdbId: "al_mapA", wantAnilist: true, signal: cA.signal })
    await rating41
    expect(anilistCalls).toEqual(["41"])

    // B (chiave mapping diversa, STESSO id) si accoda; C (id diverso) è indipendente.
    const cB = new AbortController()
    const b = fetchAnimeRatings("tt_al_B", { tmdbId: "al_mapB", wantAnilist: true, signal: cB.signal })
    const c = fetchAnimeRatings("tt_al_C", { tmdbId: "al_mapC", wantAnilist: true })
    await rating42
    // Join di B: non è osservabile dal mock (coalescing = nessuna fetch); il
    // settle qui è bounded, la PROVA del join è l'asserzione sul trasporto che
    // resta vivo dopo l'abort dell'owner.
    await flushMicrotasks(20)

    // Chiavi mapping distinte → upstream mapping distinti (host /mappings).
    expect(mappings).toHaveLength(3)
    // Rating keyed per id AniList: A e B (stesso id 41) condividono UN upstream
    // AniList; C (id 42) è indipendente. Host corretto: si conta solo AniList.
    expect(anilistCalls.filter((id) => id === "41")).toHaveLength(1)
    expect(anilistCalls.filter((id) => id === "42")).toHaveLength(1)

    // Abort dell'owner DOPO il join: il waiter B tiene vivo il trasporto gated.
    cA.abort()
    await expect(a).resolves.toBeNull()
    expect(transport.get("41")!.aborted).toBe(false)

    // Indipendenza: l'upstream 42 non tocca A/B e viceversa.
    gates.get("42")!(jsonResponse({ data: { Media: { averageScore: 93 } } }))
    await expect(c).resolves.toEqual({ anilist: 9.3 })
    expect(transport.get("41")!.aborted).toBe(false)

    // Il live waiter riceve il valore; un solo upstream rating per l'id 41.
    gates.get("41")!(jsonResponse({ data: { Media: { averageScore: 88 } } }))
    await expect(b).resolves.toEqual({ anilist: 8.8 })
    expect(anilistCalls.filter((id) => id === "41")).toHaveLength(1)
  })

  it("Kitsu: chiavi mapping diverse sullo stesso id coalescono; l'abort dell'owner non degrada il waiter vivo", async () => {
    const kitsuCalls: string[] = []
    const gates = new Map<string, (r: Response) => void>()
    const transport = new Map<string, { aborted: boolean }>()
    let ratingCreated!: () => void
    const ratingCalled = new Promise<void>((r) => { ratingCreated = r })
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/mappings")) {
        if (url.includes("themoviedb_id=kt_mapA") || url.includes("themoviedb_id=kt_mapB")) {
          return jsonResponse({ mappings: { anilist_id: null, kitsu_id: 61 } })
        }
        return new Response("nf", { status: 404 })
      }
      if (url.includes("/anime/")) {
        const id = url.split("/anime/")[1]
        kitsuCalls.push(id)
        const rec = { aborted: false }
        transport.set(id, rec)
        init?.signal?.addEventListener("abort", () => { rec.aborted = true }, { once: true })
        ratingCreated()
        return new Promise<Response>((resolve) => { gates.set(id, resolve) })
      }
      return new Response("nf", { status: 404 })
    })

    // Owner (A) per primo: crea la entry rating 61.
    const cA = new AbortController()
    const a = fetchAnimeRatings("tt_kt_A", { tmdbId: "kt_mapA", wantKitsu: true, signal: cA.signal })
    await ratingCalled
    expect(kitsuCalls.filter((id) => id.startsWith("61"))).toHaveLength(1)

    // B (chiave mapping diversa, stesso id 61) si accoda.
    const cB = new AbortController()
    const b = fetchAnimeRatings("tt_kt_B", { tmdbId: "kt_mapB", wantKitsu: true, signal: cB.signal })
    // Settle bounded del join (non osservabile dal mock); la prova è la
    // sopravvivenza del trasporto dopo l'abort dell'owner.
    await flushMicrotasks(20)

    cA.abort()
    await expect(a).resolves.toBeNull()
    expect(transport.get("61")!.aborted).toBe(false)

    gates.get("61")!(jsonResponse({ data: { attributes: { averageRating: "84.01" } } }))
    await expect(b).resolves.toEqual({ kitsu: 8.4 })
    expect(kitsuCalls.filter((id) => id.startsWith("61"))).toHaveLength(1)
  })

  it("AniList: abort in lettura body → nessuna negativa (barriera body-entered)", async () => {
    const h = bodyBarrierFetch((url) =>
      url.includes("/mappings") ? jsonResponse({ mappings: { anilist_id: 51, kitsu_id: null } }) : null,
    )
    globalThis.fetch = h.fn as unknown as typeof fetch

    const ctrl = new AbortController()
    const owner = fetchAnimeRatings("tt_al_body", {
      tmdbId: "al_body",
      wantAnilist: true,
      signal: ctrl.signal,
    })
    // Barriera esplicita: la produzione ha invocato DAVVERO res.json() del
    // trasporto rating (ramo body-read, non un fetch-abort pre-header).
    const body = await h.awaitBodyEntered()
    ctrl.abort()
    await expect(owner).resolves.toBeNull()
    // Completion del producer prima di asserire lo stato cache.
    await body.settled

    // Nessuna cache positiva scritta per la chiave rating AniList.
    expect(cacheHas("anime:rating:anilist:51")).toBe(false)

    const spy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/mappings")) return jsonResponse({ mappings: { anilist_id: 51, kitsu_id: null } })
      if (url.includes("anilist") || url.includes("/graphql")) {
        return jsonResponse({ data: { Media: { averageScore: 90 } } })
      }
      return new Response("nf", { status: 404 })
    })
    globalThis.fetch = spy as unknown as typeof fetch
    await expect(
      fetchAnimeRatings("tt_al_body", { tmdbId: "al_body", wantAnilist: true }),
    ).resolves.toEqual({ anilist: 9 })
    expect(spy.mock.calls.some(([u]) => String(u).includes("anilist"))).toBe(true)
  })

  it("Kitsu: abort in lettura body → nessuna negativa (barriera body-entered)", async () => {
    const h = bodyBarrierFetch((url) =>
      url.includes("/mappings") ? jsonResponse({ mappings: { anilist_id: null, kitsu_id: 61 } }) : null,
    )
    globalThis.fetch = h.fn as unknown as typeof fetch

    const ctrl = new AbortController()
    const owner = fetchAnimeRatings("tt_kt_body", {
      tmdbId: "kt_body",
      wantKitsu: true,
      signal: ctrl.signal,
    })
    // Barriera esplicita: res.json() del trasporto rating realmente invocato.
    const body = await h.awaitBodyEntered()
    ctrl.abort()
    await expect(owner).resolves.toBeNull()
    await body.settled

    expect(cacheHas("anime:rating:kitsu:61")).toBe(false)

    const spy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/mappings")) return jsonResponse({ mappings: { anilist_id: null, kitsu_id: 61 } })
      if (url.includes("/anime/")) return jsonResponse({ data: { attributes: { averageRating: "85.01" } } })
      return new Response("nf", { status: 404 })
    })
    globalThis.fetch = spy as unknown as typeof fetch
    await expect(
      fetchAnimeRatings("tt_kt_body", { tmdbId: "kt_body", wantKitsu: true }),
    ).resolves.toEqual({ kitsu: 8.5 })
    expect(spy.mock.calls.some(([u]) => String(u).includes("/anime/"))).toBe(true)
  })
})
