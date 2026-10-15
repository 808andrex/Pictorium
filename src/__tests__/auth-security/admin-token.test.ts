import { beforeEach, describe, expect, it } from "vitest"
import {
  __resetAdminTokenForTests,
  adminAuthHeaders,
  applyAdminAuthHeaders,
  clearAdminToken,
  getAdminToken,
  hasAdminToken,
  setAdminToken,
} from "@/lib/admin-token"

describe("admin-token (session-only)", () => {
  beforeEach(() => {
    __resetAdminTokenForTests()
    window.sessionStorage.clear()
  })

  it("is empty by default", () => {
    expect(hasAdminToken()).toBe(false)
    expect(getAdminToken()).toBeNull()
    expect(adminAuthHeaders()).toEqual({})
  })

  it("stores and clears the token (trimmed)", () => {
    setAdminToken("  secret  ")
    expect(getAdminToken()).toBe("secret")
    expect(hasAdminToken()).toBe(true)
    expect(adminAuthHeaders()).toEqual({ "x-admin-token": "secret" })
    clearAdminToken()
    expect(hasAdminToken()).toBe(false)
  })

  it("attaches x-admin-token to /api/ calls only", () => {
    setAdminToken("secret")
    expect(applyAdminAuthHeaders("/api/warmup", undefined)).toEqual({ "x-admin-token": "secret" })
    expect(applyAdminAuthHeaders("/api/defaults", { "Content-Type": "application/json" })).toEqual({
      "Content-Type": "application/json",
      "x-admin-token": "secret",
    })
    // Mai verso URL terze.
    expect(applyAdminAuthHeaders("https://example.com/api/x", undefined)).toBeUndefined()
  })

  it("never overwrites an explicit admin auth header", () => {
    setAdminToken("session-secret")
    expect(applyAdminAuthHeaders("/api/warmup", { "x-admin-token": "explicit" })).toEqual({
      "x-admin-token": "explicit",
    })
    expect(applyAdminAuthHeaders("/api/warmup", { Authorization: "Bearer explicit" })).toEqual({
      Authorization: "Bearer explicit",
    })
  })

  it("is passthrough without a session token", () => {
    const headers = { "Content-Type": "application/json" }
    expect(applyAdminAuthHeaders("/api/warmup", headers)).toEqual(headers)
  })
})
