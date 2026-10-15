import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  fetchSimklRating,
  __resetSimklBreaker,
  __resetSimklNullForTest,
  isSimklBreakerOpen,
} from "@/lib/simkl"
import { fetchAggregatedRating } from "@/lib/ratings"

const FAKE_CLIENT_ID = "test-simkl-client-id-123"

describe("Simkl client (src/lib/simkl.ts)", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    __resetSimklBreaker()
    __resetSimklNullForTest()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("BYOK: ritorna null senza fare fetch se clientId è assente o vuoto", async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy

    expect(await fetchSimklRating("tt1375666", undefined)).toBeNull()
    expect(await fetchSimklRating("tt1375666", null)).toBeNull()
    expect(await fetchSimklRating("tt1375666", "")).toBeNull()
    expect(await fetchSimklRating("tt1375666", "   ")).toBeNull()

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("BYOK: ritorna null senza fare fetch se imdbId e tmdbId sono entrambi assenti", async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy

    expect(await fetchSimklRating(null, FAKE_CLIENT_ID)).toBeNull()
    expect(await fetchSimklRating("", FAKE_CLIENT_ID)).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("risolve redirect 301 (stop-at-301) e recupera rating per movies", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/redirect")) {
        return new Response(null, {
          status: 301,
          headers: {
            Location: "https://simkl.com/movies/472214/inception",
          },
        })
      }
      if (url.includes("/movies/472214")) {
        return new Response(
          JSON.stringify({
            title: "Inception",
            ratings: {
              simkl: { rating: 8.6, votes: 14475 },
              imdb: { rating: 8.8, votes: 2870193 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }
      return new Response("Not found", { status: 404 })
    })

    const rating = await fetchSimklRating("tt1375666", FAKE_CLIENT_ID)
    expect(rating).toBe(8.6)
  })

  it("risolve redirect 301 e recupera rating per tv show", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/redirect")) {
        return new Response(null, {
          status: 301,
          headers: {
            Location: "//simkl.com/tv/11121/breaking-bad",
          },
        })
      }
      if (url.includes("/tv/11121")) {
        return new Response(
          JSON.stringify({
            title: "Breaking Bad",
            ratings: {
              simkl: { rating: 9.2, votes: 15000 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }
      return new Response("Not found", { status: 404 })
    })

    const rating = await fetchSimklRating("tt0903747", FAKE_CLIENT_ID)
    expect(rating).toBe(9.2)
  })

  it("risolve ID tramite tmdbId e mediaType quando imdbId è assente", async () => {
    let redirectCalledUrl = ""
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/redirect")) {
        redirectCalledUrl = url
        return new Response(null, {
          status: 301,
          headers: {
            Location: "https://simkl.com/tv/11121/breaking-bad",
          },
        })
      }
      if (url.includes("/tv/11121")) {
        return new Response(
          JSON.stringify({
            ratings: { simkl: { rating: 9.2 } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }
      return new Response("Not found", { status: 404 })
    })

    const rating = await fetchSimklRating(null, FAKE_CLIENT_ID, {
      tmdbId: 1396,
      mediaType: "tv",
    })
    expect(rating).toBe(9.2)
    expect(redirectCalledUrl).toContain("tmdb=1396")
    expect(redirectCalledUrl).toContain("type=tv")
  })

  it("circuit breaker: 3 errori 500 consecutivi aprono il breaker (fail-open)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("Server error", { status: 500 }))

    expect(await fetchSimklRating("tt_fail_1", FAKE_CLIENT_ID)).toBeNull()
    expect(await fetchSimklRating("tt_fail_2", FAKE_CLIENT_ID)).toBeNull()
    expect(await fetchSimklRating("tt_fail_3", FAKE_CLIENT_ID)).toBeNull()

    expect(isSimklBreakerOpen()).toBe(true)

    // A breaker aperto, non effettua nemmeno fetch
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy
    expect(await fetchSimklRating("tt_fail_4", FAKE_CLIENT_ID)).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("integrazione con fetchAggregatedRating: inietta sources.simkl se wantSimkl è true", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("mdblist.com")) {
        return new Response(
          JSON.stringify({
            score: 80,
            ratings: [
              { source: "imdb", score: 85 },
              { source: "tmdb", score: 80 },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }
      if (url.includes("/redirect")) {
        return new Response(null, {
          status: 301,
          headers: { Location: "https://simkl.com/movies/999999/test-movie" },
        })
      }
      if (url.includes("/movies/999999")) {
        return new Response(
          JSON.stringify({
            ratings: { simkl: { rating: 8.7 } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }
      return new Response("Not found", { status: 404 })
    })

    const aggregated = await fetchAggregatedRating("tt_simkl_agg_test", "fake-mdb-key", undefined, {
      simklKey: FAKE_CLIENT_ID,
      wantSimkl: true,
    })

    expect(aggregated).not.toBeNull()
    expect(aggregated?.sources.imdb).toBe(8.5)
    expect(aggregated?.sources.tmdb).toBe(8.0)
    expect(aggregated?.sources.simkl).toBe(8.7)
  })
})
