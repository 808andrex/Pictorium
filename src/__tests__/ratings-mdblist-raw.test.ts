import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cacheClear } from "@/lib/cache"
import {
  fetchAggregatedRating,
  __resetMdblistBreaker,
  __resetRatingsNullForTest,
} from "@/lib/ratings"

// Task 1 (MDBList request reduction): raw provider cache per (imdbId, key
// hash) indipendente dalla selezione badge + coalescing delle fetch
// concorrenti sulla stessa identità. Il reset dell'inflight grezza esiste
// solo dopo la modifica: accesso difensivo così il file descrive il RED
// anche sul codice pre-modifica (le asserzioni di dedup falliscono lì).
async function resetMdbRaw(): Promise<void> {
  const mod = (await import("@/lib/ratings")) as unknown as Record<string, unknown>
  const fn = mod.__resetMdbRawForTest
  if (typeof fn === "function") (fn as () => void)()
}

function okRatings(body: unknown) {
  return { ok: true, json: async () => body }
}

function isMdblist(input: unknown): boolean {
  return String(input).includes("mdblist.com")
}

function mdblistCalls(mock: ReturnType<typeof vi.fn>): number {
  return mock.mock.calls.filter(([input]) => isMdblist(input)).length
}

const RICH = {
  ratings: [
    { source: "metacritic", value: 85, score: 85 },
    { source: "trakt", value: 83, score: 83 },
  ],
}

