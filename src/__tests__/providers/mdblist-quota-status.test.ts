// TaskA — operator-visible MDBList parked-key quota state (sanitized).
//
// The parked state lives in lib/mdblist-quota.ts as a bounded per-process
// in-memory map keyed by sha256(key). This suite pins the read-only
// operator summary exposed via the established protected surface
// (GET /api/cache/status, requireAdminToken fail-closed):
// counts + reset timing only, never keys/hashes/users/link mappings,
// expired entries excluded, strict access control, no-store cache headers,
// no extra MDBList calls, and no leak onto public /api/status.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GET as cacheStatusGET } from "@/app/api/cache/status/route"
import { GET as publicStatusGET } from "@/app/api/status/route"
import {
  __getMdbQuotaStateForTests,
  __resetMdbQuotaForTests,
  getMdbQuotaSummary,
  noteMdbQuotaExhausted429,
} from "@/lib/mdblist-quota"

const T0 = new Date("2026-01-15T12:00:00Z").getTime()
const resetSecIn = (ms: number): string => String(Math.floor((T0 + ms) / 1000))

function quotaHeaders(remaining: string, reset: string): Headers {
  return new Headers({ "X-RateLimit-Remaining": remaining, "X-RateLimit-Reset": reset })
}

const TEST_TOKEN = "operator-secret"

function adminReq(withAuth: boolean): Request {
  if (withAuth) process.env.ADMIN_TOKEN = TEST_TOKEN
  return new Request("http://localhost:3000/api/cache/status", {
    headers: withAuth ? { "x-admin-token": TEST_TOKEN } : {},
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  __resetMdbQuotaForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  __resetMdbQuotaForTests()
  delete process.env.ADMIN_TOKEN
})

describe("getMdbQuotaSummary (sanitized, per-process)", () => {
  it("empty state reports zero with null reset and process scope", () => {
    expect(getMdbQuotaSummary(T0)).toEqual({ parkedKeys: 0, nextResetAt: null, scope: "process" })
  })

  it("counts parked keys and reports the earliest reset, never hashes", () => {
    expect(noteMdbQuotaExhausted429(quotaHeaders("0", resetSecIn(7_200_000)), "op-key-one", T0)).toBe(true)
    expect(noteMdbQuotaExhausted429(quotaHeaders("0", resetSecIn(3_600_000)), "op-key-two", T0)).toBe(true)
    const summary = getMdbQuotaSummary(T0)
    expect(summary.parkedKeys).toBe(2)
    expect(summary.nextResetAt).toBe(new Date(T0 + 3_600_000 - (T0 % 1000)).toISOString())
    expect(summary.scope).toBe("process")
    expect(JSON.stringify(summary)).not.toContain("op-key-")
    for (const { hash } of __getMdbQuotaStateForTests()) {
      expect(JSON.stringify(summary)).not.toContain(hash)
    }
  })

  it("excludes expired entries from the report", () => {
    expect(noteMdbQuotaExhausted429(quotaHeaders("0", resetSecIn(30_000)), "op-key-exp", T0)).toBe(true)
    expect(getMdbQuotaSummary(T0).parkedKeys).toBe(1)
    vi.setSystemTime(T0 + 60_000)
    expect(getMdbQuotaSummary().parkedKeys).toBe(0)
    expect(getMdbQuotaSummary().nextResetAt).toBeNull()
  })
})

describe("GET /api/cache/status mdblistQuota (protected operator surface)", () => {
  it("includes the sanitized summary for authenticated operators with no-store headers", async () => {
    expect(noteMdbQuotaExhausted429(quotaHeaders("0", resetSecIn(3_600_000)), "op-key-route", T0)).toBe(true)
    const fetchSpy = vi.fn(async () => {
      throw new Error("no upstream allowed")
    })
    vi.stubGlobal("fetch", fetchSpy)

    const res = await cacheStatusGET(adminReq(true) as never)
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    const body = (await res.json()) as Record<string, unknown>
    expect(body.mdblistQuota).toEqual({
      parkedKeys: 1,
      nextResetAt: expect.any(String),
      scope: "process",
    })
    const raw = JSON.stringify(body)
    expect(raw).not.toContain("op-key-route")
    for (const { hash } of __getMdbQuotaStateForTests()) {
      expect(raw).not.toContain(hash)
    }
    // Zero additional external requests for the summary itself.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("reports empty state accurately (zero, null reset)", async () => {
    const res = await cacheStatusGET(adminReq(true) as never)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.mdblistQuota).toEqual({ parkedKeys: 0, nextResetAt: null, scope: "process" })
  })

  it("stays fail-closed: no token → 401 with no quota data", async () => {
    expect(noteMdbQuotaExhausted429(quotaHeaders("0", resetSecIn(3_600_000)), "op-key-private", T0)).toBe(true)
    delete process.env.ADMIN_TOKEN
    const res = await cacheStatusGET(
      new Request("http://localhost:3000/api/cache/status") as never,
    )
    expect(res.status).toBe(401)
    const text = await res.text()
    expect(text).not.toContain("mdblistQuota")
    expect(text).not.toContain("op-key-private")
  })

  it("public /api/status never exposes parked quota state (no regression)", async () => {
    expect(noteMdbQuotaExhausted429(quotaHeaders("0", resetSecIn(3_600_000)), "op-key-public", T0)).toBe(true)
    const res = await publicStatusGET(new Request("http://localhost:3000/api/status") as never)
    expect(res.status).toBe(200)
    const raw = JSON.stringify(await res.json())
    expect(raw).not.toContain("mdblistQuota")
    expect(raw).not.toContain("op-key-public")
    for (const { hash } of __getMdbQuotaStateForTests()) {
      expect(raw).not.toContain(hash)
    }
  })
})
