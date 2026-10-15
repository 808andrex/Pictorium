import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fetchUnifiedCatalogResult } from "@/lib/custom-catalog-providers"
import { catalogStatusErrorKey } from "@/lib/catalog-provider-detect"
import { cacheClear } from "@/lib/cache"

const OWNER_A = "11111111-1111-1111-1111-111111111111"
const OWNER_B = "22222222-2222-2222-2222-222222222222"
const CLIENT_ID = "test-trakt-private-client-id"
const WATCHLIST_URL = "https://trakt.tv/users/alice/watchlist"
const PRIVATE_LIST_URL = "https://trakt.tv/users/alice/lists/secret-mix"
const PUBLIC_LIST_URL = "https://trakt.tv/users/alice/lists/public-mix"
const BARE_LIST_URL = "https://trakt.tv/lists/12345"
const SMART_URL = "https://app.trakt.tv/lists/smart/view/films-abc123?mode=movie"
const ANTICIPATED_URL = "https://app.trakt.tv/discover/anticipated?mode=movie"
const TRENDING_URL = "https://app.trakt.tv/discover/trending?mode=movie"

const traktCtl = vi.hoisted(() => ({
  token: "owner-access-token",
  mode: "token" as "token" | "disconnected" | "reconnect_required" | "temporary" | "not_configured",
  gen: "gen-1" as string | null,
  genThrows: false,
  genQueue: [] as Array<string | null | "throw">,
  tokenCalls: [] as string[],
  genCalls: [] as string[],
  leaseCalls: [] as string[],
  // Hook injected by race tests: runs inside the lease AFTER the token state
  // is captured but BEFORE it is returned (i.e. between the valid-token read
  // and the generation-after read), simulating a disconnect/wipe landing in
  // that window. Runs once, then clears itself.
  afterTokenRead: null as null | (() => void),
}))

function readGenForLease(userId: string): Promise<string | null> {
  traktCtl.genCalls.push(userId)
  if (traktCtl.genQueue.length > 0) {
    const next = traktCtl.genQueue.shift()!
    if (next === "throw") throw new Error("generation outage (injected)")
    return Promise.resolve(next)
  }
  if (traktCtl.genThrows) throw new Error("generation outage (injected)")
  return Promise.resolve(traktCtl.gen)
}

function readValidForLease(userId: string): { ok: true; accessToken: string } | { ok: false; reason: string } {
  traktCtl.tokenCalls.push(userId)
  const mode = traktCtl.mode
  const token = traktCtl.token
  if (traktCtl.afterTokenRead) {
    const f = traktCtl.afterTokenRead
    traktCtl.afterTokenRead = null
    f()
  }
  if (mode === "token") return { ok: true, accessToken: token }
  return { ok: false, reason: mode }
}

// Faithful test double of the real `getTraktCatalogLease` contract (see
// trakt-auth.ts): stable generation-before/token/generation-after pair with
// one refresh-tolerant retry; fence movement fails closed as `temporary`;
// generation outage with a verified token degrades to `noCache` serve;
// without a verified token every outage maps to its typed reason.
async function leaseDouble(userId: string) {
  traktCtl.leaseCalls.push(userId)
  for (let attempt = 0; attempt < 2; attempt++) {
    let genBefore: string | null | undefined
    try {
      genBefore = await readGenForLease(userId)
    } catch {
      genBefore = undefined
    }
    const valid = readValidForLease(userId)
    if (!valid.ok) {
      const r = valid.reason
      if (r === "disconnected" || r === "reconnect_required") return { ok: false as const, reason: "connection_required" as const }
      if (r === "not_configured") return { ok: false as const, reason: "key_missing" as const }
      return { ok: false as const, reason: "temporary" as const }
    }
    let genAfter: string | null | undefined
    try {
      genAfter = await readGenForLease(userId)
    } catch {
      genAfter = undefined
    }
    if (genBefore === undefined || genAfter === undefined) {
      return { ok: true as const, accessToken: valid.accessToken, generation: null, noCache: true }
    }
    if (genBefore === genAfter) {
      return { ok: true as const, accessToken: valid.accessToken, generation: genAfter, noCache: false }
    }
    if (attempt === 0) continue
    return { ok: false as const, reason: "temporary" as const }
  }
  return { ok: false as const, reason: "temporary" as const }
}

