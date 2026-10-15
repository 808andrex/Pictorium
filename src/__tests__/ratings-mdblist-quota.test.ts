// TASK4 — MDBList per-key DAILY quota tracking.
//
// The MDBList detail/list APIs enforce a per-API-key daily quota exposed via
// response headers (observed on the PostersPlus-compatible surface):
//   x-ratelimit-remaining — requests left in the current daily window
//   x-ratelimit-reset     — window reset as SECONDS since the Unix epoch
//
// Only a RELIABLY exhausted key is parked (remaining === 0 as a strictly
// finite non-negative integer, plus a trustworthy reset: finite seconds-epoch
// in the future but within the 48h sane horizon). A parked key skips ONLY its
// fresh keyed upstream calls until reset: cached ratings are still served,
// other keys are unaffected, and list fetches fall through to the SAME
// existing public JSON fallback (zero quota spend). A 429 WITHOUT this
// evidence keeps the existing transient behavior (global breaker with
// Retry-After, no negative caching — transient answers are never cached):
// burst throttling is distinct from daily exhaustion. An exhausted-quota 429 must NOT trip the shared global
// breaker and must NOT count as a genuine title miss.
//
// Key validation (app/api/validate-key/route.ts) is INTENTIONALLY live and
// exempt from parking (explicit user action, documented in lib/mdblist-quota).
//
// Env: no real network/credentials anywhere. `fetch` is stubbed per test;
// quota state, breaker, null-cache, raw inflight and L1 are reset per test.
// Fake timers pin the clock so reset instants are deterministic. Mock-server
// runs (MDBLIST_API_URL set) stay isolated from quota state.
import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cacheClear } from "@/lib/cache"
import {
  fetchAggregatedRating,
  isMdblistBreakerOpen,
  __resetMdblistBreaker,
  __resetRatingsNullForTest,
} from "@/lib/ratings"
import { fetchCustomMDBList, fetchMDBList } from "@/lib/mdblist"
import {
  MDB_QUOTA_MAX_KEYS,
  MDB_QUOTA_MAX_PARK_MS,
  __getMdbQuotaStateForTests,
  __resetMdbQuotaForTests,
  isMdbKeyParked,
  noteMdbQuotaExhausted429,
  noteMdbQuotaSuccess,
} from "@/lib/mdblist-quota"

type FetchMock = (...args: unknown[]) => Promise<unknown>

async function resetMdbRaw(): Promise<void> {
  const mod = (await import("@/lib/ratings")) as unknown as Record<string, unknown>
  const fn = mod.__resetMdbRawForTest
  if (typeof fn === "function") (fn as () => void)()
}

const T0 = new Date("2026-01-15T12:00:00Z").getTime()
const resetSecIn = (ms: number): string => String(Math.floor((T0 + ms) / 1000))

function quotaHeaders(remaining: string | null, reset: string | null): Headers {
  const init: Record<string, string> = {}
  if (remaining !== null) init["X-RateLimit-Remaining"] = remaining
  if (reset !== null) init["X-RateLimit-Reset"] = reset
  return new Headers(init)
}

function okRating(headers: Headers, imdb = 8.4): unknown {
  return { ok: true, status: 200, headers, json: async () => ({ ratings: [{ source: "imdb", value: imdb * 10, score: imdb * 10 }] }) }
}

function exhausted429(headers: Headers): unknown {
  return {
    ok: false,
    status: 429,
    headers,
    json: async () => ({}),
  }
}

const PUBLIC_LIST = [{ imdb_id: "tt0001", title: "Public One", year: 2020, tmdb_id: 11 }]

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  delete process.env.MDBLIST_API_URL
  cacheClear()
  __resetMdblistBreaker()
  __resetRatingsNullForTest()
  __resetMdbQuotaForTests()
  await resetMdbRaw()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  delete process.env.MDBLIST_API_URL
  cacheClear()
  __resetMdblistBreaker()
  __resetRatingsNullForTest()
  __resetMdbQuotaForTests()
  await resetMdbRaw()
  vi.restoreAllMocks()
})

