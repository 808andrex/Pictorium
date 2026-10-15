import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { fetchCinemetaRating, __resetCinemetaBreaker, __resetCinemetaNullForTest } from "@/lib/cinemeta"
import { fetchAggregatedRating } from "@/lib/ratings"
import { cacheClear } from "@/lib/cache"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
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