vi.mock("@/lib/trakt-auth", () => ({
  getValidTraktAccessToken: vi.fn(async (userId: string) => {
    const r = readValidForLease(userId)
    if (r.ok) return { ok: true, accessToken: r.accessToken, refreshed: false }
    return { ok: false, reason: r.reason }
  }),
  getTraktCatalogLease: vi.fn(async (userId: string) => leaseDouble(userId)),
}))

vi.mock("@/lib/trakt-profile-lock", () => ({
  getTraktGeneration: vi.fn(async (userId: string) => {
    traktCtl.genCalls.push(userId)
    if (traktCtl.genThrows) throw new Error("generation outage (injected)")
    return traktCtl.gen
  }),
}))

interface FetchCall {
  url: string
  auth: string | null
  apiKey: string | null
}

const fetchCalls = vi.hoisted(() => [] as FetchCall[])
let fetchHandler: (url: string) => { status: number; payload: unknown } =
  () => ({ status: 404, payload: {} })

function jsonRes(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => payload,
  }
}

function watchlistRow(type: "movie" | "show", imdb: string, tmdb: number, title: string, year: number) {
  const media = { title, year, ids: { trakt: tmdb + 5000, slug: "x", imdb, tmdb } }
  return type === "movie"
    ? { rank: 1, listed_at: "2026-01-01T00:00:00.000Z", type, movie: media }
    : { rank: 2, listed_at: "2026-01-02T00:00:00.000Z", type, show: media }
}

function listRow(type: "movie" | "show", imdb: string, tmdb: number, title: string, year: number) {
  const media = { title, year, ids: { trakt: tmdb + 5000, slug: "x", imdb, tmdb } }
  return type === "movie" ? { type, movie: media } : { type, show: media }
}

