/**
 * Per-profile coordination primitives for Trakt token writes — task 3/plan.
 *
 * SERVER-ONLY: imports `node:crypto`/`node:fs` (same rule as
 * `trakt-auth.ts` — no `server-only` package import, boundary enforced by the
 * import graph). NEVER import from client components or shared client/server
 * leaves. Importers: `trakt-auth.ts` (guarded save, refresh, disconnect),
 * `user-activity.ts` (`deleteUser` wipe) and the Trakt routes. It imports
 * NOTHING from `trakt-auth`/`user-activity` (no cycles, fixed lock order:
 * refresh mutex first, then the mutation lock, then the record).
 *
 * Two file-backend mutexes (single-host mode), one KV key (shared mode):
 * - Mutation lock (`acquireTraktProfileLock`): serializes every short
 *   storage critical section — guarded commit (gen check + token write +
 *   gen bump), explicit disconnect (fence + delete), conditional
 *   invalid_grant clear, wipe deletes. Held ONLY across storage IO, NEVER
 *   across the network, so an explicit disconnect can always proceed while
 *   a refresh is mid-exchange.
 * - Refresh mutex (`acquireTraktRefreshLock`): held across the token
 *   exchange by the refresh flow so concurrent refreshers of one profile
 *   share a single upstream call (single-flight). The guarded commit still
 *   re-validates the fencing generation, so the mutex is a dedup
 *   optimization, never the safety mechanism. In KV mode both functions
 *   use the same server-side key (EVAL-atomic acquire/release); the commit
 *   path additionally proves mutex ownership inside the token CAS script,
 *   so a holder whose lease expired mid-exchange aborts even when the
 *   generation is unchanged.
 * - Fencing generations (`getTraktGeneration`/`bumpTraktGeneration`): every
 *   disconnect/wipe and every successful coordinated write installs a fresh
 *   unique token, and every coordinated write re-checks it at the storage
 *   boundary (KV: one atomic EVAL comparing generation + user existence +
 *   lock ownership; file: compare under the held mutation lock). A mismatch
 *   aborts the write — a stale refresh, a post-disconnect callback save, or
 *   a post-wipe save can never resurrect or overwrite.
 *
 * FILE LOCK SAFETY (no-steal, fail-closed — no atomic filesystem CAS exists
 * in the repo helpers, and none is claimed): the file mutexes are O_EXCL
 * (`wx`) lock files OUTSIDE the user namespace
 * (`<DATA_DIR>/trakt-locks/<uuid>.lock` / `<uuid>.refresh.lock`, so a
 * namespace wipe can never destroy a held lock). A lock file is NEVER
 * automatically removed while it exists: no TTL-expiry steal, no dead-owner
 * reaping, no pid probing. Pid checks cannot make a pathname unlink
 * conditional — two contenders that both read the same stale payload can
 * interleave so that the second unlinks a live replacement created between
 * its read and its unlink — so this module never unlinks a file it did not
 * just create-and-own. Contenders wait boundedly and then fail closed with
 * `TraktLockUnavailableError`. Consequence: a crashed holder's lock file
 * survives the crash. MANUAL RECOVERY, SERVICE STOPPED ONLY: after
 * verifying no live Pictorium process holds it, delete
 * `<DATA_DIR>/trakt-locks/<uuid>.lock` (and/or `<uuid>.refresh.lock`) by
 * hand. Deleting a lock file while its owner may be live lets two writers
 * coexist — the exact race fencing exists to prevent — so lock files are
 * never removed under a running service, by hand or by code: no code path
 * (including the account wipe) unlinks lock files. Orphaned lock files hold
 * no tokens (owner + expiry metadata only).
 *
 * REMAINING LIMITS (explicit, not fixed here): same-host filesystem read
 * coherence is assumed for fence visibility (gen bumps use atomic
 * tmp+rename replaces, so readers see whole old/new values); cross-host
 * shared filesystems are NOT supported in file mode (use KV).
 *
 * Generation storage: `users/<uuid>/trakt.gen` (file, atomic replace) or
 * `user:<uuid>:trakt:gen` (KV). Values are unique fencing tokens
 * (`<ms>-<random>`), compared by exact equality only — no RMW races, no
 * lost increments. The wipe deletes the generation alongside the namespace
 * (GDPR-clean, no tombstone retention): a post-wipe save is still stopped
 * by the existence check + the no-mkdir write rule in `trakt-auth.ts`
 * (same-UUID recreation after a wipe is impossible in practice —
 * `createUser` mints a fresh randomUUID — so no tombstone is needed).
 */
