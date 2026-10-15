import crypto from "node:crypto"
import { createLogger } from "@/lib/logger"

const log = createLogger("mdblist-quota")

// ---------------------------------------------------------------------------
// MDBList per-key DAILY quota exhaustion protection.
//
// The MDBList detail/list APIs enforce a per-API-key DAILY quota and expose it
// via response headers (observed on the PostersPlus-compatible surface):
//
//   x-ratelimit-remaining — requests left in the current daily window
//   x-ratelimit-reset     — window reset as SECONDS since the Unix epoch
//
// (Header lookup is case-insensitive through Headers.get.)
//
// A parked key skips ONLY its keyed upstream calls until the reset instant:
// cached ratings (L1/KV/disk raw hits, aggregated hits) are still served, and
// list fetches fall through to the SAME existing public JSON fallback (which
// spends no quota). Parking is per hashed key, shared across the rating path
// (lib/ratings.ts) and the list paths (lib/mdblist.ts). There is no key
// rotation, no extra account polling (`/user` is never called), no new storage
// backend, and no change to public endpoints/auth policy.
//
// What counts as exhaustion (ALL required, otherwise fail-open):
//   1. remaining parses as a strictly finite non-negative integer AND === 0;
//   2. reset parses as a strictly finite non-negative integer (SECONDS epoch,
//      never a relative TTL — a small relative-looking value lands in 1970 and
//      fails the future check below) whose instant is in the FUTURE but within
//      a sane horizon (MAX_QUOTA_PARK_MS). A missing, malformed, past, or
//      far-future reset is untrustworthy: no parking.
// A 429 WITHOUT this evidence keeps the existing transient behavior (global
// breaker with Retry-After, no negative caching — transient answers are
// never cached) — absence of quota headers never implies daily exhaustion. Short burst throttling (429 with
// remaining > 0, or with Retry-After and healthy quota headers) is NOT daily
// exhaustion and must NOT park the key. A 2xx with remaining === 0 parks FUTURE
// calls but the successful response itself is still returned.
//
// A parked (429, exhausted) response MUST NOT trip the shared global breaker
// (which would punish healthy other-key traffic) and MUST NOT count as a
// genuine title miss (which would long-negative-cache a title that exists).
// Callers return transient (no breaker record, no genuine-miss flag) instead.
//
// Key validation (app/api/validate-key/route.ts) is INTENTIONALLY live and
// exempt from parking: it is an explicit user action proving a key, not a
// background spend path, so it always probes upstream.
//
// Fail-open everywhere: malformed headers, clock skew, far-future resets, and
// map pressure all resolve to "not parked". No plaintext key is ever stored
// in the map, persisted, or logged — only its sha256 hex digest.
// ---------------------------------------------------------------------------

/** Response headers carrying the daily quota state. */
export const MDB_QUOTA_REMAINING_HEADER = "x-ratelimit-remaining"
export const MDB_QUOTA_RESET_HEADER = "x-ratelimit-reset"

/**
 * Sane upper bound for a trustworthy daily-quota reset: a DAILY window cannot
 * legitimately reset more than 48h out. Resets beyond this horizon are treated
 * as malformed (fail-open, no parking) rather than parking a key for days on
 * upstream-controlled input.
 */
export const MDB_QUOTA_MAX_PARK_MS = 48 * 60 * 60 * 1000

/** Bound on tracked keys: the map holds at most this many parked entries. */
export const MDB_QUOTA_MAX_KEYS = 500

/** Minimal header reader: real Headers and `{ get() }` test stubs both fit. */
export interface QuotaHeaders {
  get(name: string): string | null
}

const parkedUntilByHash = new Map<string, number>()

/** Only for tests: observe parked hashes (never plaintext keys). */
export function __getMdbQuotaStateForTests(): Array<{ hash: string; until: number }> {
  return [...parkedUntilByHash.entries()].map(([hash, until]) => ({ hash, until }))
}

/** Only for tests: drop all parked-key state. */
export function __resetMdbQuotaForTests(): void {
  parkedUntilByHash.clear()
}

/**
 * Operator-visible shape for the parked-key quota state. Counts and reset
 * timing only: never a key, hash, user, or link mapping. `scope` labels the
 * state accurately as per-process in-memory (not global Redis quota stats,
 * not a total remaining count — neither is known here).
 */
export interface MdbQuotaSummary {
  parkedKeys: number
  nextResetAt: string | null
  scope: "process"
}

/**
 * Sanitized read-only summary for the established protected operator
 * diagnostics surface (GET /api/cache/status, fail-closed admin auth).
 * Prunes expired entries first so the report never counts stale parks, then
 * reports the live count plus the earliest reset instant (ISO) or null when
 * empty. Zero upstream calls, zero storage access, zero secret material.
 */