describe("Trakt private catalogs: owning-user watchlist", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    cacheClear()
    process.env.PICTORIUM_TRAKT_CLIENT_ID = CLIENT_ID
    process.env.TRAKT_API_URL = "http://trakt.test"
    traktCtl.token = "owner-access-token"
    traktCtl.mode = "token"
    traktCtl.gen = "gen-1"
    traktCtl.genThrows = false
    traktCtl.genQueue.length = 0
    traktCtl.leaseCalls.length = 0
    traktCtl.afterTokenRead = null
    traktCtl.tokenCalls.length = 0
    traktCtl.genCalls.length = 0
    fetchCalls.length = 0
    fetchHandler = () => ({ status: 404, payload: {} })
    global.fetch = vi.fn().mockImplementation((url: string, init?: { headers?: Record<string, string> }) => {
      const h = init?.headers ?? {}
      fetchCalls.push({
        url: String(url),
        auth: (h["Authorization"] ?? h["authorization"] ?? null) as string | null,
        apiKey: (h["trakt-api-key"] ?? null) as string | null,
      })
      const out = fetchHandler(String(url))
      return Promise.resolve(jsonRes(out.status, out.payload))
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    delete process.env.PICTORIUM_TRAKT_CLIENT_ID
    delete process.env.TRAKT_API_URL
    cacheClear()
  })

  it("serves the owning user's watchlist via the user-specific endpoint with Bearer + instance client ID", async () => {
    fetchHandler = (url) => {
      expect(url).toContain("http://trakt.test/users/alice/watchlist/movie,show/rank")
      return {
        status: 200,
        payload: [
          watchlistRow("movie", "tt0371746", 1726, "Iron Man", 2008),
          watchlistRow("show", "tt0903747", 1396, "Breaking Bad", 2008),
        ],
      }
    }
    const res = await fetchUnifiedCatalogResult(WATCHLIST_URL, { traktUserId: OWNER_A })
    expect(res.status).toBe("ok")
    expect(res.items).toHaveLength(2)
    expect(res.items[0]).toMatchObject({ imdb: "tt0371746", tmdb: 1726, title: "Iron Man", mediatype: "movie" })
    expect(res.items[1]).toMatchObject({ imdb: "tt0903747", tmdb: 1396, mediatype: "tv" })
    expect(fetchCalls).toHaveLength(1)
    // Official user-specific path: never /me, never /sync substitution.
    expect(fetchCalls[0].url).not.toContain("/me")
    expect(fetchCalls[0].url).not.toContain("/sync/")
    expect(fetchCalls[0].auth).toBe("Bearer owner-access-token")
    expect(fetchCalls[0].apiKey).toBe(CLIENT_ID)
    // Never a remote production call under the test override.
    expect(fetchCalls.every((c) => !c.url.includes("api.trakt.tv"))).toBe(true)
  })

  it("serves the owning user's private standard list with Bearer", async () => {
    fetchHandler = (url) => {
      expect(url).toContain("http://trakt.test/users/alice/lists/secret-mix/items/movie,show")
      return { status: 200, payload: [listRow("movie", "tt0111161", 278, "Shawshank", 1994)] }
    }
    const res = await fetchUnifiedCatalogResult(PRIVATE_LIST_URL, { traktUserId: OWNER_A })
    expect(res.status).toBe("ok")
    expect(res.items).toHaveLength(1)
    expect(fetchCalls[0].auth).toBe("Bearer owner-access-token")
    expect(fetchCalls[0].apiKey).toBe(CLIENT_ID)
  })

  it("keeps watchlist unsupported without an owning profile (public path unchanged, no network)", async () => {
    const res = await fetchUnifiedCatalogResult(WATCHLIST_URL)
    expect(res).toMatchObject({ status: "unsupported", items: [] })
    expect(fetchCalls).toHaveLength(0)
    expect(traktCtl.tokenCalls).toHaveLength(0)
  })

  it("returns connection_required with zero private fetch when disconnected", async () => {
    traktCtl.mode = "disconnected"
    const res = await fetchUnifiedCatalogResult(WATCHLIST_URL, { traktUserId: OWNER_A })
    expect(res).toMatchObject({ status: "connection_required", items: [] })
    expect(fetchCalls).toHaveLength(0)
    expect(traktCtl.tokenCalls).toEqual([OWNER_A])
  })

  it("returns connection_required (no network) on reconnect_required, temporary on transient", async () => {
    traktCtl.mode = "reconnect_required"
    expect(await fetchUnifiedCatalogResult(WATCHLIST_URL, { traktUserId: OWNER_A })).toMatchObject({
      status: "connection_required",
      items: [],
    })
    expect(fetchCalls).toHaveLength(0)
    traktCtl.mode = "temporary"
    expect(await fetchUnifiedCatalogResult("https://trakt.tv/users/alice/watchlist", { traktUserId: OWNER_A })).toMatchObject({
      status: "temporary",
      items: [],
    })
    expect(fetchCalls).toHaveLength(0)
  })

  it("returns key_missing for watchlist when deployment OAuth is not configured", async () => {
    traktCtl.mode = "not_configured"
    const res = await fetchUnifiedCatalogResult(WATCHLIST_URL, { traktUserId: OWNER_A })
    expect(res).toMatchObject({ status: "key_missing", items: [] })
    expect(fetchCalls).toHaveLength(0)
  })

  it("maps upstream 401 (dead grant → reconnect) /403/404/429/timeout on the authenticated path (no token leak)", async () => {
    for (const [http, expected] of [
      // Correction cycle 1: a 401 against a just-validated Bearer means the
      // grant died (revoked/expired past refresh) — explicit reconnect, never
      // a silent `private`. 403 stays genuinely private (valid token, denied).
      [401, "connection_required"],
      [403, "private"],
      [404, "not_found"],
      [429, "rate_limited"],
      [500, "temporary"],
    ] as const) {
      fetchCalls.length = 0
      fetchHandler = () => ({ status: http, payload: {} })
      const res = await fetchUnifiedCatalogResult(`https://trakt.tv/users/alice/watchlist?probe=${http}`, {
        traktUserId: OWNER_A,
      })
      expect(res).toMatchObject({ status: expected, items: [] })
    }
    fetchCalls.length = 0
    global.fetch = vi.fn().mockRejectedValue(new Error("timeout")) as unknown as typeof fetch
    const res = await fetchUnifiedCatalogResult("https://trakt.tv/users/alice/watchlist", { traktUserId: OWNER_A })
    expect(res).toMatchObject({ status: "temporary", items: [] })
  })

  it("fetches the pasted username as-is (never /me): someone else's private watchlist is private, not substituted", async () => {
    fetchHandler = (url) => {
      expect(url).toContain("/users/bob/watchlist/movie,show/rank")
      return { status: 403, payload: {} }
    }
    const res = await fetchUnifiedCatalogResult("https://trakt.tv/users/bob/watchlist", { traktUserId: OWNER_A })
    expect(res).toMatchObject({ status: "private", items: [] })
    expect(fetchCalls[0].url).not.toContain("/me")
    expect(fetchCalls[0].auth).toBe("Bearer owner-access-token")
  })

  it("preserves public access for a disconnected owner on public lists, reconnect hint on privately-denied ones", async () => {
    traktCtl.mode = "disconnected"
    // Public list: served without any Authorization header.
    fetchHandler = () => ({ status: 200, payload: [listRow("movie", "tt0111161", 278, "Shawshank", 1994)] })
    const pub = await fetchUnifiedCatalogResult(PUBLIC_LIST_URL, { traktUserId: OWNER_A })
    expect(pub.status).toBe("ok")
    expect(pub.items).toHaveLength(1)
    expect(fetchCalls[0].auth ?? null).toBeNull()
    // Upstream-denied while disconnected: explicit reconnect hint, never silent private.
    fetchCalls.length = 0
    fetchHandler = () => ({ status: 401, payload: {} })
    const priv = await fetchUnifiedCatalogResult(PRIVATE_LIST_URL, { traktUserId: OWNER_A })
    expect(priv).toMatchObject({ status: "connection_required", items: [] })
  })

  it("reports temporary (not masked) when the token is transient and the public path also fails", async () => {
    traktCtl.mode = "temporary"
    fetchHandler = () => ({ status: 401, payload: {} })
    const res = await fetchUnifiedCatalogResult(PRIVATE_LIST_URL, { traktUserId: OWNER_A })
    expect(res).toMatchObject({ status: "temporary", items: [] })
  })

  it("keeps bare /lists/<id> on the public path even with an owning profile (no Bearer, shared public key)", async () => {
    fetchHandler = (url) => {
      expect(url).toContain("http://trakt.test/lists/12345/items/movie,show")
      return { status: 200, payload: [listRow("movie", "tt0111161", 278, "Shawshank", 1994)] }
    }
    const res = await fetchUnifiedCatalogResult(BARE_LIST_URL, { traktUserId: OWNER_A })
    expect(res.status).toBe("ok")
    expect(fetchCalls[0].auth ?? null).toBeNull()
    expect(traktCtl.tokenCalls).toHaveLength(0)
  })

  it("keeps Smart Lists unsupported with zero network even with an owning profile", async () => {
    const res = await fetchUnifiedCatalogResult(SMART_URL, { traktUserId: OWNER_A })
    expect(res).toMatchObject({ status: "unsupported", items: [] })
    expect(fetchCalls).toHaveLength(0)
    expect(traktCtl.tokenCalls).toHaveLength(0)
  })

  it("never resolves an auth context for discovery (anticipated/trending stay public, no token touch)", async () => {
    fetchHandler = () => ({
      status: 200,
      payload: [{ list_count: 3, movie: { title: "M", year: 2026, ids: { imdb: "tt1000001", tmdb: 1 } } }],
    })
    const a = await fetchUnifiedCatalogResult(ANTICIPATED_URL, { traktUserId: OWNER_A })
    expect(a.status).toBe("ok")
    fetchHandler = () => ({
      status: 200,
      payload: [{ watchers: 9, movie: { title: "T", year: 2026, ids: { imdb: "tt1000002", tmdb: 2 } } }],
    })
    const t = await fetchUnifiedCatalogResult(TRENDING_URL, { traktUserId: OWNER_A })
    expect(t.status).toBe("ok")
    expect(traktCtl.tokenCalls).toHaveLength(0)
    expect(fetchCalls.every((c) => (c.auth ?? null) === null)).toBe(true)
  })

  it("isolates two owners pasting the same URL across cache layers (per-UUID + generation key)", async () => {
    fetchHandler = () => ({
      status: 200,
      payload: [watchlistRow("movie", "tt0371746", 1726, "Iron Man", 2008)],
    })
    traktCtl.token = "token-A"
    traktCtl.gen = "gen-A1"
    const a = await fetchUnifiedCatalogResult(WATCHLIST_URL, { traktUserId: OWNER_A })
    expect(a.status).toBe("ok")
    traktCtl.token = "token-B"
    traktCtl.gen = "gen-B1"
    const b = await fetchUnifiedCatalogResult(WATCHLIST_URL, { traktUserId: OWNER_B })
    expect(b.status).toBe("ok")
    // Two upstream calls with distinct Bearers: B never saw A's cached items.
    expect(fetchCalls).toHaveLength(2)
    expect(fetchCalls[0].auth).toBe("Bearer token-A")
    expect(fetchCalls[1].auth).toBe("Bearer token-B")
    // Repeat for A: served from A's cache entry (no third call).
    traktCtl.token = "token-A"
    traktCtl.gen = "gen-A1"
    await fetchUnifiedCatalogResult(WATCHLIST_URL, { traktUserId: OWNER_A })
    expect(fetchCalls).toHaveLength(2)
  })

  it("refetches after a generation bump (disconnect/reconnect invalidates the cache identity, no stale serving)", async () => {
    fetchHandler = () => ({
      status: 200,
      payload: [watchlistRow("movie", "tt0371746", 1726, "Iron Man", 2008)],
    })
    traktCtl.gen = "gen-1"
    expect((await fetchUnifiedCatalogResult(WATCHLIST_URL, { traktUserId: OWNER_A })).status).toBe("ok")
    expect(fetchCalls).toHaveLength(1)
    // Generation bump (disconnect + reconnect recycle the fence): old key unreachable.
    traktCtl.gen = "gen-2"
    expect((await fetchUnifiedCatalogResult(WATCHLIST_URL, { traktUserId: OWNER_A })).status).toBe("ok")
    expect(fetchCalls).toHaveLength(2)
  })

  it("serves without caching when the fencing generation is unreadable (outage: no shared/guessable key)", async () => {
    fetchHandler = () => ({
      status: 200,
      payload: [watchlistRow("movie", "tt0371746", 1726, "Iron Man", 2008)],
    })
    traktCtl.genThrows = true
    expect((await fetchUnifiedCatalogResult(WATCHLIST_URL, { traktUserId: OWNER_A })).status).toBe("ok")
    expect((await fetchUnifiedCatalogResult(WATCHLIST_URL, { traktUserId: OWNER_A })).status).toBe("ok")
    expect(fetchCalls).toHaveLength(2)
    traktCtl.genThrows = false
  })

  it("maps the new statuses to explicit UI keys (never a silent empty)", async () => {
    expect(catalogStatusErrorKey("connection_required", "trakt")).toBe("ui.customErrTraktReconnect")
    expect(catalogStatusErrorKey("temporary", "trakt")).toBe("ui.customErrTemporary")
    // Established mappings are untouched.
    expect(catalogStatusErrorKey("private", "trakt")).toBe("ui.customErrPrivate")
    expect(catalogStatusErrorKey("unsupported", "trakt")).toBe("ui.customErrUnsupported")
  })

  it("never couples an old token to a new fence when disconnect lands between the token and generation reads", async () => {
    // Correction cycle 1: the lease captures a valid token, then the fence
    // moves before the generation-after read. The retry then observes the
    // disconnect and fails closed as connection_required — zero private
    // fetch, nothing cached under either fence.
    fetchHandler = () => ({
      status: 200,
      payload: [watchlistRow("movie", "tt0371746", 1726, "Iron Man", 2008)],
    })
    traktCtl.afterTokenRead = () => {
      traktCtl.mode = "disconnected"
      traktCtl.gen = "gen-2"
    }
    const res = await fetchUnifiedCatalogResult(WATCHLIST_URL, { traktUserId: OWNER_A })
    expect(res).toMatchObject({ status: "connection_required", items: [] })
    expect(fetchCalls).toHaveLength(0)
    // A follow-up while still disconnected stays explicit with no fetch.
    expect(await fetchUnifiedCatalogResult(WATCHLIST_URL, { traktUserId: OWNER_A })).toMatchObject({
      status: "connection_required",
      items: [],
    })
    expect(fetchCalls).toHaveLength(0)
  })

  it("fails closed as temporary on a persistently moving fence (never binds a token across generations)", async () => {
    fetchHandler = () => ({
      status: 200,
      payload: [watchlistRow("movie", "tt0371746", 1726, "Iron Man", 2008)],
    })
    // Every generation read observes a new fence: both stable-pair attempts
    // fail, so no token is ever bound and no fetch happens.
    traktCtl.genQueue.push("gen-A", "gen-B", "gen-C", "gen-D")
    const res = await fetchUnifiedCatalogResult(WATCHLIST_URL, { traktUserId: OWNER_A })
    expect(res).toMatchObject({ status: "temporary", items: [] })
    expect(fetchCalls).toHaveLength(0)
  })

  it("suppresses private items when disconnect lands during the list fetch (no stale write, no stale return)", async () => {
    let flipOnce = true
    fetchHandler = () => {
      if (flipOnce) {
        flipOnce = false
        // Disconnect wins the race mid-fetch: fresh fence, no connection.
        traktCtl.mode = "disconnected"
        traktCtl.gen = "gen-2"
      }
      return {
        status: 200,
        payload: [watchlistRow("movie", "tt0371746", 1726, "Iron Man", 2008)],
      }
    }
    const res1 = await fetchUnifiedCatalogResult(WATCHLIST_URL, { traktUserId: OWNER_A })
    expect(res1).toMatchObject({ status: "connection_required", items: [] })
    expect(fetchCalls).toHaveLength(1)
    // The suppressed response must not have populated any cache entry: back
    // on the original fence with a live connection, the next request
    // refetches instead of serving the raced items from cache.
    traktCtl.mode = "token"
    traktCtl.gen = "gen-1"
    const res2 = await fetchUnifiedCatalogResult(WATCHLIST_URL, { traktUserId: OWNER_A })
    expect(res2.status).toBe("ok")
    expect(res2.items).toHaveLength(1)
    expect(fetchCalls).toHaveLength(2)
  })

  it("outage responses never populate any cache entry (no shared/guessable private key)", async () => {
    fetchHandler = () => ({
      status: 200,
      payload: [watchlistRow("movie", "tt0371746", 1726, "Iron Man", 2008)],
    })
    traktCtl.genThrows = true
    expect((await fetchUnifiedCatalogResult(WATCHLIST_URL, { traktUserId: OWNER_A })).status).toBe("ok")
    expect((await fetchUnifiedCatalogResult(WATCHLIST_URL, { traktUserId: OWNER_A })).status).toBe("ok")
    expect(fetchCalls).toHaveLength(2)
    // Fence readable again: a third request must refetch (miss), proving the
    // outage responses wrote nothing under any key.
    traktCtl.genThrows = false
    traktCtl.gen = "gen-1"
    expect((await fetchUnifiedCatalogResult(WATCHLIST_URL, { traktUserId: OWNER_A })).status).toBe("ok")
    expect(fetchCalls).toHaveLength(3)
  })

  it("temporary token reads never resolve to a cached private body (fence key is unreachable without a verified lease)", async () => {
    fetchHandler = () => ({
      status: 200,
      payload: [watchlistRow("movie", "tt0371746", 1726, "Iron Man", 2008)],
    })
    expect((await fetchUnifiedCatalogResult(WATCHLIST_URL, { traktUserId: OWNER_A })).status).toBe("ok")
    expect(fetchCalls).toHaveLength(1)
    // Same fence, token store transient (e.g. encryption unavailable): the
    // lease is unverifiable, so the cached private body must not resolve —
    // explicit temporary, zero private fetch.
    traktCtl.mode = "temporary"
    const res = await fetchUnifiedCatalogResult(WATCHLIST_URL, { traktUserId: OWNER_A })
    expect(res).toMatchObject({ status: "temporary", items: [] })
    expect(fetchCalls).toHaveLength(1)
  })
})