describe("quota header validation (strict, fail-open)", () => {
  const goodReset = resetSecIn(3_600_000)

  it.each([
    ["float remaining", "0.0", goodReset],
    ["signed remaining", "-0", goodReset],
    ["word remaining", "exhausted", goodReset],
    ["empty remaining", "", goodReset],
    ["units remaining", "0/day", goodReset],
    ["healthy remaining", "7", goodReset],
    ["missing reset", "0", null],
    ["empty reset", "0", ""],
    ["word reset", "0", "soon"],
    ["float reset", "0", "8.5"],
    ["negative reset", "0", "-5"],
    ["past reset (1970-relative lookalike safe)", "0", "60"],
    ["far-future reset beyond 48h horizon", "0", resetSecIn(72 * 3_600_000)],
    ["millis-epoch reset (centuries out, not seconds)", "0", String(T0)],
    ["non-finite reset", "0", "9".repeat(400)],
    ["missing remaining", null, goodReset],
  ])("429 %s → NOT exhaustion (transient kept, no parking)", (_label, remaining, reset) => {
    const headers = quotaHeaders(remaining, reset)
    expect(noteMdbQuotaExhausted429(headers, "key-unit-429", T0)).toBe(false)
    expect(noteMdbQuotaSuccess(headers, "key-unit-ok", T0)).toBe(false)
    expect(isMdbKeyParked("key-unit-429", T0)).toBe(false)
    expect(isMdbKeyParked("key-unit-ok", T0)).toBe(false)
  })

  it("remaining 0 + future reset within horizon parks (both 429 and success paths)", () => {
    expect(noteMdbQuotaExhausted429(quotaHeaders("0", goodReset), "key-park-a", T0)).toBe(true)
    expect(isMdbKeyParked("key-park-a", T0)).toBe(true)
    expect(noteMdbQuotaSuccess(quotaHeaders("0", goodReset), "key-park-b", T0)).toBe(true)
    expect(isMdbKeyParked("key-park-b", T0)).toBe(true)
  })

  it("horizon boundary: just inside 48h parks, beyond does not", () => {
    const inside = String(Math.floor((T0 + MDB_QUOTA_MAX_PARK_MS - 60_000) / 1000))
    const outside = String(Math.floor((T0 + MDB_QUOTA_MAX_PARK_MS + 3_600_000) / 1000))
    expect(noteMdbQuotaExhausted429(quotaHeaders("0", inside), "key-edge-in", T0)).toBe(true)
    expect(noteMdbQuotaExhausted429(quotaHeaders("0", outside), "key-edge-out", T0)).toBe(false)
    expect(isMdbKeyParked("key-edge-out", T0)).toBe(false)
  })

  it("null/throwing headers and keyless callers never park (fail-open)", () => {
    expect(noteMdbQuotaExhausted429(null, "k", T0)).toBe(false)
    expect(noteMdbQuotaSuccess(undefined, "k", T0)).toBe(false)
    const throwing = { get: () => { throw new Error("boom") } }
    expect(noteMdbQuotaExhausted429(throwing, "k", T0)).toBe(false)
    expect(noteMdbQuotaSuccess(throwing, "k", T0)).toBe(false)
    expect(noteMdbQuotaExhausted429(quotaHeaders("0", goodReset), "", T0)).toBe(false)
    expect(noteMdbQuotaExhausted429(quotaHeaders("0", goodReset), null, T0)).toBe(false)
    expect(isMdbKeyParked("", T0)).toBe(false)
    expect(isMdbKeyParked(null, T0)).toBe(false)
  })

  it("parked map holds only sha256 hashes, never plaintext secrets, and expires at reset", () => {
    const key = "super-secret-key-xyz"
    expect(noteMdbQuotaExhausted429(quotaHeaders("0", goodReset), key, T0)).toBe(true)
    const state = __getMdbQuotaStateForTests()
    expect(state).toHaveLength(1)
    expect(state[0].hash).toBe(createHash("sha256").update(key).digest("hex"))
    expect(state[0].hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(state)).not.toContain(key)
    expect(isMdbKeyParked(key, T0)).toBe(true)
    vi.setSystemTime(T0 + 3_600_000 + 1000)
    expect(isMdbKeyParked(key)).toBe(false)
    expect(__getMdbQuotaStateForTests()).toHaveLength(0)
  })

  it("bounded map evicts oldest beyond 500, isolates keys, never stores plaintext, prunes expired", () => {
    const reset = resetSecIn(3_600_000)
    const total = MDB_QUOTA_MAX_KEYS + 5
    for (let i = 0; i < total; i++) {
      expect(noteMdbQuotaExhausted429(quotaHeaders("0", reset), `key-evict-${i}`, T0)).toBe(true)
    }
    const state = __getMdbQuotaStateForTests()
    expect(state).toHaveLength(MDB_QUOTA_MAX_KEYS)
    // Oldest entries evicted (fail-open for them), newest retained; an
    // unrelated key is isolated (never parked by others' exhaustion).
    expect(isMdbKeyParked("key-evict-0", T0)).toBe(false)
    expect(isMdbKeyParked(`key-evict-${total - 1}`, T0)).toBe(true)
    expect(isMdbKeyParked("key-never-parked", T0)).toBe(false)
    // No plaintext secrets anywhere in observable state: hashes only.
    expect(JSON.stringify(state)).not.toContain("key-evict-")
    for (const entry of state) expect(entry.hash).toMatch(/^[0-9a-f]{64}$/)
    // Expiry cleanup: past the reset the stale map drains — the read path
    // drops the checked key, the next park prunes the rest via pruneExpired.
    vi.setSystemTime(T0 + 3_600_000 + 1000)
    expect(isMdbKeyParked(`key-evict-${total - 1}`)).toBe(false)
    const freshReset = String(Math.floor((Date.now() + 3_600_000) / 1000))
    expect(noteMdbQuotaExhausted429(quotaHeaders("0", freshReset), "key-post-expiry", Date.now())).toBe(true)
    const after = __getMdbQuotaStateForTests()
    expect(after).toHaveLength(1)
    expect(after[0].hash).toBe(createHash("sha256").update("key-post-expiry").digest("hex"))
    expect(isMdbKeyParked("key-evict-1")).toBe(false)
  })
})

