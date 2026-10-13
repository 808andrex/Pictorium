import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { GET } from "@/app/api/tvdb/[id]/artworks/route"
import {
  TvdbArtworksError,
  clearTvdbCache,
  getTvdbArtworks,
  getTvdbArtworksStrict,
  getTvdbMovieIdStrict,
  getTvdbSeriesIdStrict,
} from "@/lib/tvdb"
import { __clearTMDBCache } from "@/lib/tmdb"
import { cacheClear } from "@/lib/cache"

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ ok: true, retAfter: 0 })),
  rateLimitKey: vi.fn(() => "test"),
  rateLimitResponse: vi.fn(() => new Response("rate limited", { status: 429 })),
}))

const GOOD_KEY = "GOOD-TVDB-KEY"
const BAD_KEY = "BAD-TVDB-KEY"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function makeRequest(path: string, init?: { signal?: AbortSignal }): NextRequest {
  return new NextRequest(`http://localhost${path}`, init)
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

interface LibRouterOpts {
  /** "ok" serves a token only for GOOD_KEY bodies, 401 otherwise; "auth" always 401; "down" always throws. */
  login?: "ok" | "auth" | "down"
  seriesArts?: () => Response
  movieArts?: () => Response
  search?: () => Response
}

function installLibRouter(opts: LibRouterOpts = {}) {
  const { login = "ok" } = opts
  const requested: string[] = []
  const loginBodies: string[] = []
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    requested.push(url)
    if (url.includes("api4.thetvdb.com") && url.endsWith("/login")) {
      if (login === "down") throw new Error("network down")
      const body = String((init as { body?: unknown })?.body ?? "")
      loginBodies.push(body)
      if (login === "auth" || !body.includes(GOOD_KEY)) return new Response("{}", { status: 401 })
      return jsonResponse({ status: "success", data: { token: "mock-jwt" } })
    }
    if (url.includes("/series/") && url.includes("/artworks")) {
      return opts.seriesArts ? opts.seriesArts() : jsonResponse({ status: "success", data: [] })
    }
    if (url.includes("/movies/") && url.includes("/extended")) {
      return opts.movieArts ? opts.movieArts() : jsonResponse({ status: "success", data: { id: 1, artworks: [] } })
    }
    if (url.includes("/search/remoteid/")) {
      return opts.search ? opts.search() : jsonResponse({ status: "success", data: [] })
    }
    throw new Error(`strict-test router: unhandled ${url.slice(0, 140)}`)
  }) as typeof fetch)
  const count = (part: string) => requested.filter((u) => u.includes(part)).length
  return { fetchMock, requested, loginBodies, count }
}

beforeEach(() => {
  process.env.PICTORIUM_TVDB_API_KEY = GOOD_KEY
  process.env.PICTORIUM_TMDB_KEY = "test-tmdb-key"
  delete process.env.PICTORIUM_MULTI_USER
  delete process.env.POSTERIUM_MULTI_USER_ALLOW_ENV_FALLBACK
  delete process.env.PICTORIUM_MULTI_USER_ALLOW_ENV_FALLBACK
  clearTvdbCache()
  __clearTMDBCache()
  cacheClear()
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  clearTvdbCache()
  __clearTMDBCache()
  cacheClear()
})

async function expectUpstream(p: Promise<unknown>): Promise<void> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(TvdbArtworksError)
    expect((e as TvdbArtworksError).code).toBe("upstream")
    return
  }
  throw new Error("expected TvdbArtworksError(upstream), got success")
}