import crypto from "node:crypto"
import fsp from "node:fs/promises"
import path from "node:path"
import { atomicWriteFile } from "@/lib/atomic-write"
import { DATA_DIR } from "@/lib/data-dir"
import { createLogger } from "@/lib/logger"
import { getKv, getStorageMode } from "@/lib/kv"

const log = createLogger("trakt-profile-lock")

// Lettura live (mai a module level): i test mutano le env + resetModules.
function isKvMode(): boolean {
  return getStorageMode() === "kv"
}

function assertValidUserId(userId: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("Invalid user id")
}

/** Lock acquisition/release failed (contention timeout, EVAL outage, IO). Fail-closed: the caller must NOT write. */
export class TraktLockUnavailableError extends Error {
  constructor() {
    super("Trakt profile lock is unavailable")
    this.name = "TraktLockUnavailableError"
  }
}

/**
 * Fencing-generation read failed (storage IO / KV outage). Fail-closed: the
 * caller must abort the coordinated write — a swallowed `null` would be
 * indistinguishable from "never fenced" and could pass a CAS check against
 * a legacy/absent generation. `null` is returned ONLY when no generation
 * was ever stored (legacy record, never linked, or wiped).
 */
export class TraktGenerationUnavailableError extends Error {
  constructor() {
    super("Trakt fencing generation is unavailable")
    this.name = "TraktGenerationUnavailableError"
  }
}

/** Lock held across re-check + write only (never across the network): short bounds. */
export const TRAKT_LOCK_TTL_MS = 10_000
/** Bounded wait for a contended lock (refresh single-flight queue). */
export const TRAKT_LOCK_WAIT_MS = 10_000
const TRAKT_LOCK_POLL_MS = 20

export interface TraktProfileLock {
  readonly userId: string
  readonly owner: string
  release(): Promise<void>
}

function newOwner(): string {
  return `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`
}

function newGeneration(): string {
  return `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`
}

// ── Generation sidecar ──────────────────────────────────────────────

function genFile(userId: string): string {
  // Inside the namespace on purpose: the wipe removes it (no tombstone
  // retention); post-wipe saves are stopped by the existence check +
  // the no-mkdir write rule instead.
  return path.join(DATA_DIR, "users", userId, "trakt.gen")
}

function genKvKey(userId: string): string {
  return `user:${userId}:trakt:gen`
}

/**
 * Current fencing generation for the profile, or null when never bumped
 * (legacy record, never linked, or wiped). Exact-equality compare only.
 * Storage trouble THROWS `TraktGenerationUnavailableError` (fail-closed) —
 * it never resolves to null, so callers cannot mistake an outage for an
 * unfenced profile and pass a CAS check they must not pass.
 */
export async function getTraktGeneration(userId: string): Promise<string | null> {
  assertValidUserId(userId)
  if (isKvMode()) {
    let raw: unknown
    try {
      raw = await getKv().get<string>(genKvKey(userId))
    } catch (e) {
      log.warn("trakt generation KV read failed", { error: e instanceof Error ? e.message : String(e) })
      throw new TraktGenerationUnavailableError()
    }
    return typeof raw === "string" && raw ? raw : null
  }
  let raw: string
  try {
    raw = (await fsp.readFile(genFile(userId), "utf-8")).trim()
  } catch (e) {
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") return null
    log.warn("trakt generation read failed", { error: e instanceof Error ? e.message : String(e) })
    throw new TraktGenerationUnavailableError()
  }
  return raw ? raw : null
}

/**
 * Bump the fencing generation (disconnect/wipe/successful write). Returns
 * the new token. The file write is an atomic tmp+rename replace (readers
 * see whole old/new values, never torn content). Deliberately creates
 * NOTHING: when the namespace is gone the write fails with ENOENT (callers
 * treat it as concurrent wipe) instead of recreating the directory. Wipe
 * callers use best-effort try/catch around it; disconnect callers fail
 * closed on non-ENOENT IO (no best-effort fence success claim).
 */
export async function bumpTraktGeneration(userId: string): Promise<string> {
  assertValidUserId(userId)
  const gen = newGeneration()
  if (isKvMode()) {
    await getKv().set(genKvKey(userId), gen)
    return gen
  }
  await atomicWriteFile(genFile(userId), gen, { mode: 0o600 })
  return gen
}