describe("ratings: exhausted key parks future keyed network, breaker untouched", () => {
  it("429 remaining-0 (even with Retry-After) parks: 1 fetch for 3 IDs, breaker stays closed", async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      exhausted429(
        new Headers({
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": resetSecIn(3_600_000),
          "Retry-After": "45",
        }),
      ),
    )
    vi.stubGlobal("fetch", fetchMock)

    for (const id of ["ttQ1a", "ttQ1b", "ttQ1c"]) {
      expect(await fetchAggregatedRating(id, "keyQ1")).toBeNull()
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(isMdbKeyParked("keyQ1")).toBe(true)
    expect(isMdblistBreakerOpen()).toBe(false)
  })

  it("429 without quota evidence stays transient: 3 fails trip the breaker, key never parked", async () => {
    const fetchMock = vi.fn<FetchMock>(async () => ({
      ok: false,
      status: 429,
      headers: new Headers(),
      json: async () => ({}),
    }))
    vi.stubGlobal("fetch", fetchMock)

    for (const id of ["ttQ2a", "ttQ2b", "ttQ2c"]) {
      expect(await fetchAggregatedRating(id, "keyQ2")).toBeNull()
    }
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(isMdblistBreakerOpen()).toBe(true)
    // Breaker open: fourth ID short-circuits without network.
    expect(await fetchAggregatedRating("ttQ2d", "keyQ2")).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(isMdbKeyParked("keyQ2")).toBe(false)
  })

  it("success with remaining 0 delivers its data, then parks future keyed calls", async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      okRating(quotaHeaders("0", resetSecIn(3_600_000))),
    )
    vi.stubGlobal("fetch", fetchMock)

    const first = await fetchAggregatedRating("ttQS1", "keyQS")
    expect(first?.sources.imdb).toBe(8.4)
    expect(isMdbKeyParked("keyQS")).toBe(true)
    expect(await fetchAggregatedRating("ttQS2", "keyQS")).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(isMdblistBreakerOpen()).toBe(false)
  })

  it("success with remaining 0 but untrustworthy reset delivers data and does NOT park", async () => {
    const fetchMock = vi.fn<FetchMock>(async () => okRating(quotaHeaders("0", "soon")))
    vi.stubGlobal("fetch", fetchMock)

    expect((await fetchAggregatedRating("ttQM1", "keyQM"))?.sources.imdb).toBe(8.4)
    expect(isMdbKeyParked("keyQM")).toBe(false)
    // No parking: a fresh ID fetches again.
    expect((await fetchAggregatedRating("ttQM2", "keyQM"))?.sources.imdb).toBe(8.4)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("cached hits still served while parked; a different key keeps working", async () => {
    const fetchMock = vi.fn<FetchMock>(async (input: unknown) => {
      const url = String(input)
      if (url.includes("apikey=keyC")) {
        if (url.includes("ttQC2")) return exhausted429(quotaHeaders("0", resetSecIn(3_600_000)))
        return okRating(quotaHeaders("5", resetSecIn(3_600_000)))
      }
      return okRating(quotaHeaders("9", resetSecIn(3_600_000)))
    })
    vi.stubGlobal("fetch", fetchMock)

    expect((await fetchAggregatedRating("ttQC1", "keyC"))?.sources.imdb).toBe(8.4)
    expect(await fetchAggregatedRating("ttQC2", "keyC")).toBeNull()
    expect(isMdbKeyParked("keyC")).toBe(true)
    // Cached hit for ttQC1 is still served with zero new network.
    expect((await fetchAggregatedRating("ttQC1", "keyC"))?.sources.imdb).toBe(8.4)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // A different key is unaffected.
    expect((await fetchAggregatedRating("ttQC3", "keyD"))?.sources.imdb).toBe(8.4)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(isMdbKeyParked("keyD")).toBe(false)
  })

  it("recovery after reset refetches: quota 429 is not a genuine miss (no long negative cache)", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>(async () => {
        calls += 1
        if (calls === 1) return exhausted429(quotaHeaders("0", resetSecIn(30_000)))
        return okRating(quotaHeaders("9", resetSecIn(3_600_000)))
      }),
    )

    expect(await fetchAggregatedRating("ttQR1", "keyQR")).toBeNull()
    expect(isMdbKeyParked("keyQR")).toBe(true)
    // Still inside the 60s null-cache window AND past the 30s quota reset:
    // a genuine miss would answer from the negative cache without network.
    vi.setSystemTime(T0 + 45_000)
    expect(isMdbKeyParked("keyQR")).toBe(false)
    expect((await fetchAggregatedRating("ttQR1", "keyQR"))?.sources.imdb).toBe(8.4)
    expect(calls).toBe(2)
  })
})