beforeEach(async () => {
  cacheClear()
  __resetMdblistBreaker()
  __resetRatingsNullForTest()
  await resetMdbRaw()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("MDBList raw reuse/coalescing (task 1)", () => {
  it("stessa identità, selezioni diverse: un solo upstream grezzo", async () => {
    const fetchMock = vi.fn(async () => okRatings(RICH))
    vi.stubGlobal("fetch", fetchMock)

    const first = await fetchAggregatedRating("tt_raw_share", "keyA", undefined, {
      requestedSources: ["metacritic"],
      ratingWaitMs: 1500,
    })
    expect(first?.sources.metacritic).toBe(8.5)

    const second = await fetchAggregatedRating("tt_raw_share", "keyA", undefined, {
      requestedSources: ["trakt"],
      ratingWaitMs: 1500,
    })
    expect(second?.sources.trakt).toBe(8.3)
    expect(mdblistCalls(fetchMock)).toBe(1)
  })

  it("concorrenti sulla stessa identità: un solo upstream", async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (!isMdblist(input)) throw new Error(`unexpected upstream ${String(input)}`)
        calls += 1
        await gate
        return okRatings(RICH)
      }),
    )

    const p1 = fetchAggregatedRating("tt_raw_conc", "keyA", undefined, {
      requestedSources: ["metacritic"],
      ratingWaitMs: 2000,
    })
    const p2 = fetchAggregatedRating("tt_raw_conc", "keyA", undefined, {
      requestedSources: ["trakt"],
      ratingWaitMs: 2000,
    })
    release()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1?.sources.metacritic).toBe(8.5)
    expect(r2?.sources.trakt).toBe(8.3)
    expect(calls).toBe(1)
  })

  it("identità distinte (key o id) restano isolate", async () => {
    const fetchMock = vi.fn(async () => okRatings(RICH))
    vi.stubGlobal("fetch", fetchMock)

    await fetchAggregatedRating("tt_raw_iso", "keyA", undefined, {
      requestedSources: ["metacritic"],
      ratingWaitMs: 1500,
    })
    await fetchAggregatedRating("tt_raw_iso", "keyB", undefined, {
      requestedSources: ["metacritic"],
      ratingWaitMs: 1500,
    })
    await fetchAggregatedRating("tt_raw_iso_other", "keyA", undefined, {
      requestedSources: ["metacritic"],
      ratingWaitMs: 1500,
    })
    expect(mdblistCalls(fetchMock)).toBe(3)
  })

  it("l'abort di un subscriber non avvelena l'altro: un solo upstream", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return okRatings(RICH)
    })
    vi.stubGlobal("fetch", fetchMock)

    const firstCtrl = new AbortController()
    const p1 = fetchAggregatedRating("tt_raw_abort", "keyA", firstCtrl.signal, {
      requestedSources: ["metacritic"],
      ratingWaitMs: 2000,
    })
    const p2 = fetchAggregatedRating("tt_raw_abort", "keyA", undefined, {
      requestedSources: ["trakt"],
      ratingWaitMs: 2000,
    })
    firstCtrl.abort()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBeNull()
    expect(r2?.sources.metacritic).toBe(8.5)
    expect(mdblistCalls(fetchMock)).toBe(1)
  })

  it("senza subscriber restanti l'upstream owned viene abortito (niente leak)", async () => {
    const captured: (AbortSignal | null | undefined)[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured.push(init?.signal ?? null)
        await new Promise<void>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          })
        })
        return okRatings(RICH)
      }),
    )

    const c1 = new AbortController()
    const c2 = new AbortController()
    const p1 = fetchAggregatedRating("tt_raw_no_sub", "keyA", c1.signal, {
      requestedSources: ["metacritic"],
      ratingWaitMs: 2000,
    })
    const p2 = fetchAggregatedRating("tt_raw_no_sub", "keyA", c2.signal, {
      requestedSources: ["trakt"],
      ratingWaitMs: 2000,
    })
    // Sincronizza sull'avvio OSSERVATO dell'upstream prima di abortire: con
    // l'idratazione disco asincrona un abort PRIMA dell'avvio evita
    // legittimamente l'upstream (nessun fetch sprecato — vedi slow-read test
    // nel file locale), quindi questo path abort-owned si esercita solo dopo
    // che il lavoro condiviso è partito davvero.
    for (let i = 0; i < 200 && captured.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(captured.length).toBeGreaterThan(0)
    c1.abort()
    c2.abort()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBeNull()
    expect(r2).toBeNull()
    expect(captured.length).toBeGreaterThan(0)
    for (const s of captured) expect(s?.aborted).toBe(true)
  })

  it("retry prima che la fetch abortita si sistemi: nuova upstream fresca, mai join condannato", async () => {
    let releaseOld!: () => void
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve
    })
    let calls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (!isMdblist(input)) throw new Error(`unexpected upstream ${String(input)}`)
      calls += 1
      // La prima fetch ignora l'abort (es. parsing body dopo l'abort) e resta
      // pendente sul gate anche dopo che l'owned è abortito.
      if (calls === 1) await oldGate
      return okRatings(RICH)
    })
    vi.stubGlobal("fetch", fetchMock)

    const c1 = new AbortController()
    const p1 = fetchAggregatedRating("tt_raw_doomed", "keyA", c1.signal, {
      requestedSources: ["metacritic"],
      ratingWaitMs: 2000,
    })
    // Attende l'avvio reale dell'upstream prima di abortire.
    for (let i = 0; i < 200 && mdblistCalls(fetchMock) === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(mdblistCalls(fetchMock)).toBe(1)
    c1.abort()
    // Attende l'uscita dell'unico subscriber: l'owned è abortito e la entry
    // abbandonata è già rimossa (identity-safe) mentre l'upstream orfano resta
    // pendente sul gate. Il retry non deve accodarsi alla entry condannata.
    const r1 = await p1
    expect(r1).toBeNull()
    // Retry immediato, prima che la vecchia fetch abortita si sistemi: non
    // deve accodarsi alla entry condannata ma partire con una fetch fresca.
    const p2 = fetchAggregatedRating("tt_raw_doomed", "keyA", undefined, {
      requestedSources: ["trakt"],
      ratingWaitMs: 2000,
    })
    for (let i = 0; i < 200 && mdblistCalls(fetchMock) < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(mdblistCalls(fetchMock)).toBe(2)
    releaseOld()
    const r2 = await p2
    expect(r2?.sources.trakt).toBe(8.3)
    expect(mdblistCalls(fetchMock)).toBe(2)
  })

  it("completamento tardivo dopo la cancellazione: niente scrittura grezza avvelenata", async () => {
    const POISON = { ratings: [{ source: "metacritic", value: 11, score: 11 }, { source: "trakt", value: 22, score: 22 }] }
    const FRESH = { ratings: [{ source: "metacritic", value: 99, score: 99 }, { source: "trakt", value: 83, score: 83 }] }
    let releaseOld!: () => void
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve
    })
    let calls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (!isMdblist(input)) throw new Error(`unexpected upstream ${String(input)}`)
      calls += 1
      if (calls === 1) {
        // Ignora l'abort e completa tardi con dati stantii.
        await oldGate
        return okRatings(POISON)
      }
      return okRatings(FRESH)
    })
    vi.stubGlobal("fetch", fetchMock)

    const c1 = new AbortController()
    const p1 = fetchAggregatedRating("tt_raw_late", "keyA", c1.signal, {
      requestedSources: ["metacritic"],
      ratingWaitMs: 2000,
    })
    for (let i = 0; i < 200 && mdblistCalls(fetchMock) === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5))
    }
    c1.abort()
    const r1 = await p1
    expect(r1).toBeNull()
    const p2 = fetchAggregatedRating("tt_raw_late", "keyA", undefined, {
      requestedSources: ["metacritic"],
      ratingWaitMs: 2000,
    })
    const r2 = await p2
    expect(r2?.sources.metacritic).toBe(9.9)
    expect(mdblistCalls(fetchMock)).toBe(2)
    // La vecchia fetch completa tardi con dati stantii: non deve sovrascrivere
    // la grezza fresca né cancellare la nuova inflight.
    releaseOld()
    await new Promise((r) => setTimeout(r, 20))
    // Selezione diversa, stessa identità grezza: deve servire il FRESH dalla
    // cache grezza senza rifetchare, mai il POISON tardivo.
    const p3 = await fetchAggregatedRating("tt_raw_late", "keyA", undefined, {
      requestedSources: ["trakt"],
      ratingWaitMs: 2000,
    })
    expect(p3?.sources.trakt).toBe(8.3)
    expect(mdblistCalls(fetchMock)).toBe(2)
  })

  it("timeout di budget di un subscriber non abortisce il superstite: un solo upstream", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (!isMdblist(input)) throw new Error(`unexpected upstream ${String(input)}`)
      await new Promise((r) => setTimeout(r, 400))
      return okRatings(RICH)
    })
    vi.stubGlobal("fetch", fetchMock)

    // p1 scade (budget 300 → share primaria 180ms) molto prima dei 400ms di
    // fetch; p2 (budget 2000) resta e deve completare sullo stesso upstream.
    const p1 = fetchAggregatedRating("tt_raw_budget", "keyA", undefined, {
      requestedSources: ["metacritic"],
      ratingWaitMs: 300,
    })
    const p2 = fetchAggregatedRating("tt_raw_budget", "keyA", undefined, {
      requestedSources: ["trakt"],
      ratingWaitMs: 2000,
    })
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBeNull()
    expect(r2?.sources.trakt).toBe(8.3)
    expect(mdblistCalls(fetchMock)).toBe(1)
  })

  it("errori/abort non entrano nella cache grezza: il retry rifetcha", async () => {
    let n = 0
    const fetchMock = vi.fn(async () => {
      n += 1
      if (n === 1) return { ok: false, status: 503, headers: { get: () => null } }
      return okRatings(RICH)
    })
    vi.stubGlobal("fetch", fetchMock)

    const failed = await fetchAggregatedRating("tt_raw_err", "keyA", undefined, {
      requestedSources: ["metacritic"],
      ratingWaitMs: 1500,
    })
    expect(failed).toBeNull()
    // Selezione diversa: senza cache del fallimento rifetcha e riesce.
    const retried = await fetchAggregatedRating("tt_raw_err", "keyA", undefined, {
      requestedSources: ["trakt"],
      ratingWaitMs: 1500,
    })
    expect(retried?.sources.trakt).toBe(8.3)
    expect(mdblistCalls(fetchMock)).toBe(2)
  })

  it("routing zero-MDBList invariato: simkl-only senza chiamate MDBList", async () => {
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

    const result = await fetchAggregatedRating("tt_raw_simkl", undefined, undefined, {
      simklKey: "test-simkl-key",
      requestedSources: ["simkl"],
      ratingWaitMs: 1500,
    })
    expect(result?.sources.simkl).toBe(8.6)
    expect(seen.some((u) => u.includes("mdblist.com"))).toBe(false)
  })
})