/** Best-effort generation removal (wipe path only): never throws. */
export async function clearTraktGeneration(userId: string): Promise<void> {
  assertValidUserId(userId)
  try {
    if (isKvMode()) {
      await getKv().del(genKvKey(userId))
      return
    }
    await fsp.unlink(genFile(userId)).catch(() => {})
  } catch {
    /* wipe path: already warn-logged by the caller */
  }
}

// ── Distributed lock ────────────────────────────────────────────────

// Marker comments let the unit-test KV mock emulate each script's atomic
// semantics (real Redis/Upstash just ignore Lua comments).
const LOCK_ACQUIRE_SCRIPT = `-- trakt-lock-acquire
local v = redis.call("GET", KEYS[1])
if v then return 0 end
redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
return 1`

const LOCK_RELEASE_SCRIPT = `-- trakt-lock-release
local v = redis.call("GET", KEYS[1])
if v == ARGV[1] then redis.call("DEL", KEYS[1]) return 1 end
return 0`

function lockKvKey(userId: string): string {
  return `user:${userId}:trakt:lock`
}

function lockFile(userId: string): string {
  return path.join(DATA_DIR, "trakt-locks", `${userId.toLowerCase()}.lock`)
}

function refreshLockFile(userId: string): string {
  return path.join(DATA_DIR, "trakt-locks", `${userId.toLowerCase()}.refresh.lock`)
}

interface LockPayload {
  owner: string
  expiresAt: number
}

async function acquireKvLock(key: string, owner: string, ttlMs: number, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs
  for (;;) {
    // Atomic-only: a non-atomic get+set fallback would let two workers both
    // believe they hold the lock. EVAL failure throws → fail-closed.
    const won = await getKv().eval<number>(LOCK_ACQUIRE_SCRIPT, [key], [owner, String(ttlMs)])
    if (Number(won) === 1) return
    if (Date.now() >= deadline) throw new TraktLockUnavailableError()
    await new Promise((r) => setTimeout(r, TRAKT_LOCK_POLL_MS))
  }
}

