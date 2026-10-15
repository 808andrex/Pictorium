import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { GET } from "@/app/catalog/[type]/[id]/route"
import { cacheClear } from "@/lib/cache"
import { encodeConfig } from "@/lib/config-token"

const OWNER_A = "44444444-4444-4444-4444-444444444444"
const OWNER_B = "55555555-5555-5555-5555-555555555555"
const CID = "priv1"
const WATCHLIST = "https://trakt.tv/users/alice/watchlist"

const connCtl = vi.hoisted(() => ({
  mode: {} as Record<string, "token" | "disconnected" | "temporary">,
  token: {} as Record<string, string>,
  gen: {} as Record<string, string>,
  genThrows: {} as Record<string, boolean>,
  // Scripted per-call lease responses for mid-request fence-movement tests:
  // when non-empty, the lease double serves these in order instead of
  // deriving from mode/gen state. Cleared after each test.
  leaseScript: [] as Array<{
    ok: boolean
    accessToken?: string
    generation?: string | null
    noCache?: boolean
    reason?: "connection_required" | "temporary" | "key_missing"
  }>,
}))

vi.mock("@/lib/store", () => ({
  getById: vi.fn(async () => null),
}))

vi.mock("@/lib/server-defaults", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/server-defaults")>()
  return { ...mod, getServerDefaultsForUser: vi.fn(async () => ({})) }
})

vi.mock("@/lib/user-auth", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/user-auth")>()
  return {
    ...mod,
    userExists: vi.fn(async () => true),
    userRateLimitKey: (_req: Request, uid: string) => `test|user:${uid}`,
  }
})

vi.mock("@/lib/user-activity", () => ({
  touchUserActivity: vi.fn(),
}))

vi.mock("@/lib/trakt-auth", () => ({
  getValidTraktAccessToken: vi.fn(async (userId: string) => {
    if (connCtl.mode[userId] === "token") {
      return { ok: true, accessToken: connCtl.token[userId], refreshed: false }
    }
    return { ok: false, reason: connCtl.mode[userId] === "temporary" ? "temporary" : "disconnected" }
  }),
  // Faithful test double of the real `getTraktCatalogLease` contract (see
  // trakt-auth.ts): verified token + stable fence → keyed lease; fence
  // outage with a verified token → noCache serve; anything unverifiable →
  // typed reason (fail-closed, never a guessed identity).
  getTraktCatalogLease: vi.fn(async (userId: string) => {
    if (connCtl.leaseScript.length > 0) return connCtl.leaseScript.shift()
    const mode = connCtl.mode[userId]
    const token = connCtl.token[userId]
    if (connCtl.genThrows[userId]) {
      if (mode !== "token") return { ok: false, reason: "connection_required" }
      return { ok: true, accessToken: token, generation: null, noCache: true }
    }
    const gen = connCtl.gen[userId] ?? null
    if (mode === "token") return { ok: true, accessToken: token, generation: gen, noCache: false }
    if (mode === "temporary") return { ok: false, reason: "temporary" }
    return { ok: false, reason: "connection_required" }
  }),
}))

vi.mock("@/lib/trakt-profile-lock", () => ({
  getTraktGeneration: vi.fn(async (userId: string) => connCtl.gen[userId] ?? null),
}))

const traktCalls = vi.hoisted(() => [] as { url: string; auth: string | null }[])

function traktMovie(imdb: string, tmdb: number, title: string) {
  return {
    rank: 1,
    listed_at: "2026-01-01T00:00:00.000Z",
    type: "movie",
    movie: { title, year: 2008, ids: { trakt: tmdb + 5000, slug: "x", imdb, tmdb } },
  }
}

function token(): string {
  return encodeConfig({
    globalBadges: true,
    rankingBadges: true,
    badgeStyle: "pill",
    rankingBadgeStyle: "pill",
    blurEnabled: true,
    blurIntensity: 12,
    blurFade: 45,
    blurDarkness: 55,
    gradientHeight: 50,
    networkLogo: true,
    autoRotateClean: false,
    customCatalogs: [{ id: CID, name: "Private", type: "mixed", url: WATCHLIST, enabled: true }],
  })
}

