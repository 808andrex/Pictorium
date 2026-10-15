import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GET } from "@/app/api/cache/status/route"
import {
  getPosterStats,
  recordPosterStaleHit,
  recordPosterCoalescedHit,
  recordTvdbRescue,
  recordBackdropCropRescue,
  __resetPosterStatsForTest,
} from "@/lib/poster-runtime-cache"
import { isBreakerOpen, recordFailure as recordAwardsFailure, recordSuccess as recordAwardsSuccess } from "@/lib/awards"
import { isMdblistBreakerOpen, __resetMdblistBreaker } from "@/lib/ratings"
import { isJustwatchBreakerOpen } from "@/lib/justwatch"
import { isTvdbBreakerOpen, __resetTvdbBreaker } from "@/lib/tvdb"
import { cacheClear } from "@/lib/cache"

describe("Cache Status & Telemetry", () => {
  beforeEach(() => {
    __resetPosterStatsForTest()
    __resetMdblistBreaker()
    __resetTvdbBreaker()
    recordAwardsSuccess()
    delete process.env.ADMIN_TOKEN
  })

  afterEach(() => {
    cacheClear()
    __resetPosterStatsForTest()
    __resetMdblistBreaker()
    __resetTvdbBreaker()
    recordAwardsSuccess()
    delete process.env.ADMIN_TOKEN
  })

  const TEST_TOKEN = "secret"

  /** Richiesta autenticata (il token va anche in env: resolveAdminToken). */
  function statusReq() {
    process.env.ADMIN_TOKEN = TEST_TOKEN
    return new Request("http://localhost:3000/api/cache/status", {
      headers: { "x-admin-token": TEST_TOKEN },
    })
  }

  it("exposes and increments telemetry counters in getPosterStats()", () => {
    const initial = getPosterStats()
    expect(initial.staleHits).toBe(0)
    expect(initial.coalescedHits).toBe(0)
    expect(initial.rescues).toEqual({ tvdb: 0, backdropCrop: 0 })

    recordPosterStaleHit()
    recordPosterStaleHit()
    recordPosterCoalescedHit()
    recordTvdbRescue()
    recordBackdropCropRescue()
    recordBackdropCropRescue()

    const updated = getPosterStats()
    expect(updated.staleHits).toBe(2)
    expect(updated.coalescedHits).toBe(1)
    expect(updated.rescues).toEqual({ tvdb: 1, backdropCrop: 2 })

    __resetPosterStatsForTest()
    const reset = getPosterStats()
    expect(reset.staleHits).toBe(0)
    expect(reset.coalescedHits).toBe(0)
    expect(reset.rescues).toEqual({ tvdb: 0, backdropCrop: 0 })
  })

  it("returns circuit breaker booleans in GET /api/cache/status", async () => {
    const req = statusReq()
    const res = await GET(req as never)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.circuitBreakers).toEqual({
      awards: false,
      mdblist: false,
      justwatch: false,
      tvdb: false,
    })

    expect(isBreakerOpen()).toBe(false)
    expect(isMdblistBreakerOpen()).toBe(false)
    expect(isJustwatchBreakerOpen()).toBe(false)
    expect(isTvdbBreakerOpen()).toBe(false)
    expect(typeof body.circuitBreakers.awards).toBe("boolean")
    expect(typeof body.circuitBreakers.mdblist).toBe("boolean")
    expect(typeof body.circuitBreakers.justwatch).toBe("boolean")
    expect(typeof body.circuitBreakers.tvdb).toBe("boolean")
  })

  it("reflects tripped circuit breaker in status response", async () => {
    // 5 failures trip awards breaker
    for (let i = 0; i < 5; i++) {
      recordAwardsFailure()
    }
    expect(isBreakerOpen()).toBe(true)

    const req = statusReq()
    const res = await GET(req as never)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.circuitBreakers.awards).toBe(true)
    expect(body.circuitBreakers.mdblist).toBe(false)
    expect(body.circuitBreakers.justwatch).toBe(false)
    expect(body.circuitBreakers.tvdb).toBe(false)
  })

  it("includes new telemetry counters in poster stats of GET /api/cache/status", async () => {
    recordPosterStaleHit()
    recordTvdbRescue()

    const req = statusReq()
    const res = await GET(req as never)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.poster.staleHits).toBe(1)
    expect(body.poster.rescues.tvdb).toBe(1)
    expect(body.poster.rescues.backdropCrop).toBe(0)
  })
})
