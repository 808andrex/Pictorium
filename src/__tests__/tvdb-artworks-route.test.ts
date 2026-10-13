import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { GET } from "@/app/api/tvdb/[id]/artworks/route"
import { clearTvdbCache } from "@/lib/tvdb"
import { __clearTMDBCache } from "@/lib/tmdb"
import { cacheClear } from "@/lib/cache"
import { imgSrc } from "@/lib/poster-render-helpers"
import { isAllowedResolveHost } from "@/lib/resolve-image"
import { fetchValidatedCustomImage } from "@/lib/custom-poster-base"

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ ok: true, retAfter: 0 })),
  rateLimitKey: vi.fn(() => "test"),
  rateLimitResponse: vi.fn(() => new Response("rate limited", { status: 429 })),
}))

const UUID = "123e4567-e89b-12d3-a456-426614174000"
const POSTER = "https://artworks.thetvdb.com/banners/v4/poster/1.jpg"
const FANART = "https://artworks.thetvdb.com/banners/v4/fanart/2.jpg"
const LOGO = "https://artworks.thetvdb.com/banners/v4/clearlogo/3.png"

function makeRequest(path: string, init?: { signal?: AbortSignal }): NextRequest {
  return new NextRequest(`http://localhost${path}`, init)
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

interface RouterOpts {
  login?: "ok" | "auth" | "network"
  ext?: { tvdb_id?: number | null; imdb_id?: string | null } | "fail"
  seriesArts?: unknown[] | { status: number }
  movieArts?: unknown[] | { status: number }
}

function installRouter(opts: RouterOpts = {}) {
  const requested: string[] = []
  const loginBodies: string[] = []
  const {
    login = "ok",
    ext = { tvdb_id: 75710, imdb_id: "tt1234567" },
    seriesArts = [
      { id: 1, image: POSTER, thumbnail: null, language: "eng", type: 2, width: 680, height: 1000, includesText: false, score: 9 },
      { id: 2, image: FANART, thumbnail: null, language: "eng", type: 3, width: 1920, height: 1080, includesText: false, score: 9.9 },
      { id: 3, image: LOGO, thumbnail: null, language: "eng", type: 23, width: 800, height: 310, includesText: false, score: 7 },
      { id: 4, image: "https://artworks.thetvdb.com/banners/v4/season/7.jpg", language: "eng", type: 7, width: 680, height: 1000, includesText: false, score: 99 },
    ],
    movieArts = [
      { id: 9, image: POSTER, thumbnail: null, language: null, type: 14, width: 1000, height: 1500, includesText: false, score: 7 },
      { id: 10, image: FANART, language: "eng", type: 15, width: 1920, height: 1080, includesText: false, score: 8 },
      { id: 11, image: LOGO, language: null, type: 25, width: 800, height: 310, score: 6 },
    ],
  } = opts
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    requested.push(url)
    if (url.includes("api4.thetvdb.com") && url.endsWith("/login")) {
      if (login === "auth") return new Response("{}", { status: 401 })
      if (login === "network") throw new Error("network down")
      try {
        loginBodies.push(String((init as { body?: unknown })?.body ?? ""))
      } catch {
        loginBodies.push("")
      }
      return jsonResponse({ status: "success", data: { token: "mock-jwt" } })
    }
    if (url.includes("api.themoviedb.org") && url.includes("/external_ids")) {
      if (ext === "fail") return new Response("{}", { status: 500 })
      const e = ext as { tvdb_id?: number | null; imdb_id?: string | null }
      return jsonResponse({ id: 1, imdb_id: e.imdb_id ?? null, tvdb_id: e.tvdb_id ?? null })
    }
    if (url.includes("/series/") && url.includes("/artworks")) {
      if (seriesArts && typeof seriesArts === "object" && !Array.isArray(seriesArts)) {
        return new Response("{}", { status: (seriesArts as { status: number }).status })
      }
      return jsonResponse({ status: "success", data: seriesArts })
    }
    if (url.includes("/movies/") && url.includes("/extended")) {
      if (movieArts && typeof movieArts === "object" && !Array.isArray(movieArts)) {
        return new Response("{}", { status: (movieArts as { status: number }).status })
      }
      return jsonResponse({ status: "success", data: { id: 1, artworks: movieArts } })
    }
    if (url.includes("api4.thetvdb.com") && url.includes("/search/remoteid/")) {
      return jsonResponse({ status: "success", data: [] })
    }
    throw new Error(`tvdb-artworks-route router: unhandled ${url.slice(0, 140)}`)
  }) as typeof fetch)
  return { fetchMock, requested, loginBodies }
}

