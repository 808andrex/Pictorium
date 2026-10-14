import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ ok: true, retAfter: 0 })),
  rateLimitKey: vi.fn(() => "test"),
  rateLimitResponse: vi.fn(() => new Response("rate limited", { status: 429 })),
}))

vi.mock("@/lib/tmdb", () => ({
  getDetails: vi.fn(),
  resolveRouteApiKey: vi.fn(async () => undefined),
  tmdbFindByImdb: vi.fn(async () => 0),
  tmdbFindByTvdb: vi.fn(async () => 0),
}))

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ownerAuth = vi.hoisted(() => ({ ok: false }))

vi.mock("@/lib/user-auth", () => ({
  extractUserParam: (req: { url?: string }) => {
    try {
      const u = new URL(req.url ?? "")
      return u.searchParams.get("u") ?? u.searchParams.get("user")
    } catch {
      return null
    }
  },
  getScopedUserId: (value: string | null | undefined) => {
    const v = (value ?? "").trim().toLowerCase()
    return UUID_RE.test(v) ? v : null
  },
  isMultiUserEnabled: () => true,
  checkUserAuth: vi.fn(async () => ownerAuth.ok),
  invalidUserResponse: () =>
    new Response(JSON.stringify({ error: "Invalid user id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }),
  userAuthResponse: (status = 401) =>
    new Response(JSON.stringify({ error: "Unauthorized" }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
}))

vi.mock("@/lib/custom-catalog-providers", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/custom-catalog-providers")>()
  return {
    ...orig,
    fetchUnifiedCatalogResult: vi.fn(async () => ({ items: [], status: "ok" })),
  }
})

import { GET } from "@/app/api/mdblist/custom/route"
import { fetchUnifiedCatalogResult } from "@/lib/custom-catalog-providers"

const OWNER = "33333333-3333-3333-3333-333333333333"
const WATCHLIST = "https://trakt.tv/users/alice/watchlist"
const STD_LIST = "https://trakt.tv/users/alice/lists/mix"
const MDB_LIST = "https://mdblist.com/lists/u/some-list"

function previewReq(url: string, user: string | null, authed: boolean) {
  const u = new URL("http://localhost:3000/api/mdblist/custom")
  u.searchParams.set("url", url)
  if (user) u.searchParams.set("u", user)
  const headers = new Headers()
  if (authed) headers.set("x-user-token", "owner-secret")
  return new NextRequest(u.toString(), { headers })
}

describe("GET /api/mdblist/custom Trakt owner-private previews (task 4)", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    ownerAuth.ok = false
  })

  it("rejects watchlist preview without an owning profile (401, no provider call)", async () => {
    const res = await GET(previewReq(WATCHLIST, null, false))
    expect(res.status).toBe(401)
    expect(fetchUnifiedCatalogResult).not.toHaveBeenCalled()
  })

  it("rejects watchlist preview with ?u= but no/invalid headers (401, no provider call)", async () => {
    const res = await GET(previewReq(WATCHLIST, OWNER, false))
    expect(res.status).toBe(401)
    expect(fetchUnifiedCatalogResult).not.toHaveBeenCalled()
  })

  it("rejects watchlist preview with a garbage ?u= (400)", async () => {
    const res = await GET(previewReq(WATCHLIST, "not-a-uuid", false))
    expect(res.status).toBe(400)
    expect(fetchUnifiedCatalogResult).not.toHaveBeenCalled()
  })

  it("serves watchlist preview to the authenticated owner with their trusted UUID (never a request token)", async () => {
    ownerAuth.ok = true
    const res = await GET(previewReq(WATCHLIST, OWNER, true))
    expect(res.status).toBe(200)
    expect(vi.mocked(fetchUnifiedCatalogResult)).toHaveBeenCalledWith(
      WATCHLIST,
      expect.objectContaining({ traktUserId: OWNER }),
    )
    const opts = vi.mocked(fetchUnifiedCatalogResult).mock.calls[0][1] as Record<string, unknown>
    expect("traktToken" in opts).toBe(false)
    expect("accessToken" in opts).toBe(false)
  })

  it("keeps standard Trakt lists publicly previewable without login (no regression)", async () => {
    const res = await GET(previewReq(STD_LIST, null, false))
    expect(res.status).toBe(200)
    expect(vi.mocked(fetchUnifiedCatalogResult)).toHaveBeenCalledWith(
      STD_LIST,
      expect.objectContaining({ traktUserId: null }),
    )
  })

  it("rejects standard Trakt preview with ?u= but no/invalid headers (no arbitrary-UUID private access)", async () => {
    const res = await GET(previewReq(STD_LIST, OWNER, false))
    expect(res.status).toBe(401)
    expect(fetchUnifiedCatalogResult).not.toHaveBeenCalled()
  })

  it("passes the trusted UUID for standard Trakt lists when the owner authenticates", async () => {
    ownerAuth.ok = true
    const res = await GET(previewReq(STD_LIST, OWNER, true))
    expect(res.status).toBe(200)
    expect(vi.mocked(fetchUnifiedCatalogResult)).toHaveBeenCalledWith(
      STD_LIST,
      expect.objectContaining({ traktUserId: OWNER }),
    )
  })

  it("leaves non-Trakt previews untouched by the Trakt auth gate (?u= without headers still ignored)", async () => {
    const res = await GET(previewReq(MDB_LIST, OWNER, false))
    expect(res.status).toBe(200)
    expect(vi.mocked(fetchUnifiedCatalogResult)).toHaveBeenCalledWith(
      MDB_LIST,
      expect.objectContaining({ traktUserId: null }),
    )
  })
})
