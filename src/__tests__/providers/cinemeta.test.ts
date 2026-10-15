import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { fetchCinemetaRating, __resetCinemetaBreaker, __resetCinemetaNullForTest } from "@/lib/cinemeta"
import { fetchAggregatedRating } from "@/lib/ratings"
import { cacheClear, cacheHas } from "@/lib/cache"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

// Trasporto deterministico "gated" per i test di ownership: resta pendente
// finché non è rilasciato esplicitamente; se il signal ricevuto abortisce
// prima, rifiuta con un AbortError (come una fetch reale abortita prima degli
// header). Registra se il proprio signal è stato abortito (cancellazione reale).
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

// Trasporto con barriera ESPLICITA sulla lettura del body: `immediate` decide
// se una URL risolve subito; le altre tornano un Response con un
// ReadableStream REALE (abort → errore dello stream) la cui `json()` è avvolta:
// la barriera scatta SOLO quando la produzione invoca DAVVERO `res.json()`.
// NON si usa il `pull()` dello stream come prova: con l'highWaterMark di default
// (1) il pull può girare proattivamente anche senza un consumer.
// `awaitBodyEntered()` espone `entered` (barriera) e `settled` (settle reale del
// body-read): i test attendono `settled` prima di asserire cache/stato, così non
// dipendono dall'ordine (l'abort del subscriber può risolvere l'owner prima che
// il producer condiviso abbia completato).
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
      // `settled` è così garantito DOPO la gestione del body-read.
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
// `fail(i)`. Modella un ordine legittimo in cui il settle del trasporto
// abbandonato arriva DOPO l'inserimento della entry sostitutiva: è l'ordine che
// stressa la guardia d'identità `map.get(key) === entry`.
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