beforeEach(() => {
  process.env.PICTORIUM_TVDB_API_KEY = "env-tvdb-key"
  // getExternalIds (tvdb_id-first resolution) needs a TMDB key outside the
  // mock-key path (TMDB_BASE_URL unset in unit tests): the mocked fetch
  // serves it, the real contract (key never in our payload) is asserted.
  process.env.PICTORIUM_TMDB_KEY = "test-tmdb-key"
  delete process.env.PICTORIUM_MULTI_USER
  delete process.env.POSTERIUM_MULTI_USER_ALLOW_ENV_FALLBACK
  delete process.env.PICTORIUM_MULTI_USER_ALLOW_ENV_FALLBACK
  clearTvdbCache()
  __clearTMDBCache()
  cacheClear()
  vi.restoreAllMocks()
})

describe("GET /api/tvdb/[id]/artworks", () => {
  it("400 on invalid type or id", async () => {
    installRouter()
    expect((await GET(makeRequest("/api/tvdb/123/artworks?type=song"), params("123"))).status).toBe(400)
    expect((await GET(makeRequest("/api/tvdb/abc/artworks?type=movie"), params("abc"))).status).toBe(400)
    expect((await GET(makeRequest("/api/tvdb/0/artworks?type=tv"), params("0"))).status).toBe(400)
  })

  it("503 tvdb_not_configured without any key and without network", async () => {
    delete process.env.PICTORIUM_TVDB_API_KEY
    const { fetchMock } = installRouter()
    const res = await GET(makeRequest("/api/tvdb/321/artworks?type=movie"), params("321"))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: "tvdb_not_configured" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("200 with grouped series artworks (2/3/23, season excluded), no key material in payload", async () => {
    installRouter()
    const res = await GET(makeRequest("/api/tvdb/755/artworks?type=tv"), params("755"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.source).toBe("tvdb")
    expect(body.posters).toHaveLength(1)
    expect(body.backdrops).toHaveLength(1)
    expect(body.logos).toHaveLength(1)
    expect(body.posters[0]).toMatchObject({ url: POSTER, source: "tvdb", type: 2 })
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain("env-tvdb-key")
    expect(serialized).not.toContain("mock-jwt")
    expect(serialized).not.toContain("api_key")
  })

  it("200 with grouped movie artworks (14/15/25)", async () => {
    installRouter()
    const res = await GET(makeRequest("/api/tvdb/322/artworks?type=movie"), params("322"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.posters[0]).toMatchObject({ type: 14 })
    expect(body.backdrops[0]).toMatchObject({ type: 15 })
    expect(body.logos[0]).toMatchObject({ type: 25 })
  })

  it("TVDB key never in query string (Bearer only outbound)", async () => {
    const { requested } = installRouter()
    await GET(makeRequest("/api/tvdb/400/artworks?type=tv"), params("400"))
    const tvdbCalls = requested.filter((u) => u.includes("api4.thetvdb.com"))
    expect(tvdbCalls.length).toBeGreaterThan(0)
    for (const u of tvdbCalls) expect(u).not.toMatch(/api[_-]?key|apikey/i)
  })

  it("502 tvdb_auth_error on rejected key, never cached as failure", async () => {
    const { fetchMock, requested } = installRouter({ login: "auth" })
    const first = await GET(makeRequest("/api/tvdb/500/artworks?type=tv"), params("500"))
    expect(first.status).toBe(502)
    expect(await first.json()).toMatchObject({ code: "tvdb_auth_error" })
    const second = await GET(makeRequest("/api/tvdb/500/artworks?type=tv"), params("500"))
    expect(second.status).toBe(502)
    // Failure never cached: the login is re-attempted (auth is validated
    // before any gallery work, so a rejected key fails fast with exactly
    // login x2 and the TMDB lookup is never attempted).
    expect(requested.filter((u) => u.endsWith("/login"))).toHaveLength(2)
    expect(requested.filter((u) => u.includes("/external_ids"))).toHaveLength(0)
    expect(fetchMock.mock.calls.length).toBe(2)
  })

  it("502 tvdb_unavailable on upstream artworks failure, never cached", async () => {
    const { fetchMock } = installRouter({ seriesArts: { status: 500 } })
    const first = await GET(makeRequest("/api/tvdb/501/artworks?type=tv"), params("501"))
    expect(first.status).toBe(502)
    expect(await first.json()).toMatchObject({ code: "tvdb_unavailable" })
    const callsAfterFirst = fetchMock.mock.calls.length
    const second = await GET(makeRequest("/api/tvdb/501/artworks?type=tv"), params("501"))
    expect(second.status).toBe(502)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst)
  })

  it("502 tvdb_unavailable when TMDB external_ids fails (no failure cached as empty)", async () => {
    installRouter({ ext: "fail" })
    const res = await GET(makeRequest("/api/tvdb/502/artworks?type=tv"), params("502"))
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ code: "tvdb_unavailable" })
  })

  it("200 honest empty when no TVDB link (never borrowed tiles)", async () => {
    installRouter({ ext: { tvdb_id: null, imdb_id: null } })
    const res = await GET(makeRequest("/api/tvdb/503/artworks?type=tv"), params("503"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ posters: [], backdrops: [], logos: [], source: "tvdb" })
  })

  it("200 honest empty on confirmed 404 artworks", async () => {
    installRouter({ seriesArts: { status: 404 } })
    const res = await GET(makeRequest("/api/tvdb/504/artworks?type=tv"), params("504"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ posters: [], backdrops: [], logos: [], source: "tvdb" })
  })

  it("502 tvdb_unavailable on aborted caller without poisoning caches", async () => {
    const { requested } = installRouter()
    const ctrl = new AbortController()
    ctrl.abort()
    const res = await GET(
      makeRequest("/api/tvdb/505/artworks?type=tv", { signal: ctrl.signal }),
      params("505"),
    )
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ code: "tvdb_unavailable" })
    expect(requested.filter((u) => u.includes("/artworks") || u.includes("/extended"))).toEqual([])
  })

  it("explicit tvdb_key query wins over env (user key priority, no cross-user env)", async () => {
    const { loginBodies } = installRouter()
    const res = await GET(makeRequest("/api/tvdb/600/artworks?type=tv&tvdb_key=EXPLICIT-KEY"), params("600"))
    expect(res.status).toBe(200)
    expect(loginBodies.join("")).toContain("EXPLICIT-KEY")
    expect(loginBodies.join("")).not.toContain("env-tvdb-key")
  })

  it("explicit x-tvdb-key header wins over env", async () => {
    const { loginBodies } = installRouter()
    const req = makeRequest("/api/tvdb/601/artworks?type=tv")
    req.headers.set("x-tvdb-key", "HEADER-KEY")
    const res = await GET(req, params("601"))
    expect(res.status).toBe(200)
    expect(loginBodies.join("")).toContain("HEADER-KEY")
    expect(loginBodies.join("")).not.toContain("env-tvdb-key")
  })

  it("scoped request without key gets no instance env fallback (503, no cross-user borrow)", async () => {
    process.env.PICTORIUM_MULTI_USER = "1"
    installRouter()
    const res = await GET(makeRequest(`/api/tvdb/602/artworks?type=tv&u=${UUID}`), params("602"))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: "tvdb_not_configured" })
  })

  it("successful response is cached (stale-free second hit without network)", async () => {
    const { fetchMock } = installRouter()
    const first = await GET(makeRequest("/api/tvdb/700/artworks?type=tv"), params("700"))
    expect(first.status).toBe(200)
    const calls = fetchMock.mock.calls.length
    expect(calls).toBeGreaterThan(0)
    const second = await GET(makeRequest("/api/tvdb/700/artworks?type=tv"), params("700"))
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual(await first.json())
    expect(fetchMock.mock.calls.length).toBe(calls)
  })

  it("123 vs 00123 share one normalized cache entry (no duplicates)", async () => {
    const { fetchMock } = installRouter()
    const { cacheGet } = await import("@/lib/cache")
    const first = await GET(makeRequest("/api/tvdb/00123/artworks?type=tv"), params("00123"))
    expect(first.status).toBe(200)
    // Normalized to the validated integer: both spellings address one entry.
    expect(cacheGet("tvdb:artworks:tv:123")).not.toBeNull()
    const calls = fetchMock.mock.calls.length
    expect(calls).toBeGreaterThan(0)
    const second = await GET(makeRequest("/api/tvdb/123/artworks?type=tv"), params("123"))
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual(await first.json())
    expect(fetchMock.mock.calls.length).toBe(calls)
  })

  it("types filter restricts to supplied numeric ids; unknown filter ids stay empty; garbage 400", async () => {
    installRouter()
    const postersOnly = await GET(makeRequest("/api/tvdb/800/artworks?type=tv&types=2"), params("800"))
    expect(postersOnly.status).toBe(200)
    const body = await postersOnly.json()
    expect(body.posters).toHaveLength(1)
    expect(body.backdrops).toEqual([])
    expect(body.logos).toEqual([])

    const unknown = await GET(makeRequest("/api/tvdb/800/artworks?type=tv&types=7"), params("800"))
    expect(unknown.status).toBe(200)
    expect(await unknown.json()).toEqual({ posters: [], backdrops: [], logos: [], source: "tvdb" })

    const bad = await GET(makeRequest("/api/tvdb/800/artworks?type=tv&types=nope"), params("800"))
    expect(bad.status).toBe(400)
  })
})