function catalogReq(user: string, cfg: string) {
  return new NextRequest(
    `http://localhost:3000/catalog/movie/pictorium-custom-movie-${CID}.json?u=${user}&api_key=test-key&config=${cfg}`,
  )
}

describe("Stremio catalog: owning-user private Trakt watchlist (task 4)", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    cacheClear()
    process.env.PICTORIUM_TRAKT_CLIENT_ID = "test-trakt-client-id"
    process.env.TRAKT_API_URL = "http://trakt.test"
    process.env.PICTORIUM_MULTI_USER = "1"
    traktCalls.length = 0
    connCtl.mode = { [OWNER_A]: "token", [OWNER_B]: "token" }
    connCtl.token = { [OWNER_A]: "token-A", [OWNER_B]: "token-B" }
    connCtl.gen = { [OWNER_A]: "gen-A1", [OWNER_B]: "gen-B1" }
    connCtl.genThrows = {}
    connCtl.leaseScript.length = 0
    global.fetch = vi.fn().mockImplementation((url: unknown, init?: { headers?: Record<string, string> }) => {
      const u = String(url)
      if (u.startsWith("http://trakt.test/")) {
        const h = init?.headers ?? {}
        const auth = (h["Authorization"] ?? null) as string | null
        traktCalls.push({ url: u, auth })
        // Per-owner payloads: proves no cross-user serving from any layer.
        const title = auth === "Bearer token-B" ? "Dune" : "Iron Man"
        const imdb = auth === "Bearer token-B" ? "tt1160419" : "tt0371746"
        const tmdb = auth === "Bearer token-B" ? 438631 : 1726
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => [traktMovie(imdb, tmdb, title), traktMovie("tt0111161", 278, "Shawshank")],
        })
      }
      if (u.includes("/images")) {
        const m = u.match(/\/(?:movie|tv)\/(\d+)/)
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ id: Number(m?.[1] ?? 0), logos: [] }),
        })
      }
      if (u.includes("themoviedb.org")) {
        const m = u.match(/\/(?:movie|tv)\/(\d+)/)
        const id = Number(m?.[1] ?? 0)
        const knownTitle = id === 1726 ? "Iron Man" : id === 438631 ? "Dune" : id === 278 ? "Shawshank" : `Title ${id}`
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            id,
            title: knownTitle,
            name: knownTitle,
            genres: [],
            vote_average: 7.5,
            release_date: "2008-01-01",
            backdrop_path: null,
            overview: "",
          }),
        })
      }
      return Promise.resolve({ ok: false, status: 404, headers: new Headers(), json: async () => ({}) })
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    delete process.env.PICTORIUM_TRAKT_CLIENT_ID
    delete process.env.TRAKT_API_URL
    delete process.env.PICTORIUM_MULTI_USER
    cacheClear()
  })

  it("serves private items while connected, caches, then serves nothing after disconnect (no stale, zero private fetch)", async () => {
    const cfg = token()
    // 1. Connected: private items served through the owner namespace.
    const r1 = await GET(catalogReq(OWNER_A, cfg), {
      params: Promise.resolve({ type: "movie", id: `pictorium-custom-movie-${CID}.json` }),
    })
    const b1 = (await r1.json()) as { metas: Array<{ id: string; name: string }> }
    expect(b1.metas).toHaveLength(2)
    expect(b1.metas[0].name).toBe("Iron Man")
    expect(traktCalls).toHaveLength(1)
    expect(traktCalls[0].auth).toBe("Bearer token-A")
    expect(traktCalls[0].url).toContain("/users/alice/watchlist/movie,show/rank")

    // 2. Repeat: served from cache (provider + handler), no new upstream call.
    const r2 = await GET(catalogReq(OWNER_A, cfg), {
      params: Promise.resolve({ type: "movie", id: `pictorium-custom-movie-${CID}.json` }),
    })
    expect(((await r2.json()) as { metas: unknown[] }).metas).toHaveLength(2)
    expect(traktCalls).toHaveLength(1)

    // 3. Disconnect (token gone + generation bumped): the pre-disconnect body
    // must NOT be served from memory/KV, and no private fetch may happen.
    connCtl.mode[OWNER_A] = "disconnected"
    connCtl.gen[OWNER_A] = "gen-A2"
    const r3 = await GET(catalogReq(OWNER_A, cfg), {
      params: Promise.resolve({ type: "movie", id: `pictorium-custom-movie-${CID}.json` }),
    })
    const b3 = (await r3.json()) as { metas: Array<{ name: string }> }
    expect(b3.metas).toHaveLength(0)
    expect(traktCalls).toHaveLength(1)

    // 4. Reconnect (fresh generation): private items served again via refetch.
    connCtl.mode[OWNER_A] = "token"
    connCtl.gen[OWNER_A] = "gen-A3"
    const r4 = await GET(catalogReq(OWNER_A, cfg), {
      params: Promise.resolve({ type: "movie", id: `pictorium-custom-movie-${CID}.json` }),
    })
    const b4 = (await r4.json()) as { metas: Array<{ name: string }> }
    expect(b4.metas).toHaveLength(2)
    expect(b4.metas[0].name).toBe("Iron Man")
    expect(traktCalls).toHaveLength(2)
  })

  it("never shares private items across owners using the same saved URL", async () => {
    const cfg = token()
    const ra = await GET(catalogReq(OWNER_A, cfg), {
      params: Promise.resolve({ type: "movie", id: `pictorium-custom-movie-${CID}.json` }),
    })
    const rb = await GET(catalogReq(OWNER_B, cfg), {
      params: Promise.resolve({ type: "movie", id: `pictorium-custom-movie-${CID}.json` }),
    })
    const ba = (await ra.json()) as { metas: Array<{ name: string }> }
    const bb = (await rb.json()) as { metas: Array<{ name: string }> }
    expect(ba.metas[0].name).toBe("Iron Man")
    expect(bb.metas[0].name).toBe("Dune")
    expect(traktCalls).toHaveLength(2)
  })

  it("cannot serve a cached private body on generation outage after disconnect (fail-closed, zero private fetch)", async () => {
    const cfg = token()
    // Connected: private items served and cached at every layer.
    const r1 = await GET(catalogReq(OWNER_A, cfg), {
      params: Promise.resolve({ type: "movie", id: `pictorium-custom-movie-${CID}.json` }),
    })
    expect(((await r1.json()) as { metas: unknown[] }).metas).toHaveLength(2)
    expect(traktCalls).toHaveLength(1)
    // Disconnect, then the fencing store goes down: the pre-disconnect body
    // (outer L1/L2 under the old fence) must NOT be served — the outer lookup
    // is bypassed on unverifiable identity and the provider reports the
    // explicit typed status with no private fetch.
    connCtl.mode[OWNER_A] = "disconnected"
    connCtl.gen[OWNER_A] = "gen-A2"
    connCtl.genThrows[OWNER_A] = true
    const r2 = await GET(catalogReq(OWNER_A, cfg), {
      params: Promise.resolve({ type: "movie", id: `pictorium-custom-movie-${CID}.json` }),
    })
    const b2 = (await r2.json()) as { metas: unknown[] }
    expect(b2.metas).toHaveLength(0)
    expect(traktCalls).toHaveLength(1)
  })

  it("never writes private bodies to the outer cache under an unverifiable fence (outage serve stays uncached)", async () => {
    const cfg = token()
    // Fence unreadable while connected: fresh private items are served (the
    // token is verified) but must persist nowhere.
    connCtl.genThrows[OWNER_A] = true
    const r1 = await GET(catalogReq(OWNER_A, cfg), {
      params: Promise.resolve({ type: "movie", id: `pictorium-custom-movie-${CID}.json` }),
    })
    expect(((await r1.json()) as { metas: unknown[] }).metas).toHaveLength(2)
    expect(traktCalls).toHaveLength(1)
    // Fence readable again on the same generation: a refetch (not a hit)
    // proves the outage response wrote nothing under any key.
    connCtl.genThrows[OWNER_A] = false
    const r2 = await GET(catalogReq(OWNER_A, cfg), {
      params: Promise.resolve({ type: "movie", id: `pictorium-custom-movie-${CID}.json` }),
    })
    expect(((await r2.json()) as { metas: unknown[] }).metas).toHaveLength(2)
    expect(traktCalls).toHaveLength(2)
    // ...and the fenced response caches normally afterwards.
    const r3 = await GET(catalogReq(OWNER_A, cfg), {
      params: Promise.resolve({ type: "movie", id: `pictorium-custom-movie-${CID}.json` }),
    })
    expect(((await r3.json()) as { metas: unknown[] }).metas).toHaveLength(2)
    expect(traktCalls).toHaveLength(2)
  })

  it("ignores same-generation cache hits when the token store becomes unavailable (no stale private serve)", async () => {
    const cfg = token()
    const r1 = await GET(catalogReq(OWNER_A, cfg), {
      params: Promise.resolve({ type: "movie", id: `pictorium-custom-movie-${CID}.json` }),
    })
    expect(((await r1.json()) as { metas: unknown[] }).metas).toHaveLength(2)
    expect(traktCalls).toHaveLength(1)
    // Baseline: repeat is a hit (no new upstream call).
    const rHit = await GET(catalogReq(OWNER_A, cfg), {
      params: Promise.resolve({ type: "movie", id: `pictorium-custom-movie-${CID}.json` }),
    })
    expect(((await rHit.json()) as { metas: unknown[] }).metas).toHaveLength(2)
    expect(traktCalls).toHaveLength(1)
    // Same fence, token reads transient (e.g. encryption unavailable): the
    // cached private body must not be served — explicit empty, zero private
    // fetch.
    connCtl.mode[OWNER_A] = "temporary"
    const r2 = await GET(catalogReq(OWNER_A, cfg), {
      params: Promise.resolve({ type: "movie", id: `pictorium-custom-movie-${CID}.json` }),
    })
    expect(((await r2.json()) as { metas: unknown[] }).metas).toHaveLength(0)
    expect(traktCalls).toHaveLength(1)
  })

  it("suppresses the private body when the fence moves between the provider fetch and the outer-cache write", async () => {
    const cfg = token()
    // Scripted mid-request fence movement: handler pre + provider pre/post
    // all observe gen-A1 (the provider serves and provider-caches under it),
    // but the outer post-fetch check observes gen-A2 — the body must be
    // suppressed, never served or outer-cached under the stale fence.
    connCtl.leaseScript.push(
      { ok: true, accessToken: "token-A", generation: "gen-A1", noCache: false },
      { ok: true, accessToken: "token-A", generation: "gen-A1", noCache: false },
      { ok: true, accessToken: "token-A", generation: "gen-A1", noCache: false },
      { ok: true, accessToken: "token-A", generation: "gen-A2", noCache: false },
    )
    const r1 = await GET(catalogReq(OWNER_A, cfg), {
      params: Promise.resolve({ type: "movie", id: `pictorium-custom-movie-${CID}.json` }),
    })
    expect(((await r1.json()) as { metas: unknown[] }).metas).toHaveLength(0)
    expect(traktCalls).toHaveLength(1)
    // Steady state on the new fence refetches and serves (nothing reachable
    // was written by the suppressed request).
    connCtl.mode[OWNER_A] = "token"
    connCtl.gen[OWNER_A] = "gen-A2"
    const r2 = await GET(catalogReq(OWNER_A, cfg), {
      params: Promise.resolve({ type: "movie", id: `pictorium-custom-movie-${CID}.json` }),
    })
    const b2 = (await r2.json()) as { metas: Array<{ name: string }> }
    expect(b2.metas).toHaveLength(2)
    expect(b2.metas[0].name).toBe("Iron Man")
    expect(traktCalls).toHaveLength(2)
  })
})