describe("cinemeta (voto IMDb gratis senza chiave)", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    __resetCinemetaBreaker()
    __resetCinemetaNullForTest()
    cacheClear()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("null senza imdbId e senza rete", async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy
    expect(await fetchCinemetaRating(null)).toBeNull()
    expect(await fetchCinemetaRating("")).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("parsa meta.imdbRating stringa su tipo primario", async () => {
    const seen: string[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      seen.push(url)
      return jsonResponse({ meta: { id: "tt0111161", type: "movie", name: "X", imdbRating: "9.3" } })
    })

    expect(await fetchCinemetaRating("tt0111161", "movie")).toBe(9.3)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain("/meta/movie/tt0111161.json")
  })

  it("tv/series → route series; miss sul primario prova il secondario", async () => {
    const seen: string[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      seen.push(url)
      if (url.includes("/meta/series/")) return jsonResponse({ meta: {} })
      return jsonResponse({ meta: { imdbRating: "8.1" } })
    })

    expect(await fetchCinemetaRating("tt1", "tv")).toBe(8.1)
    expect(seen[0]).toContain("/meta/series/tt1.json")
    expect(seen[1]).toContain("/meta/movie/tt1.json")
  })

  it("meta vuoto su entrambi i tipi → miss + negativa", async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls++
      return jsonResponse({ meta: {} })
    })

    expect(await fetchCinemetaRating("tt0000000", "movie")).toBeNull()
    expect(calls).toBe(2)
    expect(await fetchCinemetaRating("tt0000000", "movie")).toBeNull()
    expect(calls).toBe(2)
  })

  it("transient (500) → niente fallback sull'altro tipo", async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls++
      return new Response("err", { status: 500 })
    })

    expect(await fetchCinemetaRating("tt2", "movie")).toBeNull()
    expect(calls).toBe(1)
  })

  it("circuit breaker: 3 errori 500 aprono il breaker (fail-open)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("err", { status: 500 }))

    expect(await fetchCinemetaRating("tt_b1", "movie")).toBeNull()
    expect(await fetchCinemetaRating("tt_b2", "movie")).toBeNull()
    expect(await fetchCinemetaRating("tt_b3", "movie")).toBeNull()

    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy
    expect(await fetchCinemetaRating("tt_b4", "movie")).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("integrazione: MDBList senza imdb + wantImdb → backfill Cinemeta", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("mdblist.com")) {
        return jsonResponse({ ratings: [{ source: "tmdb", value: 80, score: 80 }] })
      }
      if (url.includes("/meta/movie/")) {
        return jsonResponse({ meta: { imdbRating: "8.4" } })
      }
      return new Response("Not found", { status: 404 })
    })

    const aggregated = await fetchAggregatedRating("tt_ci1", "k", undefined, {
      wantImdb: true,
    })
    expect(aggregated?.sources.imdb).toBe(8.4)
    expect(aggregated?.sources.tmdb).toBe(8.0)
  })

  it("MDBList con imdb → Cinemeta mai chiamato (zero overhead)", async () => {
    const seen: string[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      seen.push(url)
      if (url.includes("mdblist.com")) {
        return jsonResponse({ ratings: [{ source: "imdb", value: 85, score: 85 }] })
      }
      return jsonResponse({ meta: { imdbRating: "9.9" } })
    })

    const aggregated = await fetchAggregatedRating("tt_ci2", "k", undefined, { wantImdb: true })
    expect(aggregated?.sources.imdb).toBe(8.5)
    expect(seen.some((u) => u.includes("/meta/"))).toBe(false)
  })

  it("waiter coalesced abortito: esce subito, il trasporto condiviso resta vivo", async () => {
    let release!: (v: Response) => void
    const gate = new Promise<Response>((resolve) => { release = resolve })
    globalThis.fetch = vi.fn(async () => gate)
    const owner = fetchCinemetaRating("tt_wait_abort", "movie")
    const waiterCtrl = new AbortController()
    const waiter = fetchCinemetaRating("tt_wait_abort", "movie", waiterCtrl.signal)
    waiterCtrl.abort()
    await expect(waiter).rejects.toSatisfy((e) => e instanceof DOMException || e instanceof Error)
    release(jsonResponse({ meta: { imdbRating: "8.8" } }))
    await expect(owner).resolves.toBe(8.8)
  })

  // --- Ownership del trasporto coalesced (owner/waiter, no secondo upstream) ---

  it("owner abort non degrada un waiter coalesced vivo (un solo upstream)", async () => {
    const t = gatedFetch()
    globalThis.fetch = t.fn as unknown as typeof fetch

    const ownerCtrl = new AbortController()
    const waiterCtrl = new AbortController()
    const owner = fetchCinemetaRating("tt_own_1", "movie", ownerCtrl.signal)
    const waiter = fetchCinemetaRating("tt_own_1", "movie", waiterCtrl.signal)
    expect(t.fn).toHaveBeenCalledTimes(1)

    // L'owner cancella il proprio budget: esce subito con esito transiente.
    ownerCtrl.abort()
    await expect(owner).resolves.toBeNull()

    // Il trasporto condiviso resta vivo per il waiter (nessuna seconda fetch).
    expect(t.pending[0].aborted).toBe(false)
    t.pending[0].release({ meta: { imdbRating: "8.8" } })
    await expect(waiter).resolves.toBe(8.8)
    expect(t.fn).toHaveBeenCalledTimes(1)
  })

  it("il trasporto è abortito solo a zero subscriber; un late join riparte fresco", async () => {
    const t = gatedFetch()
    globalThis.fetch = t.fn as unknown as typeof fetch

    const c1 = new AbortController()
    const c2 = new AbortController()
    const a = fetchCinemetaRating("tt_own_2", "movie", c1.signal)
    const b = fetchCinemetaRating("tt_own_2", "movie", c2.signal)
    expect(t.fn).toHaveBeenCalledTimes(1)

    c1.abort()
    await expect(a).resolves.toBeNull()
    // Il solo abort dell'owner NON deve spegnere il trasporto del waiter.
    expect(t.pending[0].aborted).toBe(false)

    c2.abort()
    await expect(b).rejects.toSatisfy((e) => e instanceof DOMException || e instanceof Error)
    // Zero subscriber → il controller posseduto abortisce il trasporto reale.
    expect(t.pending[0].aborted).toBe(true)

    // Late join dopo lo svuotamento: nuova entry, upstream fresco.
    const fresh = fetchCinemetaRating("tt_own_2", "movie")
    expect(t.fn).toHaveBeenCalledTimes(2)
    t.pending[1].release({ meta: { imdbRating: "9.1" } })
    await expect(fresh).resolves.toBe(9.1)
  })

  it("il settle tardivo del trasporto abbandonato NON cancella la entry sostitutiva (identità)", async () => {
    const t = lateAbortFetch()
    globalThis.fetch = t.fn as unknown as typeof fetch

    const c1 = new AbortController()
    const c2 = new AbortController()
    const a = fetchCinemetaRating("tt_own_6", "movie", c1.signal)
    const b = fetchCinemetaRating("tt_own_6", "movie", c2.signal)
    expect(t.fn).toHaveBeenCalledTimes(1)

    c1.abort()
    await expect(a).resolves.toBeNull()
    expect(t.records[0].signalAborted).toBe(false)

    c2.abort()
    await expect(b).rejects.toSatisfy((e) => e instanceof DOMException || e instanceof Error)
    // Zero subscriber → abort reale del trasporto (owned), anche se la rejection
    // viene consegnata più tardi.
    expect(t.records[0].signalAborted).toBe(true)

    // Entry sostitutiva PRIMA che il vecchio trasporto consegni la rejection.
    const fresh = fetchCinemetaRating("tt_own_6", "movie")
    expect(t.fn).toHaveBeenCalledTimes(2)

    // Il settle tardivo del vecchio non deve cancellare la entry nuova.
    t.records[0].fail()
    await flushMicrotasks(20)

    // Un join deve coalescere sulla entry nuova (nessun terzo upstream).
    const joiner = fetchCinemetaRating("tt_own_6", "movie")
    expect(t.fn).toHaveBeenCalledTimes(2)

    t.records[1].release({ meta: { imdbRating: "9.1" } })
    await expect(fresh).resolves.toBe(9.1)
    await expect(joiner).resolves.toBe(9.1)
    expect(t.fn).toHaveBeenCalledTimes(2)
  })

  it("un subscriber senza signal tiene vivo il trasporto condiviso", async () => {
    const t = gatedFetch()
    globalThis.fetch = t.fn as unknown as typeof fetch

    const ownerCtrl = new AbortController()
    const owner = fetchCinemetaRating("tt_own_3", "movie", ownerCtrl.signal)
    const survivor = fetchCinemetaRating("tt_own_3", "movie")
    expect(t.fn).toHaveBeenCalledTimes(1)

    ownerCtrl.abort()
    await expect(owner).resolves.toBeNull()
    expect(t.pending[0].aborted).toBe(false)

    t.pending[0].release({ meta: { imdbRating: "7.7" } })
    await expect(survivor).resolves.toBe(7.7)
    expect(t.fn).toHaveBeenCalledTimes(1)
  })

  it("chiamante già cancellato: nessun upstream avviato", async () => {
    const t = gatedFetch()
    globalThis.fetch = t.fn as unknown as typeof fetch

    const ctrl = new AbortController()
    ctrl.abort()
    await expect(fetchCinemetaRating("tt_own_4", "movie", ctrl.signal)).resolves.toBeNull()
    expect(t.fn).not.toHaveBeenCalled()
  })

  it("abort durante la lettura del body: barriera body-entered; nessuna negativa né write di cache dal trasporto abbandonato", async () => {
    const h = bodyBarrierFetch(() => null)
    globalThis.fetch = h.fn as unknown as typeof fetch

    const ctrl = new AbortController()
    const owner = fetchCinemetaRating("tt_own_5", "movie", ctrl.signal)
    // Barriera esplicita: la produzione ha invocato DAVVERO res.json() (ramo
    // body-read, non un fetch-abort pre-header: nessun pull proattivo).
    const body = await h.awaitBodyEntered()
    ctrl.abort()
    await expect(owner).resolves.toBeNull()
    // Completion del body-read PRIMA di asserire lo stato cache (l'owner può
    // risolvere null prima che il producer condiviso abbia finito).
    await body.settled

    // Il trasporto abbandonato non scrive la cache positiva della propria chiave.
    expect(cacheHas("cinemeta:rating:movie:tt_own_5")).toBe(false)

    // Follow-up pulito: se la chiave non è avvelenata torna in rete e riesce.
    const spy = vi.fn(async () => jsonResponse({ meta: { imdbRating: "8.8" } }))
    globalThis.fetch = spy as unknown as typeof fetch
    await expect(fetchCinemetaRating("tt_own_5", "movie")).resolves.toBe(8.8)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  // --- Timeout interno owned: bound preservato anche con subscriber vivo ---

  it("il timeout interno (CINEMETA_TIMEOUT_MS) abortisce il trasporto anche con un subscriber senza signal", async () => {
    const ts = stubTimeoutScheduler()
    try {
      const t = gatedFetch()
      globalThis.fetch = t.fn as unknown as typeof fetch

      const owner = fetchCinemetaRating("tt_own_to", "movie")
      expect(ts.timeouts).toHaveLength(1)
      expect(ts.timeouts[0].ms).toBe(1500)

      ts.timeouts[0].controller.abort()
      await expect(owner).resolves.toBeNull()
      expect(t.pending[0].aborted).toBe(true)
    } finally {
      ts.restore()
    }
  })

  it("il timeout interno conta come failure del breaker; la cancellazione no", async () => {
    const ts = stubTimeoutScheduler()
    try {
      const t = gatedFetch()
      globalThis.fetch = t.fn as unknown as typeof fetch

      for (const id of ["a", "b", "c"]) {
        const p = fetchCinemetaRating(`tt_to_${id}`, "movie")
        expect(ts.timeouts.at(-1)?.ms).toBe(1500)
        ts.timeouts.at(-1)!.controller.abort()
        await expect(p).resolves.toBeNull()
      }
      const beforeOpen = t.fn.mock.calls.length
      await expect(fetchCinemetaRating("tt_to_d", "movie")).resolves.toBeNull()
      expect(t.fn.mock.calls.length).toBe(beforeOpen)
    } finally {
      ts.restore()
    }
  })

  it("la cancellazione (owned abortito a zero subscriber) NON conta come failure del breaker", async () => {
    const t = gatedFetch()
    globalThis.fetch = t.fn as unknown as typeof fetch

    for (const id of ["x", "y", "z"]) {
      const ctrl = new AbortController()
      const p = fetchCinemetaRating(`tt_cx_${id}`, "movie", ctrl.signal)
      ctrl.abort()
      await expect(p).resolves.toBeNull()
    }

    const before = t.fn.mock.calls.length
    const p = fetchCinemetaRating("tt_cx_w", "movie")
    expect(t.fn.mock.calls.length).toBe(before + 1)
    t.pending.at(-1)!.release({ meta: { imdbRating: "7.5" } })
    await expect(p).resolves.toBe(7.5)
  })

  it("200 header + timeout del body NON accumula failure (recordSuccess pre-body) — comportamento attuale", async () => {
    // Caratterizzazione della policy ESISTENTE (non un requisito): recordSuccess()
    // dopo gli header riazzera i failure, quindi un timeout in lettura body vale
    // al più 1 failure per chiamata → dopo 3 body-timeout il breaker resta CHIUSO.
    // Documentato: il breaker NON scatta sui body-timeout con header 200; nessun
    // fix speculativo.
    const ts = stubTimeoutScheduler()
    try {
      const h = bodyBarrierFetch(() => null)
      globalThis.fetch = h.fn as unknown as typeof fetch

      for (const id of ["b1", "b2", "b3"]) {
        const p = fetchCinemetaRating(`tt_bt_${id}`, "movie")
        const body = await h.awaitBodyEntered()
        ts.timeouts.at(-1)!.controller.abort()
        await expect(p).resolves.toBeNull()
        await body.settled
      }

      const before = h.fn.mock.calls.length
      const p4 = fetchCinemetaRating("tt_bt_b4", "movie")
      expect(h.fn.mock.calls.length).toBe(before + 1)
      const body4 = await h.awaitBodyEntered()
      ts.timeouts.at(-1)!.controller.abort()
      await expect(p4).resolves.toBeNull()
      await body4.settled
    } finally {
      ts.restore()
    }
  })

  it("senza wantImdb → Cinemeta mai chiamato", async () => {
    const seen: string[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      seen.push(url)
      if (url.includes("mdblist.com")) return jsonResponse({ ratings: [{ source: "tmdb", value: 80, score: 80 }] })
      return jsonResponse({ meta: { imdbRating: "9.9" } })
    })

    const aggregated = await fetchAggregatedRating("tt_ci3", "k")
    expect(aggregated?.sources.imdb).toBeUndefined()
    expect(seen.some((u) => u.includes("/meta/"))).toBe(false)
  })
})