describe("lists + shared state: parked key uses the public fallback, mock runs isolated", () => {
  function routeStub(keyed: (url: string) => unknown) {
    return vi.fn<FetchMock>(async (input: unknown) => {
      const url = String(input)
      if (url.includes("api.mdblist.com")) return keyed(url)
      if (url.includes("mdblist.com")) {
        return { ok: true, status: 200, headers: new Headers(), json: async () => PUBLIC_LIST }
      }
      throw new Error(`unexpected upstream ${url}`)
    })
  }

  it("exhausted keyed list 429 → existing public fallback, key parked, later lists skip keyed", async () => {
    const fetchMock = routeStub(() => exhausted429(quotaHeaders("0", resetSecIn(7_200_000))))
    vi.stubGlobal("fetch", fetchMock)

    const items = await fetchMDBList("mdblistMovie", "keyL")
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ imdb: "tt0001", tmdb: 11 })
    expect(isMdbKeyParked("keyL")).toBe(true)
    const isKeyed = (u: unknown): boolean => String(u).includes("api.mdblist.com")
    const isPublic = (u: unknown): boolean => !isKeyed(u) && String(u).includes("mdblist.com/lists/")
    const keyedAfterFirst = fetchMock.mock.calls.filter(([u]) => isKeyed(u))
    const publicAfterFirst = fetchMock.mock.calls.filter(([u]) => isPublic(u))
    expect(keyedAfterFirst).toHaveLength(1)
    expect(publicAfterFirst).toHaveLength(1)

    // A different custom list with the same parked key spends nothing keyed.
    const custom = await fetchCustomMDBList("snoak/other-slug-ql", "keyL")
    expect(custom).toHaveLength(1)
    expect(custom[0]).toMatchObject({ imdb: "tt0001" })
    expect(fetchMock.mock.calls.filter(([u]) => isKeyed(u))).toHaveLength(1)
    expect(fetchMock.mock.calls.filter(([u]) => isPublic(u))).toHaveLength(2)
  })

  it("keyed list success with remaining 0 returns its data and parks future keyed lists", async () => {
    const keyedPayload = { data: { items: [{ imdb_id: "tt0002", title: "Keyed Two", year: 2021, tmdb_id: 22 }] } }
    const fetchMock = routeStub(() => ({
      ok: true,
      status: 200,
      headers: quotaHeaders("0", resetSecIn(7_200_000)),
      json: async () => keyedPayload,
    }))
    vi.stubGlobal("fetch", fetchMock)

    const items = await fetchCustomMDBList("snoak/slug-qs", "keyLS")
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ imdb: "tt0002", tmdb: 22 })
    expect(isMdbKeyParked("keyLS")).toBe(true)

    const other = await fetchCustomMDBList("snoak/slug-qs-other", "keyLS")
    expect(other).toHaveLength(1)
    expect(other[0]).toMatchObject({ imdb: "tt0001" })
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("api.mdblist.com"))).toHaveLength(1)
  })

  it("quota state is shared: a rating-parked key skips the list keyed fetch too", async () => {
    const fetchMock = vi.fn<FetchMock>(async (input: unknown) => {
      const url = String(input)
      if (url.includes("api.mdblist.com")) return exhausted429(quotaHeaders("0", resetSecIn(3_600_000)))
      if (url.includes("mdblist.com/lists/")) {
        return { ok: true, status: 200, headers: new Headers(), json: async () => PUBLIC_LIST }
      }
      throw new Error(`unexpected upstream ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    expect(await fetchAggregatedRating("ttQSh1", "keySH")).toBeNull()
    expect(isMdbKeyParked("keySH")).toBe(true)

    const items = await fetchMDBList("mdblistMovie", "keySH")
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ imdb: "tt0001" })
    // The ratings 429 above parks the key; the list path then spends nothing
    // keyed (only the public fallback). Count keyed LIST calls specifically:
    // the new ratings URL also lives under api.mdblist.com (/imdb/…).
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("api.mdblist.com/lists/"))).toHaveLength(0)
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("mdblist.com/lists/"))).toHaveLength(1)
  })

  it("MDBLIST_API_URL mock runs stay isolated: exhausted headers never park", async () => {
    process.env.MDBLIST_API_URL = "http://mock.test"
    const fetchMock = vi.fn<FetchMock>(async (input: unknown) => {
      const url = String(input)
      if (url.includes("http://mock.test/lists/")) {
        return {
          ok: true,
          status: 200,
          headers: quotaHeaders("0", resetSecIn(3_600_000)),
          json: async () => PUBLIC_LIST,
        }
      }
      return exhausted429(quotaHeaders("0", resetSecIn(3_600_000)))
    })
    vi.stubGlobal("fetch", fetchMock)

    expect(await fetchAggregatedRating("ttQI1", "keyQI")).toBeNull()
    expect(isMdbKeyParked("keyQI")).toBe(false)
    const items = await fetchMDBList("mdblistMovie", "keyQI")
    expect(items).toHaveLength(1)
    expect(isMdbKeyParked("keyQI")).toBe(false)
  })
})