export function getMdbQuotaSummary(nowMs: number = Date.now()): MdbQuotaSummary {
  pruneExpired(nowMs)
  let next: number | null = null
  for (const until of parkedUntilByHash.values()) {
    if (next === null || until < next) next = until
  }
  return {
    parkedKeys: parkedUntilByHash.size,
    nextResetAt: next === null ? null : new Date(next).toISOString(),
    scope: "process",
  }
}

/**
 * Digest identifying one API key in the parked map. sha256 hex, never the key
 * itself: map keys, logs, and any future persistence carry only this.
 */
export function hashMdbKeyForQuota(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex")
}

function pruneExpired(nowMs: number): void {
  for (const [hash, until] of parkedUntilByHash) {
    if (until <= nowMs) parkedUntilByHash.delete(hash)
  }
}

/**
 * Strict non-negative integer parse: digits only, finite, >= 0. Anything else
 * (null, empty, floats, signs, units, NaN) is untrustworthy → null (fail-open).
 */
function parseStrictNonNegativeInt(raw: string | null): number | null {
  if (raw === null) return null
  const s = raw.trim()
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return n
}

/**
 * Trustworthy reset instant (ms epoch) or null. The header value is SECONDS
 * since the Unix epoch — never a relative TTL and never milliseconds: small
 * relative-looking values resolve to 1970 (past → untrusted) and millisecond
 * values resolve centuries out (beyond the horizon → untrusted).
 */
function trustworthyResetMs(resetRaw: string | null, nowMs: number): number | null {
  const sec = parseStrictNonNegativeInt(resetRaw)
  if (sec === null) return null
  const ms = sec * 1000
  if (!Number.isFinite(ms)) return null
  if (ms <= nowMs) return null
  if (ms - nowMs > MDB_QUOTA_MAX_PARK_MS) return null
  return ms
}

function tryPark(
  key: string | undefined | null,
  remainingRaw: string | null,
  resetRaw: string | null,
  nowMs: number,
): boolean {
  if (!key) return false
  if (parseStrictNonNegativeInt(remainingRaw) !== 0) return false
  const resetMs = trustworthyResetMs(resetRaw, nowMs)
  if (resetMs === null) return false
  pruneExpired(nowMs)
  const hash = hashMdbKeyForQuota(key)
  parkedUntilByHash.delete(hash)
  parkedUntilByHash.set(hash, resetMs)
  while (parkedUntilByHash.size > MDB_QUOTA_MAX_KEYS) {
    const oldest = parkedUntilByHash.keys().next().value
    if (oldest === undefined) break
    parkedUntilByHash.delete(oldest)
  }
  log.info("MDBList daily quota exhausted: key parked until reset", {
    keyHash: hash.slice(0, 8),
    reset: new Date(resetMs).toISOString(),
  })
  return true
}

/**
 * True when this key's daily quota is exhausted and its reset is still in the
 * future. Expired entries are dropped (fail-open recovery). Keyless (public)
 * callers are never parked.
 */
export function isMdbKeyParked(key: string | undefined | null, nowMs: number = Date.now()): boolean {
  if (!key) return false
  const until = parkedUntilByHash.get(hashMdbKeyForQuota(key))
  if (until === undefined) return false
  if (until <= nowMs) {
    parkedUntilByHash.delete(hashMdbKeyForQuota(key))
    return false
  }
  return true
}

/**
 * Inspect a SUCCESSFUL keyed response: remaining === 0 with a trustworthy
 * future reset parks FUTURE calls. The current success is always returned by
 * the caller — this only records state. Returns true when the key was parked.
 */
export function noteMdbQuotaSuccess(
  headers: QuotaHeaders | null | undefined,
  key: string | undefined | null,
  nowMs: number = Date.now(),
): boolean {
  if (!headers || !key) return false
  let remainingRaw: string | null = null
  let resetRaw: string | null = null
  try {
    remainingRaw = headers.get(MDB_QUOTA_REMAINING_HEADER)
    resetRaw = headers.get(MDB_QUOTA_RESET_HEADER)
  } catch {
    return false
  }
  return tryPark(key, remainingRaw, resetRaw, nowMs)
}

/**
 * Inspect a 429 keyed response. Returns true ONLY with reliable exhaustion
 * evidence (remaining === 0 + trustworthy future reset, key parked): the
 * caller must then skip the global breaker and the genuine-miss flag
 * (transient, no negative cache). Any other 429 (burst throttling, missing or
 * malformed quota headers) returns false → existing transient handling.
 */
export function noteMdbQuotaExhausted429(
  headers: QuotaHeaders | null | undefined,
  key: string | undefined | null,
  nowMs: number = Date.now(),
): boolean {
  if (!headers || !key) return false
  let remainingRaw: string | null = null
  let resetRaw: string | null = null
  try {
    remainingRaw = headers.get(MDB_QUOTA_REMAINING_HEADER)
    resetRaw = headers.get(MDB_QUOTA_RESET_HEADER)
  } catch {
    return false
  }
  return tryPark(key, remainingRaw, resetRaw, nowMs)
}