describe("getTvdbArtworksStrict envelope validation", () => {
  it("throws upstream on invalid JSON and never caches (miss on retry)", async () => {
    let calls = 0
    const { count } = installLibRouter({
      seriesArts: () => {
        calls++
        if (calls <= 2) return new Response("not-json{{{", { status: 200, headers: { "content-type": "application/json" } })
        return jsonResponse({ status: "success", data: [{ image: "https://artworks.thetvdb.com/banners/v4/poster/1.jpg", type: 2 }] })
      },
    })
    await expectUpstream(getTvdbArtworksStrict("tv", 991, GOOD_KEY))
    expect(count("/series/991/artworks")).toBe(1)
    // Failure was not cached: the retry refetches and still throws.
    await expectUpstream(getTvdbArtworksStrict("tv", 991, GOOD_KEY))
    expect(count("/series/991/artworks")).toBe(2)
    // And a later healthy payload succeeds (no poison).
    expect(await getTvdbArtworksStrict("tv", 991, GOOD_KEY)).toHaveLength(1)
    expect(count("/series/991/artworks")).toBe(3)
  })

  it("throws upstream on every wrong envelope shape, never caching", async () => {
    const shapes: unknown[] = [
      { status: "success" },
      { status: "success", data: null },
      { status: "success", data: "nope" },
      { status: "success", data: 42 },
      { status: "success", data: { nope: true } },
      { status: "success", data: { artworks: "nope" } },
      { status: "success", data: { artworks: 42 } },
      null,
    ]
    for (const [i, shape] of shapes.entries()) {
      clearTvdbCache()
      const { count } = installLibRouter({
        seriesArts: () => (shape === null ? jsonResponse(null) : jsonResponse(shape)),
      })
      const tvdbId = 1000 + i
      await expectUpstream(getTvdbArtworksStrict("tv", tvdbId, GOOD_KEY))
      await expectUpstream(getTvdbArtworksStrict("tv", tvdbId, GOOD_KEY))
      expect(count(`/series/${tvdbId}/artworks`)).toBe(2)
      vi.restoreAllMocks()
    }
  })

  it("accepts true-empty envelopes and caches them (second hit without network)", async () => {
    for (const [i, body] of [
      { status: "success", data: [] as unknown[] },
      { status: "success", data: { artworks: [] as unknown[] } },
    ].entries()) {
      clearTvdbCache()
      vi.restoreAllMocks()
      const { fetchMock } = installLibRouter({ seriesArts: () => jsonResponse(body) })
      const tvdbId = 1100 + i
      expect(await getTvdbArtworksStrict("tv", tvdbId, GOOD_KEY)).toEqual([])
      expect(await getTvdbArtworksStrict("tv", tvdbId, GOOD_KEY)).toEqual([])
      // Login + artworks once; the confirmed-empty second hit is cache-only.
      expect(fetchMock).toHaveBeenCalledTimes(2)
    }
  })

  it("filters well-formed arrays of malformed items to a cacheable empty", async () => {
    const { fetchMock } = installLibRouter({
      seriesArts: () =>
        jsonResponse({ status: "success", data: [{ nonsense: 1 }, "x", null, { image: 42 }] }),
    })
    expect(await getTvdbArtworksStrict("tv", 1120, GOOD_KEY)).toEqual([])
    expect(await getTvdbArtworksStrict("tv", 1120, GOOD_KEY)).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("401 throws auth and 500 throws upstream, neither cached", async () => {
    const { count } = installLibRouter({ seriesArts: () => new Response("{}", { status: 401 }) })
    await expect(getTvdbArtworksStrict("tv", 1130, GOOD_KEY)).rejects.toMatchObject({ code: "auth" })
    await expect(getTvdbArtworksStrict("tv", 1130, GOOD_KEY)).rejects.toMatchObject({ code: "auth" })
    expect(count("/series/1130/artworks")).toBe(2)

    clearTvdbCache()
    vi.restoreAllMocks()
    const retry = installLibRouter({ seriesArts: () => new Response("{}", { status: 500 }) })
    await expectUpstream(getTvdbArtworksStrict("tv", 1131, GOOD_KEY))
    await expectUpstream(getTvdbArtworksStrict("tv", 1131, GOOD_KEY))
    expect(retry.count("/series/1131/artworks")).toBe(2)
  })

  it("404 is confirmed absence and is cached", async () => {
    const { fetchMock } = installLibRouter({ seriesArts: () => new Response("{}", { status: 404 }) })
    expect(await getTvdbArtworksStrict("tv", 1140, GOOD_KEY)).toEqual([])
    expect(await getTvdbArtworksStrict("tv", 1140, GOOD_KEY)).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("a bad key never inherits a cached success (auth-before-cache)", async () => {
    const { count, loginBodies } = installLibRouter({
      seriesArts: () =>
        jsonResponse({ status: "success", data: [{ image: "https://artworks.thetvdb.com/banners/v4/poster/1.jpg", type: 2 }] }),
    })
    expect(await getTvdbArtworksStrict("tv", 1150, GOOD_KEY)).toHaveLength(1)
    await expect(getTvdbArtworksStrict("tv", 1150, BAD_KEY)).rejects.toMatchObject({ code: "auth" })
    expect(loginBodies.join("")).toContain(BAD_KEY)
    // The artworks endpoint was hit only by the good key.
    expect(count("/series/1150/artworks")).toBe(1)
  })

  it("pre-aborted callers throw timeout without network", async () => {
    const { fetchMock } = installLibRouter()
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(getTvdbArtworksStrict("tv", 1160, GOOD_KEY, ctrl.signal)).rejects.toMatchObject({ code: "timeout" })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("legacy rescue -> strict cache provenance (cycle2)", () => {
  it("an unvalidated legacy fail-open empty never poisons strict (strict refetches)", async () => {
    let mode: "invalid" | "valid" = "invalid"
    const poster = "https://artworks.thetvdb.com/banners/v4/poster/9.jpg"
    const { count } = installLibRouter({
      seriesArts: () => {
        if (mode === "invalid") return jsonResponse({ status: "success", data: { nope: true } })
        return jsonResponse({ status: "success", data: [{ image: poster, type: 2, score: 9 }] })
      },
    })
    // Legacy rescue stays fail-open [] on the wrong envelope...
    expect(await getTvdbArtworks("tv", 9910, GOOD_KEY)).toEqual([])
    expect(count("/series/9910/artworks")).toBe(1)
    // ...and keeps serving its own cached empty without extra renderer network.
    expect(await getTvdbArtworks("tv", 9910, GOOD_KEY)).toEqual([])
    expect(count("/series/9910/artworks")).toBe(1)

    // Strict must NOT trust that unvalidated legacy empty: with a now-healthy
    // upstream it refetches and returns the real artwork.
    mode = "valid"
    expect(await getTvdbArtworksStrict("tv", 9910, GOOD_KEY)).toHaveLength(1)
    expect(count("/series/9910/artworks")).toBe(2)
  })

  it("a still-invalid upstream after a legacy empty throws upstream (never false-empty)", async () => {
    const { count } = installLibRouter({
      seriesArts: () => new Response("not-json{{{", { status: 200, headers: { "content-type": "application/json" } }),
    })
    expect(await getTvdbArtworks("tv", 9911, GOOD_KEY)).toEqual([])
    expect(count("/series/9911/artworks")).toBe(1)
    await expectUpstream(getTvdbArtworksStrict("tv", 9911, GOOD_KEY))
    expect(count("/series/9911/artworks")).toBe(2)
    // The strict failure was not cached either: a retry refetches.
    await expectUpstream(getTvdbArtworksStrict("tv", 9911, GOOD_KEY))
    expect(count("/series/9911/artworks")).toBe(3)
  })

  it("a proven valid legacy empty IS reused by strict (no refetch)", async () => {
    const { count } = installLibRouter({
      seriesArts: () => jsonResponse({ status: "success", data: [] }),
    })
    expect(await getTvdbArtworks("tv", 9912, GOOD_KEY)).toEqual([])
    expect(count("/series/9912/artworks")).toBe(1)
    expect(await getTvdbArtworksStrict("tv", 9912, GOOD_KEY)).toEqual([])
    expect(count("/series/9912/artworks")).toBe(1)
  })

  it("a proven valid legacy hit IS reused by strict (no refetch)", async () => {
    const poster = "https://artworks.thetvdb.com/banners/v4/poster/9.jpg"
    const { count } = installLibRouter({
      seriesArts: () =>
        jsonResponse({ status: "success", data: [{ image: poster, type: 2, score: 9 }] }),
    })
    expect(await getTvdbArtworks("tv", 9913, GOOD_KEY)).toHaveLength(1)
    expect(count("/series/9913/artworks")).toBe(1)
    expect(await getTvdbArtworksStrict("tv", 9913, GOOD_KEY)).toHaveLength(1)
    expect(count("/series/9913/artworks")).toBe(1)
  })
})

describe("strict TVDB id lookup", () => {
  it("empty results and 404 are genuine no-link (null), login 401 throws auth without caching", async () => {
    installLibRouter({ search: () => jsonResponse({ status: "success", data: [] }) })
    expect(await getTvdbMovieIdStrict("tt0000000", GOOD_KEY)).toBeNull()

    clearTvdbCache()
    vi.restoreAllMocks()
    installLibRouter({ search: () => new Response("{}", { status: 404 }) })
    expect(await getTvdbSeriesIdStrict("tt0000000", GOOD_KEY)).toBeNull()

    clearTvdbCache()
    vi.restoreAllMocks()
    const authed = installLibRouter({ login: "auth" })
    await expect(getTvdbMovieIdStrict("tt1234567", GOOD_KEY)).rejects.toMatchObject({ code: "auth" })
    await expect(getTvdbMovieIdStrict("tt1234567", GOOD_KEY)).rejects.toMatchObject({ code: "auth" })
    expect(authed.count("/login")).toBe(2)
  })

  it("sustained login outage surfaces as upstream once the breaker opens", async () => {
    installLibRouter({ login: "down" })
    const codes: string[] = []
    for (let i = 0; i < 6; i++) {
      try {
        await getTvdbSeriesIdStrict("tt0903747", GOOD_KEY)
        codes.push("null?!")
      } catch (e) {
        codes.push((e as TvdbArtworksError).code)
      }
    }
    // Early blips report auth (401s never trip the breaker); once the shared
    // breaker opens, the outage is honestly reported as upstream.
    expect(codes.slice(0, 4)).toEqual(["auth", "auth", "auth", "auth"])
    expect(codes[5]).toBe("upstream")
  })

  it("invalid lookup JSON throws upstream; pre-aborted throws timeout", async () => {
    const { fetchMock } = installLibRouter({
      search: () => new Response("not-json{{{", { status: 200, headers: { "content-type": "application/json" } }),
    })
    await expectUpstream(getTvdbMovieIdStrict("tt0133093", GOOD_KEY))

    clearTvdbCache()
    vi.restoreAllMocks()
    const spy = installLibRouter()
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(getTvdbSeriesIdStrict("tt0133093", GOOD_KEY, ctrl.signal)).rejects.toMatchObject({ code: "timeout" })
    expect(spy.fetchMock).not.toHaveBeenCalled()
    expect(fetchMock).toBeDefined()
  })
})

describe("GET /api/tvdb/[id]/artworks strict correctness", () => {
  function installRouteRouter(opts: {
    login?: "ok" | "auth" | "down"
    ext?: { tvdb_id?: number | null; imdb_id?: string | null }
    seriesArts?: () => Response
    hangExt?: boolean
  } = {}) {
    const requested: string[] = []
    const loginBodies: string[] = []
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      requested.push(url)
      if (url.includes("api4.thetvdb.com") && url.endsWith("/login")) {
        if (opts.login === "down") throw new Error("network down")
        const body = String((init as { body?: unknown })?.body ?? "")
        loginBodies.push(body)
        if (opts.login === "auth" || !body.includes(GOOD_KEY)) return new Response("{}", { status: 401 })
        return jsonResponse({ status: "success", data: { token: "mock-jwt" } })
      }
      if (url.includes("api.themoviedb.org") && url.includes("/external_ids")) {
        if (opts.hangExt) {
          return new Promise<Response>((_resolve, reject) => {
            const signal = (init as { signal?: AbortSignal } | undefined)?.signal
            if (!signal) return
            if (signal.aborted) {
              reject(new DOMException("Aborted", "AbortError"))
              return
            }
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
          })
        }
        const e = opts.ext ?? { tvdb_id: 75710, imdb_id: "tt1234567" }
        return jsonResponse({ id: 1, imdb_id: e.imdb_id ?? null, tvdb_id: e.tvdb_id ?? null })
      }
      if (url.includes("/series/") && url.includes("/artworks")) {
        return opts.seriesArts ? opts.seriesArts() : jsonResponse({ status: "success", data: [] })
      }
      if (url.includes("/movies/") && url.includes("/extended")) {
        return jsonResponse({ status: "success", data: { id: 1, artworks: [] } })
      }
      if (url.includes("/search/remoteid/")) {
        return jsonResponse({ status: "success", data: [] })
      }
      throw new Error(`strict-route router: unhandled ${url.slice(0, 140)}`)
    }) as typeof fetch)
    const count = (part: string) => requested.filter((u) => u.includes(part)).length
    return { fetchMock, requested, loginBodies, count }
  }

  it("genuine unlinked title returns honest empty and caches it", async () => {
    const { fetchMock } = installRouteRouter({ ext: { tvdb_id: null, imdb_id: null } })
    const first = await GET(makeRequest("/api/tvdb/910/artworks?type=tv"), params("910"))
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ posters: [], backdrops: [], logos: [], source: "tvdb" })
    const calls = fetchMock.mock.calls.length
    expect(calls).toBeGreaterThan(0)
    const second = await GET(makeRequest("/api/tvdb/910/artworks?type=tv"), params("910"))
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ posters: [], backdrops: [], logos: [], source: "tvdb" })
    expect(fetchMock.mock.calls.length).toBe(calls)
  })

  it("IMDb lookup auth failure is 502 auth and is never cached as empty", async () => {
    const { count } = installRouteRouter({ login: "auth", ext: { tvdb_id: null, imdb_id: "tt1234567" } })
    const first = await GET(makeRequest("/api/tvdb/911/artworks?type=tv"), params("911"))
    expect(first.status).toBe(502)
    expect(await first.json()).toMatchObject({ code: "tvdb_auth_error" })
    const second = await GET(makeRequest("/api/tvdb/911/artworks?type=tv"), params("911"))
    expect(second.status).toBe(502)
    expect(await second.json()).toMatchObject({ code: "tvdb_auth_error" })
    // The failure was recomputed, not served from an empty cache entry.
    expect(count("/login")).toBe(2)
  })

  it("sustained TVDB outage is 502 unavailable (not auth, not empty)", async () => {
    // Trip the shared breaker first: 5 login failures open the 60s window.
    installRouteRouter({ login: "down" })
    for (let i = 0; i < 5; i++) {
      try {
        await getTvdbSeriesIdStrict("tt0903747", GOOD_KEY)
      } catch { /* expected */ }
    }
    vi.restoreAllMocks()
    const { requested } = installRouteRouter({ login: "down", ext: { tvdb_id: 75710, imdb_id: "tt1234567" } })
    const res = await GET(makeRequest("/api/tvdb/912/artworks?type=tv"), params("912"))
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ code: "tvdb_unavailable" })
    // Short-circuited login: the gallery was never reached, nothing cached.
    expect(requested.filter((u) => u.includes("/artworks") || u.includes("/extended"))).toEqual([])
  })

  it("bad key after a good cached gallery is rejected (no mask, no leak)", async () => {
    const poster = "https://artworks.thetvdb.com/banners/v4/poster/1.jpg"
    installRouteRouter({
      seriesArts: () =>
        jsonResponse({
          status: "success",
          data: [{ image: poster, type: 2, score: 9 }],
        }),
    })
    // Seed a success with the good key (direct tvdb_id path).
    const first = await GET(makeRequest("/api/tvdb/913/artworks?type=tv"), params("913"))
    expect(first.status).toBe(200)
    expect(JSON.stringify(await first.json())).toContain(poster)

    // Same title with a rejected key: auth error, not the cached gallery.
    const second = await GET(makeRequest(`/api/tvdb/913/artworks?type=tv&tvdb_key=${BAD_KEY}`), params("913"))
    expect(second.status).toBe(502)
    const body = await second.json()
    expect(body).toMatchObject({ code: "tvdb_auth_error" })
    expect(JSON.stringify(body)).not.toContain(BAD_KEY)
    expect(JSON.stringify(body)).not.toContain("mock-jwt")
  })

  it("malformed artworks payload is 502 unavailable and retried (miss on retry)", async () => {
    let calls = 0
    const poster = "https://artworks.thetvdb.com/banners/v4/poster/1.jpg"
    installRouteRouter({
      seriesArts: () => {
        calls++
        if (calls === 1) return new Response("not-json{{{", { status: 200, headers: { "content-type": "application/json" } })
        return jsonResponse({
          status: "success",
          data: [{ image: poster, type: 2, score: 9 }],
        })
      },
    })
    const first = await GET(makeRequest("/api/tvdb/914/artworks?type=tv"), params("914"))
    expect(first.status).toBe(502)
    expect(await first.json()).toMatchObject({ code: "tvdb_unavailable" })
    const second = await GET(makeRequest("/api/tvdb/914/artworks?type=tv"), params("914"))
    expect(second.status).toBe(200)
    expect(JSON.stringify(await second.json())).toContain(poster)
    expect(calls).toBe(2)
  })

  it("aggregate budget cancels the chain: 502 unavailable, no gallery fetch, nothing cached", async () => {
    vi.useFakeTimers()
    const { requested } = installRouteRouter({ hangExt: true })
    try {
      const pending = GET(makeRequest("/api/tvdb/915/artworks?type=tv"), params("915"))
      await vi.advanceTimersByTimeAsync(5100)
      const res = await pending
      expect(res.status).toBe(502)
      expect(await res.json()).toMatchObject({ code: "tvdb_unavailable" })
      // TMDB lookup was attempted, but the TVDB gallery stages never ran.
      expect(requested.filter((u) => u.includes("/external_ids"))).toHaveLength(1)
      expect(requested.filter((u) => u.includes("/artworks") || u.includes("/extended") || u.includes("/search/remoteid/"))).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