async function releaseKvLock(key: string, owner: string): Promise<void> {
  try {
    // Atomic owner-checked release ONLY: never get+del (a stale holder must
    // not delete the current holder's lock). Failure → TTL reaps it.
    await getKv().eval<number>(LOCK_RELEASE_SCRIPT, [key], [owner])
  } catch (e) {
    log.warn("trakt profile lock release failed (TTL will reap it)", {
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

function parseLockPayload(raw: unknown): LockPayload | null {
  // Owner-checked release ONLY (never consulted for reaping: this module
  // never unlinks a file it did not just create-and-own — see module doc).
  if (typeof raw !== "string") return null
  try {
    const p = JSON.parse(raw) as Partial<LockPayload>
    if (typeof p.owner === "string" && p.owner && typeof p.expiresAt === "number" && Number.isFinite(p.expiresAt)) {
      return { owner: p.owner, expiresAt: p.expiresAt }
    }
  } catch {
    /* corrupt lock file: treated as stale below via mtime */
  }
  return null
}

async function acquireFileLock(file: string, owner: string, ttlMs: number, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const payload = JSON.stringify({ owner, expiresAt: Date.now() + ttlMs })
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, payload, { flag: "wx", mode: 0o600 })
      return
    } catch (e) {
      const code = e instanceof Error && "code" in e ? (e as NodeJS.ErrnoException).code : null
      if (code !== "EEXIST") throw new TraktLockUnavailableError()
    }
    // Held by someone. Exclusive, no-steal: the file is NEVER unlinked here
    // (no TTL-expiry steal, no dead-owner reaping — a read-then-unlink race
    // could destroy a live replacement created between the two). The owner
    // releases it owner-checked, the KV sibling expires server-side, and a
    // crashed file holder is recovered by the documented manual procedure
    // (service stopped). Contenders wait boundedly, then fail closed; the
    // deadline is checked on EVERY iteration so no read/outcome path can
    // spin past it.
    if (Date.now() >= deadline) throw new TraktLockUnavailableError()
    await new Promise((r) => setTimeout(r, TRAKT_LOCK_POLL_MS))
  }
}

async function releaseFileLock(file: string, owner: string): Promise<void> {
  try {
    const raw = await fsp.readFile(file, "utf-8").catch(() => null)
    const parsed = raw === null ? null : parseLockPayload(raw)
    // Owner-checked release: a stale holder whose file was manually cleared
    // (offline recovery) and recreated by the current holder must not unlink
    // it. Only the exact owner removes the file.
    if (parsed && parsed.owner === owner) await fsp.unlink(file).catch(() => {})
  } catch (e) {
    log.warn("trakt profile lock release failed", { error: e instanceof Error ? e.message : String(e) })
  }
}

/**
 * Acquire the per-profile Trakt MUTATION mutex. Serializes the short
 * storage critical sections (guarded commit, disconnect fence+delete,
 * conditional invalid_grant clear, wipe deletes) — held ONLY across
 * storage IO, never across the network. Bounded wait (`waitMs`, default
 * `TRAKT_LOCK_WAIT_MS`); file locks are NEVER automatically removed
 * (no-steal — not on TTL expiry, not for dead owners; crash recovery is the
 * documented manual procedure with the service stopped) — contention always
 * ends in `TraktLockUnavailableError`, never in a steal. The KV key
 * auto-expires (`ttlMs`, default `TRAKT_LOCK_TTL_MS`) so a crashed holder
 * can never wedge the profile. Throws `TraktLockUnavailableError` on
 * contention timeout, EVAL outage or IO trouble — the caller must abort the
 * write (fail-closed).
 */
export async function acquireTraktProfileLock(
  userId: string,
  opts?: { waitMs?: number; ttlMs?: number },
): Promise<TraktProfileLock> {
  assertValidUserId(userId)
  const { waitMs, ttlMs, owner } = normalizeLockOpts(opts)
  try {
    if (isKvMode()) {
      await acquireKvLock(lockKvKey(userId), owner, ttlMs, waitMs)
      return { userId, owner, release: () => releaseKvLock(lockKvKey(userId), owner) }
    }
    const file = lockFile(userId)
    await acquireFileLock(file, owner, ttlMs, waitMs)
    return { userId, owner, release: () => releaseFileLock(file, owner) }
  } catch (e) {
    if (e instanceof TraktLockUnavailableError) throw e
    log.warn("trakt profile lock acquire failed")
    throw new TraktLockUnavailableError()
  }
}

/**
 * Acquire the per-profile Trakt REFRESH mutex. Held across the token
 * exchange by the refresh flow so concurrent refreshers share one upstream
 * call (single-flight); the guarded commit still re-validates the fencing
 * generation, so this mutex is dedup only, never safety. Same fail-closed
 * bounds as the mutation lock. File backend uses a SEPARATE lock file from
 * the mutation lock (a refresh must never block an explicit disconnect, and
 * vice versa); KV mode shares the single server-side key (commit/conditional
 * paths prove ownership inside their atomic scripts instead of re-acquiring).
 * Fixed lock order everywhere: refresh mutex first, mutation lock second.
 */
export async function acquireTraktRefreshLock(
  userId: string,
  opts?: { waitMs?: number; ttlMs?: number },
): Promise<TraktProfileLock> {
  assertValidUserId(userId)
  const { waitMs, ttlMs, owner } = normalizeLockOpts(opts)
  try {
    if (isKvMode()) {
      await acquireKvLock(lockKvKey(userId), owner, ttlMs, waitMs)
      return { userId, owner, release: () => releaseKvLock(lockKvKey(userId), owner) }
    }
    const file = refreshLockFile(userId)
    await acquireFileLock(file, owner, ttlMs, waitMs)
    return { userId, owner, release: () => releaseFileLock(file, owner) }
  } catch (e) {
    if (e instanceof TraktLockUnavailableError) throw e
    log.warn("trakt refresh lock acquire failed")
    throw new TraktLockUnavailableError()
  }
}

function normalizeLockOpts(opts?: { waitMs?: number; ttlMs?: number }): {
  waitMs: number
  ttlMs: number
  owner: string
} {
  const waitMs =
    typeof opts?.waitMs === "number" && Number.isFinite(opts.waitMs) && opts.waitMs >= 0
      ? Math.min(opts.waitMs, 30_000)
      : TRAKT_LOCK_WAIT_MS
  const ttlMs =
    typeof opts?.ttlMs === "number" && Number.isFinite(opts.ttlMs) && opts.ttlMs >= 100
      ? Math.min(opts.ttlMs, 60_000)
      : TRAKT_LOCK_TTL_MS
  return { waitMs, ttlMs, owner: newOwner() }
}
