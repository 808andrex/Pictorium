import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  fetchAggregatedRating,
  isMdblistBreakerOpen,
  __resetMdblistBreaker,
  __resetMdbRawForTest,
  __resetRatingsNullForTest,
} from "@/lib/ratings"
import { __resetMdbQuotaForTests } from "@/lib/mdblist-quota"
import { cacheClear } from "@/lib/cache"

function okFetch() {
  return Promise.resolve({ ok: true, json: async () => ({ ratings: [{ source: "imdb", value: 84, score: 84 }] }) })
}

function statusFetch(status: number, retryAfter?: string) {
  return () =>
    Promise.resolve({
      ok: false,
      status,
      headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? retryAfter ?? null : null) },
    })
}

type FetchMock = (...args: unknown[]) => Promise<unknown>

// Breaker MDBList dedicato (Phase 2): 3 fallimenti → 30s cooldown, fail-open
// con fallback al voto TMDB nativo nei caller. Il breaker è module-level:
// ogni test riparte da zero.
describe("fetchAggregatedRating breaker (fail-open, 3 fails → 30s)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __resetMdblistBreaker()
    __resetMdbRawForTest()
    __resetRatingsNullForTest()
    __resetMdbQuotaForTests()
    cacheClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    __resetMdblistBreaker()
    __resetMdbRawForTest()
    __resetRatingsNullForTest()
    __resetMdbQuotaForTests()
    cacheClear()
  })

  it("opens after 3 network failures and short-circuits without fetching", async () => {
    const fetchMock = vi.fn<FetchMock>(async () => { throw new Error("upstream down") })
    vi.stubGlobal("fetch", fetchMock)

    for (let i = 0; i < 3; i++) expect(await fetchAggregatedRating("ttB1", "k")).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // Breaker aperto: quarto tentativo ritorna subito null senza rete.
    expect(await fetchAggregatedRating("ttB1", "k")).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("recovers via half-open trial after the 30s window (success closes it)", async () => {
    const fetchMock = vi.fn<FetchMock>(async () => { throw new Error("upstream down") })
    vi.stubGlobal("fetch", fetchMock)

    for (let i = 0; i < 3; i++) await fetchAggregatedRating("ttB2", "k")
    expect(fetchMock).toHaveBeenCalledTimes(3)

    vi.setSystemTime(Date.now() + 31_000)
    fetchMock.mockImplementation(okFetch)
    const trial = await fetchAggregatedRating("ttB2", "k")
    expect(trial?.average).toBe(8.4)

    // Breaker richiuso: un id fresco tocca di nuovo la rete.
    await fetchAggregatedRating("ttB2fresh", "k")
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it("429 with Retry-After extends the window to the upstream value", async () => {
    const fetchMock = vi.fn<FetchMock>(statusFetch(429, "45"))
    vi.stubGlobal("fetch", fetchMock)

    for (let i = 0; i < 3; i++) expect(await fetchAggregatedRating("ttB3", "k")).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)

    const t0 = Date.now()
    vi.setSystemTime(t0 + 31_000)
    // Finestra custom 45s ancora aperta: niente rete.
    expect(await fetchAggregatedRating("ttB3", "k")).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)

    vi.setSystemTime(t0 + 46_000)
    fetchMock.mockImplementation(okFetch)
    expect((await fetchAggregatedRating("ttB3", "k"))?.average).toBe(8.4)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it("non-429 client errors (404/401) fail fast without tripping the breaker", async () => {
    const fetchMock = vi.fn(statusFetch(404))
    vi.stubGlobal("fetch", fetchMock)

    for (const id of ["ttB4a", "ttB4b", "ttB4c", "ttB4d"]) {
      expect(await fetchAggregatedRating(id, "k")).toBeNull()
    }
    // Miss genuine: il quarto id tocca ancora la rete (breaker chiuso).
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it("server errors (500/503) trip the breaker after threshold", async () => {
    const fetchMock = vi.fn(statusFetch(503))
    vi.stubGlobal("fetch", fetchMock)

    for (let i = 0; i < 3; i++) expect(await fetchAggregatedRating(`ttB5xx_${i}`, "k")).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // Breaker aperto: quarto tentativo ritorna subito null senza rete.
    expect(await fetchAggregatedRating("ttB5xx_4", "k")).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("our own cancellation (caller abort) is not recorded as a failure", async () => {
    // Shared-hydration timing: the raw path hydrates L1/KV/disk inside an
    // owned operation BEFORE the upstream fetch starts, so aborting
    // immediately after the call cancels the wait while zero upstream has
    // run (0 fetch calls) instead of cancelling real in-flight work. Gate
    // each abort on the observable upstream start: the mock notifies on
    // entry, the test awaits that gate, THEN aborts. Three
    // cancellations reach the failure threshold (3) — if any counted as a
    // failure the breaker would open and the healthy proof below would
    // short-circuit with zero new network.
    let notifyStarted: (() => void) | null = null
    const hanging = vi.fn(
      (_url: unknown, opts?: { signal?: AbortSignal }): Promise<unknown> => {
        notifyStarted?.()
        return new Promise<never>((_, rej) => {
          const s = opts?.signal
          const err = () => rej(new DOMException("aborted", "AbortError"))
          if (s?.aborted) err()
          else s?.addEventListener("abort", err, { once: true })
        })
      },
    )
    vi.stubGlobal("fetch", hanging)

    async function cancelAfterUpstreamStart(id: string): Promise<void> {
      const ctrl = new AbortController()
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve
      })
      const p = fetchAggregatedRating(id, "k", ctrl.signal)
      await started
      notifyStarted = null
      ctrl.abort()
      await expect(p).resolves.toBeNull()
    }

    await cancelAfterUpstreamStart("ttBCancel1")
    await cancelAfterUpstreamStart("ttBCancel2")
    await cancelAfterUpstreamStart("ttBCancel3")
    expect(hanging).toHaveBeenCalledTimes(3)
    expect(isMdblistBreakerOpen()).toBe(false)

    // Breaker still closed after 3 cancellations: a fresh healthy provider
    // response flows (no short-circuit) and closes out any doubt.
    hanging.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ ratings: [{ source: "imdb", value: 84, score: 84 }] }),
      }),
    )
    expect((await fetchAggregatedRating("ttBChealthy", "k"))?.average).toBe(8.4)
    expect(hanging).toHaveBeenCalledTimes(4)
    expect(isMdblistBreakerOpen()).toBe(false)
  })

  it("internal deadline aborts a hanging upstream (~1500ms, was 8000ms)", async () => {
    vi.useRealTimers()
    // Come la fetch reale: rigetta all'abort, altrimenti il timeout interno
    // non potrebbe mai sbloccare l'await (lo stub che ignora il signal
    // resterebbe appeso per sempre anche in produzione finta).
    const hangingForever = vi.fn(
      (_url: unknown, opts?: { signal?: AbortSignal }) =>
        new Promise<never>((_, rej) => {
          const s = opts?.signal
          const err = () => rej(new DOMException("The operation was aborted due to timeout", "TimeoutError"))
          if (s?.aborted) err()
          else s?.addEventListener("abort", err, { once: true })
        }),
    )
    vi.stubGlobal("fetch", hangingForever)

    const t0 = Date.now()
    await expect(fetchAggregatedRating("ttB6", "k")).resolves.toBeNull()
    const elapsed = Date.now() - t0
    // 1500ms di deadline + overhead: sotto i 4s comunque; col vecchio 8000ms fallirebbe.
    expect(elapsed).toBeGreaterThanOrEqual(1200)
    expect(elapsed).toBeLessThan(4000)
    expect(hangingForever).toHaveBeenCalledTimes(1)
  })
})