describe("TVDB render/save gates for gallery URLs (existing secure path)", () => {
  it("gallery poster URL passes the render imgSrc gate; evil lookalikes blocked", () => {
    expect(imgSrc(POSTER)).toBe(POSTER)
    expect(imgSrc(LOGO)).toBe(LOGO)
    expect(() => imgSrc("https://artworks.thetvdb.com.evil.example/x.jpg")).toThrow()
    expect(() => imgSrc("https://evil.example/x.jpg")).toThrow()
    expect(() => imgSrc("http://artworks.thetvdb.com/banners/v4/poster/1.jpg")).toThrow()
  })

  it("resolve allowlist admits exact artworks host, rejects lookalikes/subdomains/ports/userinfo", () => {
    expect(isAllowedResolveHost("artworks.thetvdb.com")).toBe(true)
    for (const h of [
      "evilartworks.thetvdb.com",
      "artworks.thetvdb.com.evil.com",
      "sub.artworks.thetvdb.com",
      "example.com",
    ]) {
      expect(isAllowedResolveHost(h)).toBe(false)
    }
  })

  it("saved TVDB custom poster verifies through the shared raster pipeline", async () => {
    const signal = AbortSignal.timeout(60_000)
    const buf = await fetchValidatedCustomImage(POSTER, signal, {
      checkBlocked: async () => false,
      fetchRemote: async () =>
        new Response(PNG_1X1 as unknown as BodyInit, { status: 200, headers: { "content-type": "image/png" } }),
    })
    expect(buf).not.toBeNull()
  })

  it("SVG through the TVDB host is rejected by byte validation (no vector through custom gate)", async () => {
    const signal = AbortSignal.timeout(60_000)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="150"><rect width="100" height="150" fill="red"/></svg>`
    const buf = await fetchValidatedCustomImage("https://artworks.thetvdb.com/banners/v4/clearlogo/x.svg", signal, {
      checkBlocked: async () => false,
      fetchRemote: async () =>
        new Response(svg as unknown as BodyInit, { status: 200, headers: { "content-type": "image/svg+xml" } }),
    })
    expect(buf).toBeNull()
  })
})
