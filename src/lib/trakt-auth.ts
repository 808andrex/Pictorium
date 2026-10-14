/**
 * Trakt OAuth foundation — task 1/plan: secure SERVER-ONLY deployment config
 * + encrypted per-user token persistence. No auth routes, no state flow, no
 * UI, no provider wiring and no remote calls in this module (later tasks).
 *
 * SERVER-ONLY: this module imports `node:fs`/`node:path` (plus the
 * `node:crypto`-backed `@/lib/profile-crypto` and the KV client, which pulls
 * `ioredis`). No `server-only` package import: the package is not a
 * dependency and a bare import would fail typecheck/build (same rule as
 * `i18n-server.ts`). The boundary is enforced by the import graph — NEVER
 * import this module from client components or from shared client/server
 * leaves (`poster-config`, `poster-url`, `badge-priority`,
 * `stremio-poster-url`, ...). Only `src/app/api/**` routes and other server
 * lib modules may import it. A unit test pins this boundary.
 *
 * Config (one Trakt app per deployment, PKCE public client — no secret):
 * - `PICTORIUM_TRAKT_CLIENT_ID` (legacy `POSTERIUM_*`, raw `TRAKT_CLIENT_ID`
 *   — same resolution as the public-list client in
 *   `custom-catalog-providers.ts`, so one app covers lists + OAuth).
 *   A `PICTORIUM_TRAKT_CLIENT_SECRET` env var, when present, is deliberately
 *   IGNORED: per the official PKCE docs (Oct 2026) new Trakt apps receive no
 *   secret and user sign-in must never send one.
 * - `PICTORIUM_TRAKT_REDIRECT_URI` (canonical; legacy fallback): the exact
 *   redirect URI registered in the Trakt app dashboard
 *   (e.g. `https://pictorium.duckdns.org/api/trakt/callback`). It is read
 *   ONLY from env — never derived from the request Host/X-Forwarded-Host,
 *   so a poisoned Host header can never steer the code exchange. HTTPS only:
 *   PKCE redirect URIs must be `https://` (local testing goes through an
 *   HTTPS tunnel serving the whole UI origin).
 *
 * Tokens (per-user OAuth tokens protected at rest):
 * - Stored per UUID under `users/<uuid>/trakt.json` (mode 0600, atomic
 *   write) or the shared KV backend (`user:<uuid>:trakt`) — same dual-backend
 *   pattern as `user-keys.ts`. `access_token`/`refresh_token` are AES-256-GCM
 *   bundles via `@/lib/profile-crypto` (`PROFILE_ENCRYPTION_KEY`); expiry,
 *   scope, token type and the redirect-URI binding stay plaintext metadata
 *   (never secrets), as needed by the later refresh flow.
 * - Writes fail closed without valid encryption (never plaintext fallback).
 * - Reads distinguish `connected` (decryptable record) from `disconnected`
 *   (no record) and `unavailable` (present-but-unreadable, missing/invalid
 *   encryption, tampered or malformed record, storage error). Later flows
 *   MUST NOT delete tokens on `unavailable` — it is transient/operational,
 *   not a user disconnect.
 * - UUIDs are validated with the same strict pattern as `user-keys.ts`
 *   (no path traversal: `..`, `/`, `.` never pass).
 *
 * Token response shape follows the Trakt docs (`POST /oauth/token` →
 * `{ access_token, token_type, expires_in, refresh_token, scope,
 * created_at }`); the shared exchange validator lives in
 * `trakt-token-exchange.ts`, the coordinated save/refresh/disconnect below.
 */
import crypto from "node:crypto"
import fsp from "node:fs/promises"
import path from "node:path"
import { atomicWriteFile } from "@/lib/atomic-write"
import { envWithFallback } from "@/lib/env-compat"
import { getKv, getStorageMode } from "@/lib/kv"
import { createLogger } from "@/lib/logger"
import {
  decryptProfileSecret,
  encryptProfileSecret,
  isValidEncBundle,
  profileEncryptionKey,
  type EncBundle,
} from "@/lib/profile-crypto"
import { userDir, userExists } from "@/lib/user-auth"

const log = createLogger("trakt-auth")

// Lettura live (mai a module level): i test mutano le env + resetModules.
// Nome senza prefisso `use`: la regola react-hooks lo scambierebbe per un Hook.
function isKvMode(): boolean {
  return getStorageMode() === "kv"
}

// ── Deployment config ───────────────────────────────────────────────

/** Canonical OAuth callback path (both registered redirect URIs end here). */
export const TRAKT_CALLBACK_PATH = "/api/trakt/callback"

export type TraktConfigReason =
  | "missing_client_id"
  | "missing_redirect_uri"
  | "invalid_client_id"
  | "invalid_redirect_uri"

/** Deployment OAuth config (PKCE public client: no secret). NEVER log tokens. */
export interface TraktOAuthConfig {
  clientId: string
  redirectUri: string
}

/**
 * Deployment config rejected without usable OAuth credentials/redirect.
 * Messages are generic on purpose: they never echo env values.
 */
export class TraktConfigError extends Error {
  readonly reason: TraktConfigReason
  constructor(reason: TraktConfigReason) {
    super("Trakt OAuth is not configured correctly")
    this.name = "TraktConfigError"
    this.reason = reason
  }
}

const MAX_CLIENT_ID_LENGTH = 256

function resolveClientId(): string | undefined {
  // Same resolution as the public-list client (custom-catalog-providers.ts):
  // canonical PICTORIUM_* > legacy POSTERIUM_* > raw TRAKT_CLIENT_ID.
  return envWithFallback("TRAKT_CLIENT_ID") || process.env.TRAKT_CLIENT_ID
}

function checkClientId(raw: string | undefined): { value?: string; reason?: TraktConfigReason } {
  if (raw === undefined || raw.trim() === "") {
    return { reason: raw === undefined ? "missing_client_id" : "invalid_client_id" }
  }
  const v = raw.trim()
  if (v.length > MAX_CLIENT_ID_LENGTH || /\s/.test(v)) return { reason: "invalid_client_id" }
  return { value: v }
}

/**
 * Canonical redirect URI check: absolute HTTPS URL, no userinfo, no
 * query/hash (Trakt matches the registered URI exactly), path exactly
 * `/api/trakt/callback`. Plain http (even loopback) is rejected: PKCE
 * redirects must be `https://` — local testing goes through an HTTPS tunnel
 * serving the whole UI origin. Never derived from the request — env only.
 */
function checkRedirectUri(raw: string | undefined): { value?: string; reason?: TraktConfigReason } {
  if (raw === undefined) return { reason: "missing_redirect_uri" }
  const v = raw.trim()
  if (!v) return { reason: "invalid_redirect_uri" }
  let url: URL
  try {
    url = new URL(v)
  } catch {
    return { reason: "invalid_redirect_uri" }
  }
  if (url.username || url.password) return { reason: "invalid_redirect_uri" }
  if (url.search || url.hash) return { reason: "invalid_redirect_uri" }
  if (!url.hostname) return { reason: "invalid_redirect_uri" }
  const normalizedPath = url.pathname.replace(/\/+$/, "") || "/"
  if (normalizedPath !== TRAKT_CALLBACK_PATH) return { reason: "invalid_redirect_uri" }
  if (url.protocol === "https:") return { value: v }
  return { reason: "invalid_redirect_uri" }
}

function readConfig(): { config?: TraktOAuthConfig; reason: TraktConfigReason | null } {
  const id = checkClientId(resolveClientId())
  if (!id.value) return { reason: id.reason ?? "invalid_client_id" }
  const redirect = checkRedirectUri(envWithFallback("TRAKT_REDIRECT_URI"))
  if (!redirect.value) return { reason: redirect.reason ?? "invalid_redirect_uri" }
  return { config: { clientId: id.value, redirectUri: redirect.value }, reason: null }
}

/** Full deployment config for server-internal use (token exchange). Throws fail-closed. */
export function getTraktOAuthConfig(): TraktOAuthConfig {
  const { config, reason } = readConfig()
  if (!config || reason) {
    // Never the values: only the machine-readable reason travels with it.
    log.warn("Trakt OAuth config invalid", { reason })
    throw new TraktConfigError(reason ?? "missing_client_id")
  }
  return config
}

/** True only when client ID + redirect URI are both present and valid (no secret: PKCE). */
export function isTraktOAuthConfigured(): boolean {
  return readConfig().reason === null
}

/** Secret-free status: `reason` is a machine code, never an env value. */
export function getTraktOAuthStatus(): { configured: boolean; reason: TraktConfigReason | null } {
  const { reason } = readConfig()
  return { configured: reason === null, reason }
}

/**
 * Secret-free public info for later Connect UI wiring: whether the instance
 * can start OAuth, and the canonical redirect URI (already public — it is
 * registered in the Trakt dashboard and shown in the authorize URL).
 * NEVER includes tokens (there is no client secret in PKCE mode).
 */
export function getTraktOAuthPublicInfo(): { configured: boolean; redirectUri: string | null } {
  const { config } = readConfig()
  if (!config) return { configured: false, redirectUri: null }
  return { configured: true, redirectUri: config.redirectUri }
}

// ── Per-user token store ────────────────────────────────────────────

function assertValidUserId(userId: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("Invalid user id")
}

/** Save refused: encryption unavailable → fail-closed, never plaintext. */
export class TraktTokensEncryptionUnavailableError extends Error {
  constructor() {
    super("Trakt token encryption is unavailable: set PROFILE_ENCRYPTION_KEY (openssl rand -hex 32)")
    this.name = "TraktTokensEncryptionUnavailableError"
  }
}

/** Token input rejected (empty/oversize/malformed field). Never echoes values. */
export class InvalidTraktTokenError extends Error {
  constructor(field: string) {
    super(`Invalid Trakt token field: ${field}`)
    this.name = "InvalidTraktTokenError"
  }
}

const MAX_TOKEN_LENGTH = 4096
const MAX_SCOPE_LENGTH = 256

function checkOpaqueToken(field: "accessToken" | "refreshToken", value: unknown): string {
  if (typeof value !== "string") throw new InvalidTraktTokenError(field)
  const v = value.trim()
  if (!v || v.length > MAX_TOKEN_LENGTH || /\s/.test(v)) throw new InvalidTraktTokenError(field)
  return v
}

/** Caller-facing token input (e.g. from the later callback exchange). */
export interface TraktTokenInput {
  accessToken: string
  refreshToken: string
  /** Absolute expiry as ms epoch (computed from `expires_in`+`created_at`). */
  expiresAt: number
  scope?: string
  tokenType?: string
  /** Redirect URI used in the exchange (binding for later refresh). */
  redirectUri?: string
}

/** Decrypted tokens — server memory only, never logged, never sent to clients. */
export interface TraktTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope: string | null
  tokenType: string | null
  /** Redirect URI bound at issuance (must match on refresh). */
  redirectUri: string | null
  createdAt: string
  updatedAt: string
}

export type TraktConnectionStatus = "connected" | "disconnected" | "unavailable"

export type TraktReadFailureReason =
  | "no_record"
  | "malformed"
  | "decrypt_failed"
  | "encryption_unavailable"
  | "storage_error"

export type TraktTokenRead =
  | { status: "connected"; tokens: TraktTokens }
  | { status: "disconnected" | "unavailable"; tokens: null; reason: TraktReadFailureReason }

interface TraktFile {
  version: 1
  access: EncBundle
  refresh: EncBundle
  expiresAt: number
  scope?: string
  tokenType?: string
  redirectUri?: string
  createdAt: string
  updatedAt: string
  /**
   * Fencing snapshot (task 3): the sidecar generation (`trakt.gen` /
   * `user:<uuid>:trakt:gen`) at write time. Optional — legacy records
   * predate it and read fine without it; the sidecar (not this field) is
   * the source of truth for stale-write detection.
   */
  gen?: string
}

function traktFile(userId: string): string {
  return path.join(userDir(userId), "trakt.json")
}

function traktKvKey(userId: string): string {
  return `user:${userId}:trakt`
}

function isValidTraktFile(v: unknown): v is TraktFile {
  if (!v || typeof v !== "object") return false
  const f = v as Record<string, unknown>
  return (
    f.version === 1 &&
    isValidEncBundle(f.access) &&
    isValidEncBundle(f.refresh) &&
    typeof f.expiresAt === "number" &&
    Number.isFinite(f.expiresAt) &&
    f.expiresAt > 0
  )
}

type TraktRawRead = { kind: "ok"; raw: unknown; found: boolean } | { kind: "storage_error" }

async function readTraktFile(userId: string): Promise<TraktRawRead> {
  if (isKvMode()) {
    try {
      const raw = await getKv().get<TraktFile>(traktKvKey(userId))
      if (raw === null || raw === undefined) return { kind: "ok", raw: null, found: false }
      return { kind: "ok", raw, found: true }
    } catch (e) {
      log.warn("trakt tokens KV read failed", { error: e instanceof Error ? e.message : String(e) })
      return { kind: "storage_error" }
    }
  }
  try {
    const text = await fsp.readFile(traktFile(userId), "utf-8")
    return { kind: "ok", raw: JSON.parse(text) as unknown, found: true }
  } catch (e) {
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "ok", raw: null, found: false }
    }
    // Malformed JSON on disk: found-but-unreadable (never "disconnected",
    // so later flows won't treat it as a user disconnect).
    if (e instanceof SyntaxError) return { kind: "ok", raw: e, found: true }
    log.warn("trakt tokens read failed", { error: e instanceof Error ? e.message : String(e) })
    return { kind: "storage_error" }
  }
}

function checkScope(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string") throw new InvalidTraktTokenError("scope")
  const v = value.trim()
  if (!v) return null
  if (v.length > MAX_SCOPE_LENGTH) throw new InvalidTraktTokenError("scope")
  return v
}

function checkTokenType(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string") throw new InvalidTraktTokenError("tokenType")
  const v = value.trim()
  if (!v) return null
  if (v.length > 32 || /\s/.test(v)) throw new InvalidTraktTokenError("tokenType")
  return v
}

function checkExpiresAt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new InvalidTraktTokenError("expiresAt")
  }
  return Math.floor(value)
}

function checkRedirectBinding(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string") throw new InvalidTraktTokenError("redirectUri")
  const v = value.trim()
  if (!v) return null
  try {
    const url = new URL(v)
    if (!url.hostname || url.username || url.password) throw new Error("bad redirect binding")
    return v
  } catch {
    throw new InvalidTraktTokenError("redirectUri")
  }
}

/**
 * Persist (overwrite) the user's OAuth tokens. Creates the record when
 * absent; preserves the original `createdAt` on overwrite. Requires valid
 * encryption when token material is written (fail-closed). Only this user's
 * record is touched.
 */
export async function saveTraktTokens(userId: string, input: TraktTokenInput): Promise<void> {
  assertValidUserId(userId)
  const accessToken = checkOpaqueToken("accessToken", input?.accessToken)
  const refreshToken = checkOpaqueToken("refreshToken", input?.refreshToken)
  const expiresAt = checkExpiresAt(input?.expiresAt)
  const scope = checkScope(input?.scope)
  const tokenType = checkTokenType(input?.tokenType)
  const redirectUri = checkRedirectBinding(input?.redirectUri)
  const key = profileEncryptionKey()
  if (!key) throw new TraktTokensEncryptionUnavailableError()
  const previous = await readTraktFile(userId)
  const now = new Date().toISOString()
  const prevRaw = previous.kind === "ok" && previous.found ? previous.raw : null
  const preservedCreatedAt =
    prevRaw !== null && isValidTraktFile(prevRaw) && typeof prevRaw.createdAt === "string"
      ? prevRaw.createdAt
      : now
  const file: TraktFile = {
    version: 1,
    access: encryptProfileSecret(accessToken, key),
    refresh: encryptProfileSecret(refreshToken, key),
    expiresAt,
    updatedAt: now,
    createdAt: preservedCreatedAt,
  }
  if (scope !== null) file.scope = scope
  if (tokenType !== null) file.tokenType = tokenType
  if (redirectUri !== null) file.redirectUri = redirectUri
  // Never token values in logs: only the user id.
  log.info("Trakt tokens saved", { user: userId })
  if (isKvMode()) {
    await getKv().set(traktKvKey(userId), file)
    return
  }
  await fsp.mkdir(userDir(userId), { recursive: true })
  await atomicWriteFile(traktFile(userId), JSON.stringify(file), { mode: 0o600 })
}

/**
 * Decrypted tokens for server-internal use (refresh, API calls). Never
 * throws on storage/crypto trouble: those map to `unavailable` (transient)
 * so later flows never mistake them for `disconnected` (user never linked
 * or explicitly cleared) and never delete the record on a transient error.
 * Only an invalid UUID throws (fail-closed: no path/KV key is ever built).
 */
export async function getTraktTokens(userId: string): Promise<TraktTokenRead> {
  assertValidUserId(userId)
  const read = await readTraktFile(userId)
  if (read.kind === "storage_error") {
    return { status: "unavailable", tokens: null, reason: "storage_error" }
  }
  const { raw, found } = read
  if (!found) return { status: "disconnected", tokens: null, reason: "no_record" }
  if (!isValidTraktFile(raw)) {
    log.error("trakt tokens record malformed — treating as unavailable (never deleting)")
    return { status: "unavailable", tokens: null, reason: "malformed" }
  }
  const key = profileEncryptionKey()
  if (!key) {
    log.error("trakt tokens present but PROFILE_ENCRYPTION_KEY is missing/invalid — treating as unavailable")
    return { status: "unavailable", tokens: null, reason: "encryption_unavailable" }
  }
  try {
    const accessToken = decryptProfileSecret(raw.access, key)
    const refreshToken = decryptProfileSecret(raw.refresh, key)
    if (!accessToken || !refreshToken) throw new Error("empty decrypted token")
    return {
      status: "connected",
      tokens: {
        accessToken,
        refreshToken,
        expiresAt: raw.expiresAt,
        scope: typeof raw.scope === "string" ? raw.scope : null,
        tokenType: typeof raw.tokenType === "string" ? raw.tokenType : null,
        redirectUri: typeof raw.redirectUri === "string" ? raw.redirectUri : null,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
      },
    }
  } catch {
    // Tamper or env rotated/removed: unavailable, record left intact.
    log.error("trakt tokens failed to decrypt — treating as unavailable (never deleting)")
    return { status: "unavailable", tokens: null, reason: "decrypt_failed" }
  }
}

/** Secret-free connection state (safe for status endpoints and later UI). */
export async function getTraktTokenStatus(userId: string): Promise<TraktConnectionStatus> {
  return (await getTraktTokens(userId)).status
}

/**
 * Delete ONLY this user's token record (explicit disconnect). Returns true
 * when a record existed. Never touches other users. Invalid UUID throws
 * before any path/KV key is built.
 */
export async function clearTraktTokens(userId: string): Promise<boolean> {
  assertValidUserId(userId)
  if (isKvMode()) {
    const removed = await getKv().del(traktKvKey(userId))
    if (removed > 0) log.info("Trakt tokens cleared", { user: userId })
    return removed > 0
  }
  try {
    await fsp.unlink(traktFile(userId))
    log.info("Trakt tokens cleared", { user: userId })
    return true
  } catch (e) {
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") return false
    throw e
  }
}

/**
 * Pure expiry check for coordinated refresh: true when the token
 * is expired or expires within `skewMs` (default 60s clock skew/grace).
 */
export function isTraktTokenExpired(tokens: Pick<TraktTokens, "expiresAt">, skewMs = 60_000): boolean {
  return Date.now() >= tokens.expiresAt - skewMs
}

// ── Coordinated lifecycle (task 3) ────────────────────────────────────
// Single-flight refresh, fenced writes, explicit disconnect. The raw
// `saveTraktTokens` above stays the unconditional store primitive (it must
// keep working without a user record — unit tests provision bare UUIDs);
// the flows that race with wipe/disconnect (callback, refresh) use the
// guarded path below, which never recreates a wiped namespace.

/**
 * Guarded save aborted: `stale` (generation moved — a disconnect, wipe or
 * newer write landed after the caller captured it) or `user_gone` (the
 * profile no longer exists). Both fail closed WITHOUT writing. Never thrown
 * for storage/crypto trouble — those propagate as-is (transient).
 */
export class TraktSaveAbortedError extends Error {
  readonly reason: "stale" | "user_gone"
  constructor(reason: "stale" | "user_gone") {
    super(reason === "stale" ? "Trakt save aborted: stale generation" : "Trakt save aborted: user no longer exists")
    this.name = "TraktSaveAbortedError"
    this.reason = reason
  }
}

// Atomic check-and-set for the KV backend: user must still exist AND the
// generation must still match the caller's snapshot AND the caller must
// still own the refresh mutex, otherwise nothing is written. One
// server-side step — no TOCTOU between check and write. The ownership proof
// stops a holder whose lease expired mid-exchange from writing even when no
// newer save moved the generation yet. EVAL failure throws (fail-closed);
// there is deliberately no get+set fallback.
const TOKEN_CAS_SCRIPT = `-- trakt-token-cas
local auth = redis.call("GET", KEYS[3])
if not auth then return "no_user" end
local g = redis.call("GET", KEYS[2])
if g == false then g = "" end
if g ~= ARGV[1] then return "stale" end
if redis.call("GET", KEYS[4]) ~= ARGV[4] then return "stale" end
redis.call("SET", KEYS[1], ARGV[2])
redis.call("SET", KEYS[2], ARGV[3])
return "ok"`

// Atomic conditional clear for a proven-dead refresh token: same gates as
// the CAS (user exists, generation matches the pre-exchange snapshot,
// mutex still owned) — a stale holder can never delete a newer reconnect.
// Deletes the token record and installs a fresh generation in one step.
const TOKEN_COND_CLEAR_SCRIPT = `-- trakt-token-cond-clear
local auth = redis.call("GET", KEYS[3])
if not auth then return "no_user" end
local g = redis.call("GET", KEYS[2])
if g == false then g = "" end
if g ~= ARGV[1] then return "stale" end
if redis.call("GET", KEYS[4]) ~= ARGV[3] then return "stale" end
redis.call("DEL", KEYS[1])
redis.call("SET", KEYS[2], ARGV[2])
return "ok"`

// Atomic explicit disconnect: install a fresh fence generation AND delete
// the token record in one server-side step (auth-gated so a concurrent wipe
// stays a clean no-op instead of recreating a generation tombstone). A
// concurrent CAS either landed fully before (then deleted here) or sees the
// new generation after (then aborts as stale) — linearizable either way,
// with no lock to contend on. EVAL/storage failure throws (fail-closed:
// the caller must NOT report disconnected).
const TRAKT_DISCONNECT_SCRIPT = `-- trakt-disconnect
local auth = redis.call("GET", KEYS[3])
if not auth then return "no_user" end
redis.call("SET", KEYS[2], ARGV[1])
redis.call("DEL", KEYS[1])
return "ok"`

function traktGenKvKey(userId: string): string {
  return `user:${userId}:trakt:gen`
}

function traktAuthKvKey(userId: string): string {
  return `user:${userId}:auth`
}

function traktLockKvKey(userId: string): string {
  return `user:${userId}:trakt:lock`
}

function cryptoRandom(): string {
  return crypto.randomBytes(8).toString("hex")
}

function checkedTokenInput(input: TraktTokenInput): {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope: string | null
  tokenType: string | null
  redirectUri: string | null
} {
  return {
    accessToken: checkOpaqueToken("accessToken", input?.accessToken),
    refreshToken: checkOpaqueToken("refreshToken", input?.refreshToken),
    expiresAt: checkExpiresAt(input?.expiresAt),
    scope: checkScope(input?.scope),
    tokenType: checkTokenType(input?.tokenType),
    redirectUri: checkRedirectBinding(input?.redirectUri),
  }
}

async function buildGuardedFile(
  userId: string,
  checked: ReturnType<typeof checkedTokenInput>,
  now: string,
): Promise<TraktFile> {
  const key = profileEncryptionKey()
  if (!key) throw new TraktTokensEncryptionUnavailableError()
  const previous = await readTraktFile(userId)
  const prevRaw = previous.kind === "ok" && previous.found ? previous.raw : null
  const preservedCreatedAt =
    prevRaw !== null && isValidTraktFile(prevRaw) && typeof prevRaw.createdAt === "string"
      ? prevRaw.createdAt
      : now
  const file: TraktFile = {
    version: 1,
    access: encryptProfileSecret(checked.accessToken, key),
    refresh: encryptProfileSecret(checked.refreshToken, key),
    expiresAt: checked.expiresAt,
    updatedAt: now,
    createdAt: preservedCreatedAt,
  }
  if (checked.scope !== null) file.scope = checked.scope
  if (checked.tokenType !== null) file.tokenType = checked.tokenType
  if (checked.redirectUri !== null) file.redirectUri = checked.redirectUri
  return file
}

/**
 * Write assuming the caller holds the right to commit: the file mutation
 * lock (file backend) or the refresh-mutex ownership proof carried into the
 * CAS script (KV backend). Re-checks the fencing generation + user
 * existence at the storage boundary, then writes WITHOUT mkdir (file) or
 * via atomic CAS (KV): a concurrently wiped namespace is never recreated, a
 * post-disconnect save never lands. Bumps the generation on success. Throws
 * `TraktSaveAbortedError` on stale/gone; storage/crypto errors propagate
 * (transient, record intact). `lockOwner` is REQUIRED for the KV CAS (the
 * mutex key + owner travel in the script); the file path ignores it (the
 * held mutation lock already serializes committers — a live holder is never
 * stolen, so one holder means one committer).
 */
async function writeTraktRecordLocked(
  userId: string,
  input: TraktTokenInput,
  expectedGeneration: string | null,
  lockOwner: string,
): Promise<void> {
  const checked = checkedTokenInput(input)
  const { getTraktGeneration, bumpTraktGeneration } = await import("@/lib/trakt-profile-lock")
  if (isKvMode()) {
    const kv = getKv()
    const now = new Date().toISOString()
    const file = await buildGuardedFile(userId, checked, now)
    const newGen = `${Date.now()}-${cryptoRandom()}`
    ;(file as TraktFile).gen = newGen
    const outcome = await kv.eval<string>(
      TOKEN_CAS_SCRIPT,
      [traktKvKey(userId), traktGenKvKey(userId), traktAuthKvKey(userId), traktLockKvKey(userId)],
      [expectedGeneration ?? "", JSON.stringify(file), newGen, lockOwner],
    )
    if (outcome === "ok") {
      log.info("Trakt tokens saved", { user: userId })
      return
    }
    if (outcome === "no_user") throw new TraktSaveAbortedError("user_gone")
    throw new TraktSaveAbortedError("stale")
  }
  // File backend: the held mutation lock serializes committers on this host;  // the generation compare inside the critical section is the fence that
  // stops a disconnected/wiped/superseded save. The bump and the token write
  // both happen under the same hold — a disconnect's fence can never land
  // between our check and our write (disconnect fences under this same
  // lock), so nothing later overwrites our fence, and we never overwrite
  // someone else's.
  // Generation outage inside the critical section propagates fail-closed
  // (transient): an unknown generation is never treated as a match.
  const current = await getTraktGeneration(userId)
  if (current !== expectedGeneration) throw new TraktSaveAbortedError("stale")
  if (!(await userExists(userId))) throw new TraktSaveAbortedError("user_gone")
  const now = new Date().toISOString()
  const file = await buildGuardedFile(userId, checked, now)
  try {
    // Deliberately NO mkdir: when the namespace was wiped between the check
    // and the write, ENOENT aborts instead of resurrecting the directory.
    await atomicWriteFile(traktFile(userId), JSON.stringify(file), { mode: 0o600 })
  } catch (e) {
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TraktSaveAbortedError("user_gone")
    }
    throw e
  }
  // Re-verify before fencing: a wipe that landed between the write and the
  // bump must surface as user_gone (never a "connected" outcome on a wiped
  // profile), and the mkdir-free bump below can never recreate the dir.
  if (!(await userExists(userId))) {
    await fsp.unlink(traktFile(userId)).catch(() => {})
    throw new TraktSaveAbortedError("user_gone")
  }
  try {
    file.gen = await bumpTraktGeneration(userId)
  } catch (e) {
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
      await fsp.unlink(traktFile(userId)).catch(() => {})
      throw new TraktSaveAbortedError("user_gone")
    }
    throw e
  }
  // Stamp the fencing snapshot (best-effort: the sidecar is the truth).
  try {
    await atomicWriteFile(traktFile(userId), JSON.stringify(file), { mode: 0o600 })
  } catch {
    /* sidecar already bumped — the write above holds the tokens */
  }
  log.info("Trakt tokens saved", { user: userId })
}

/**
 * Conditional clear for a PROVEN-dead refresh token (`invalid_grant` only).
 * Aborts (returns false) when the generation moved since the caller's
 * pre-exchange snapshot — a newer reconnect's tokens are never deleted by a
 * stale holder — or when the user is gone (returns false; nothing to do).
 * KV additionally requires the caller to still own the refresh mutex
 * (lease-lost holders abort even with an unchanged generation). File
 * serializes under the mutation lock. Storage errors propagate
 * (fail-closed: the caller reports `temporary`, record intact). Returns true
 * only when this call actually cleared the record it fenced.
 */
async function clearTraktTokensConditional(
  userId: string,
  expectedGeneration: string | null,
  lockOwner: string,
): Promise<boolean> {
  const { getTraktGeneration, bumpTraktGeneration, acquireTraktProfileLock } = await import(
    "@/lib/trakt-profile-lock"
  )
  if (isKvMode()) {
    const outcome = await getKv().eval<string>(
      TOKEN_COND_CLEAR_SCRIPT,
      [traktKvKey(userId), traktGenKvKey(userId), traktAuthKvKey(userId), traktLockKvKey(userId)],
      [expectedGeneration ?? "", `${Date.now()}-${cryptoRandom()}`, lockOwner],
    )
    if (outcome === "ok") {
      log.info("Trakt tokens cleared", { user: userId })
      return true
    }
    return false
  }
  const lock = await acquireTraktProfileLock(userId, { waitMs: 5000 })
  try {
    const current = await getTraktGeneration(userId)
    if (current !== expectedGeneration) return false
    if (!(await userExists(userId))) return false
    await fsp.unlink(traktFile(userId)).catch(() => {})
    // Fence the clear (mkdir-free: ENOENT means a concurrent wipe won —
    // the record is gone either way, still a successful clear).
    await bumpTraktGeneration(userId).catch((e) => {
      if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") return
      throw e
    })
    log.info("Trakt tokens cleared", { user: userId })
    return true
  } finally {
    await lock.release()
  }
}

/**
 * Coordinated save for flows racing with wipe/disconnect (callback,
 * refresh). `expectedGeneration` is the fencing snapshot captured BEFORE
 * the network round-trip (callback: bound at flow initiation and carried in
 * the OAuth state; refresh: captured pre-exchange); any disconnect/wipe/
 * newer write since then aborts via `TraktSaveAbortedError`. Never recreates
 * a wiped namespace (no mkdir on the write path). `opts.refreshOwner`
 * carries a held refresh-mutex owner (refresh flow, KV mode) so the commit
 * proves ownership instead of acquiring the same key twice (non-reentrant).
 */
export async function saveTraktTokensGuarded(
  userId: string,
  input: TraktTokenInput,
  expectedGeneration: string | null,
  opts?: { lockWaitMs?: number; lockTtlMs?: number; refreshOwner?: string },
): Promise<void> {
  assertValidUserId(userId)
  if (isKvMode() && opts?.refreshOwner !== undefined) {
    await writeTraktRecordLocked(userId, input, expectedGeneration, opts.refreshOwner)
    return
  }
  const { acquireTraktProfileLock } = await import("@/lib/trakt-profile-lock")
  const lock = await acquireTraktProfileLock(userId, { waitMs: opts?.lockWaitMs, ttlMs: opts?.lockTtlMs })
  try {
    await writeTraktRecordLocked(userId, input, expectedGeneration, lock.owner)
  } finally {
    await lock.release()
  }
}

/**
 * Explicit local disconnect: durably fence the profile and delete ONLY this
 * user's token record. KV: one atomic EVAL (fresh fence + delete,
 * auth-gated); file: fence + delete under the mutation lock. Fail-closed on
 * storage trouble (EVAL outage, lock contention, IO): the caller MUST report
 * failure, never `{ ok: true }` over an intact record — a swallowed fence
 * plus a successful clear would leave the generation unchanged and let a
 * stale in-flight callback/refresh write resurrect the connection. The ONLY
 * swallowed outcome is the already-gone profile (no record, no fence
 * needed — the desired end state already holds). Upstream revocation
 * failure is NOT a storage failure: the local disconnect still proceeds
 * (the route revokes best-effort first, then calls here).
 */
export async function disconnectTraktProfile(userId: string): Promise<void> {
  assertValidUserId(userId)
  if (isKvMode()) {
    const outcome = await getKv().eval<string>(
      TRAKT_DISCONNECT_SCRIPT,
      [traktKvKey(userId), traktGenKvKey(userId), traktAuthKvKey(userId)],
      [`${Date.now()}-${cryptoRandom()}`],
    )
    if (outcome === "ok" || outcome === "no_user") {
      log.info("Trakt tokens cleared", { user: userId })
      return
    }
    // Unknown script outcome: fail closed (never claim a fence unset).
    throw new Error("Trakt disconnect failed: unexpected storage outcome")
  }
  const { acquireTraktProfileLock, bumpTraktGeneration } = await import("@/lib/trakt-profile-lock")
  const lock = await acquireTraktProfileLock(userId, { waitMs: 5000 })
  try {
    if (!(await userExists(userId))) {
      // Wiped concurrently: remove leftovers (throws on real IO — fail
      // closed), the desired end state already holds.
      await clearTraktTokens(userId)
      return
    }
    try {
      await bumpTraktGeneration(userId)
    } catch (e) {
      if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
        // Namespace vanished between the check and the fence: treat as a
        // concurrent wipe (record already gone with it).
        await clearTraktTokens(userId).catch(() => false)
        return
      }
      throw e
    }
    await clearTraktTokens(userId)
  } finally {
    await lock.release()
  }
}

export type TraktValidToken =
  | { ok: true; accessToken: string; refreshed: boolean }
  | { ok: false; reason: "disconnected" | "reconnect_required" | "temporary" | "not_configured" }

// Process-local single-flight: concurrent callers in THIS process share one
// refresh execution. Cross-process/cross-worker single-flight is the
// distributed profile lock (one refresh per expired token cluster-wide).
const refreshInflight = new Map<string, Promise<TraktValidToken>>()

function mapTokenReadToValid(read: TraktTokenRead): TraktValidToken | null {
  if (read.status === "disconnected") return { ok: false, reason: "disconnected" }
  if (read.status === "unavailable") return { ok: false, reason: "temporary" }
  return null
}

/**
 * Server-internal valid access token for the profile (future private-call
 * wiring; no private titles/endpoints yet). Returns typed states, never
 * throws on operational trouble, never deletes on transient failure, never
 * exposes tokens to browsers (callers keep the value in server memory;
 * status routes must keep using the secret-free `getTraktTokenStatus`).
 *
 * - Fresh token → `{ ok, refreshed: false }` with NO network call.
 * - Expired → exactly one coordinated refresh cluster-wide (in-process
 *   single-flight + distributed profile lock); concurrent callers share it.
 * - Abort/network/429/5xx/malformed/store-unavailable → `{ temporary }`,
 *   stored credentials intact (never deleted, never downgraded).
 * - Proven `invalid_grant` (permanent) → record cleared, `reconnect_required`.
 * - Unproven 4xx (e.g. bad deployment client ID) → `temporary`, never deleted.
 * - Lock contention/EVAL outage → `temporary` after one fresh re-read (a
 *   winner may have refreshed meanwhile); no get+del downgrade, no write.
 */
export async function getValidTraktAccessToken(
  userId: string,
  opts?: { lockWaitMs?: number; lockTtlMs?: number },
): Promise<TraktValidToken> {
  assertValidUserId(userId)
  const first = await getTraktTokens(userId)
  const mapped = mapTokenReadToValid(first)
  if (mapped) return mapped
  if (first.status !== "connected") return { ok: false, reason: "temporary" }
  if (!isTraktTokenExpired(first.tokens)) return { ok: true, accessToken: first.tokens.accessToken, refreshed: false }
  if (!getTraktOAuthStatus().configured) return { ok: false, reason: "not_configured" }
  const pending = refreshInflight.get(userId)
  if (pending) return pending
  const run = refreshTraktAccessToken(userId, opts).finally(() => {
    if (refreshInflight.get(userId) === run) refreshInflight.delete(userId)
  })
  refreshInflight.set(userId, run)
  return run
}

async function refreshTraktAccessToken(
  userId: string,
  opts?: { lockWaitMs?: number; lockTtlMs?: number },
): Promise<TraktValidToken> {
  const { acquireTraktRefreshLock, getTraktGeneration, TraktGenerationUnavailableError } = await import(
    "@/lib/trakt-profile-lock"
  )
  const { refreshTraktToken, TraktTokenRequestError } = await import("@/lib/trakt-token-exchange")
  // Fencing snapshot BEFORE any wait/network: a disconnect/wipe/newer write
  // from here on aborts our commit (the compare happens atomically at the
  // storage boundary). A generation outage aborts NOW (temporary): proceeding
  // with an unknown snapshot could pass a CAS check it must not pass.
  let expectedGeneration: string | null
  try {
    expectedGeneration = await getTraktGeneration(userId)
  } catch (e) {
    if (e instanceof TraktGenerationUnavailableError) return { ok: false, reason: "temporary" }
    throw e
  }
  // Refresh mutex across the exchange (single-flight dedup only — safety
  // stays with the fencing compare at commit). Short critical sections
  // (commit, disconnect, conditional clear) use the mutation lock / atomic
  // EVALs, so an explicit disconnect never blocks behind this mutex.
  let hold: { owner: string; release(): Promise<void> } | null = null
  try {
    try {
      hold = await acquireTraktRefreshLock(userId, {
        waitMs: opts?.lockWaitMs ?? 15_000,
        ttlMs: opts?.lockTtlMs ?? 20_000,
      })
    } catch {
      // Fail-closed on contention/EVAL outage: one fresh re-read (a winner
      // may have completed), then temporary. No write, no downgrade.
      return decideFromFreshRead(userId)
    }
    // Re-read while holding the mutex: a previous winner may have refreshed
    // already (no network needed), and a disconnect/wipe that landed while
    // we queued moved the generation (our snapshot is stale — stop before
    // spending an exchange that the commit would abort anyway).
    const current = await getTraktTokens(userId)
    const cm = mapTokenReadToValid(current)
    if (cm) return cm
    if (current.status !== "connected") return { ok: false, reason: "temporary" }
    if (!isTraktTokenExpired(current.tokens)) {
      return { ok: true, accessToken: current.tokens.accessToken, refreshed: false }
    }
    try {
      const queuedGen = await getTraktGeneration(userId)
      if (queuedGen !== expectedGeneration) return { ok: false, reason: "temporary" }
    } catch (e) {
      if (e instanceof TraktGenerationUnavailableError) return { ok: false, reason: "temporary" }
      throw e
    }
    let config
    try {
      config = getTraktOAuthConfig()
    } catch {
      return { ok: false, reason: "not_configured" }
    }
    let fresh: { accessToken: string; refreshToken: string; expiresAt: number; scope: string | null; tokenType: string | null }
    try {
      fresh = await refreshTraktToken(config, current.tokens.refreshToken, current.tokens.redirectUri)
    } catch (e) {
      if (e instanceof TraktTokenRequestError && e.failure.kind === "invalid_grant") {
        // Permanent: the refresh token is dead. Clear ONLY when the fence
        // still matches our pre-exchange snapshot — a newer reconnect's
        // tokens are never deleted by this stale holder. When the clear
        // aborts (stale/gone/lease-lost), decide from a fresh read: a valid
        // newer record wins over our dead refresh token.
        let cleared = false
        try {
          cleared = await clearTraktTokensConditional(userId, expectedGeneration, hold.owner)
        } catch {
          return { ok: false, reason: "temporary" }
        }
        if (cleared) return { ok: false, reason: "reconnect_required" }
        const after = await getTraktTokens(userId)
        if (after.status === "connected" && !isTraktTokenExpired(after.tokens)) {
          return { ok: true, accessToken: after.tokens.accessToken, refreshed: false }
        }
        const m = mapTokenReadToValid(after)
        // Disconnected (someone else disconnected/never linked): the dead
        // grant still means reconnect; anything else is transient.
        if (m) {
          if (!m.ok && m.reason === "disconnected") return { ok: false, reason: "reconnect_required" }
          return m
        }
        return { ok: false, reason: "temporary" }
      }
      // Transient (abort/network/429/5xx/malformed/store trouble): the
      // stored record stays exactly as it was — never deleted.
      return { ok: false, reason: "temporary" }
    }
    try {
      await saveTraktTokensGuarded(userId, {
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken,
        expiresAt: fresh.expiresAt,
        scope: fresh.scope ?? undefined,
        tokenType: fresh.tokenType ?? undefined,
        redirectUri: current.tokens.redirectUri ?? config.redirectUri,
      }, expectedGeneration, { refreshOwner: hold.owner })
    } catch (e) {
      if (e instanceof TraktSaveAbortedError) {
        // Fenced by a concurrent disconnect/wipe/newer write (or our mutex
        // lease expired mid-exchange — the CAS ownership proof): decide from
        // a fresh read (disconnected when the record is gone).
        return decideFromFreshRead(userId)
      }
      return { ok: false, reason: "temporary" }
    }
    return { ok: true, accessToken: fresh.accessToken, refreshed: true }
  } finally {
    if (hold) await hold.release()
  }
}

/**
 * Fresh-read decision after a fenced abort or a contended mutex: a
 * winner's fresh record is reused, anything else stays honest
 * (disconnected/unavailable map, expired-without-winner is temporary).
 */
async function decideFromFreshRead(userId: string): Promise<TraktValidToken> {
  const reread = await getTraktTokens(userId)
  if (reread.status === "connected" && !isTraktTokenExpired(reread.tokens)) {
    return { ok: true, accessToken: reread.tokens.accessToken, refreshed: false }
  }
  const m = mapTokenReadToValid(reread)
  return m ?? { ok: false, reason: "temporary" }
}

// ── Coherent catalog lease (task 4 correction cycle 1) ──────────────
// Stable, validated token+generation identity snapshot for owner-private
// catalog paths. Callers (the unified catalog dispatcher, the Stremio
// catalog handler) must establish this BEFORE any outer L1/L2 cache lookup
// and revalidate it AFTER the private fetch, before caching or returning
// private items — never coupling an old token to a new fence.
//
// Protocol: generation-before, token (with coordinated refresh), then
// generation-after. A mismatch means the fence moved mid-snapshot: a
// coordinated refresh bumps the fence itself, so one retry is allowed (the
// second pair is then stable on the refreshed token); persistent movement
// (disconnect/wipe/reconnect churn racing the snapshot) fails closed as
// `temporary`. A generation outage with an otherwise verified token
// degrades to `noCache` (serve fresh to the verified owner, never read or
// write any cache layer under a guessed fragment). A non-ok token maps to
// its typed reason — even when the generation is also unreadable, so a
// post-disconnect outage can never serve (there is no token to serve
// with). Raw tokens stay server-internal: consumers that only gate cache
// keys must ignore the `accessToken` field (never log, cache-key, or
// return it).
export type TraktCatalogLease =
  | { ok: true; accessToken: string; generation: string | null; noCache: boolean }
  | { ok: false; reason: "connection_required" | "temporary" | "key_missing" }

function mapValidToLeaseReason(reason: string): TraktCatalogLease {
  if (reason === "disconnected" || reason === "reconnect_required") {
    return { ok: false, reason: "connection_required" }
  }
  if (reason === "not_configured") return { ok: false, reason: "key_missing" }
  return { ok: false, reason: "temporary" }
}

export async function getTraktCatalogLease(userId: string): Promise<TraktCatalogLease> {
  assertValidUserId(userId)
  const { getTraktGeneration } = await import("@/lib/trakt-profile-lock")
  // At most two stable-pair attempts (see module comment above). Any
  // generation-read outage fail-closes to `temporary` when no verified
  // token backs the request, or to `noCache` serve when one does.
  for (let attempt = 0; attempt < 2; attempt++) {
    let genBefore: string | null | undefined
    try {
      genBefore = await getTraktGeneration(userId)
    } catch {
      genBefore = undefined
    }
    const valid = await getValidTraktAccessToken(userId)
    if (!valid.ok) return mapValidToLeaseReason(valid.reason)
    let genAfter: string | null | undefined
    try {
      genAfter = await getTraktGeneration(userId)
    } catch {
      genAfter = undefined
    }
    if (genBefore === undefined || genAfter === undefined) {
      return { ok: true, accessToken: valid.accessToken, generation: null, noCache: true }
    }
    if (genBefore === genAfter) {
      return { ok: true, accessToken: valid.accessToken, generation: genAfter, noCache: false }
    }
    // Fence moved between the token read and the generation read (a
    // disconnect/wipe/reconnect — or our own coordinated refresh — landed
    // in between): the token just read must never be coupled to the new
    // fence. Retry once for the refresh case; persistent movement aborts.
    if (attempt === 0) continue
    return { ok: false, reason: "temporary" }
  }
  return { ok: false, reason: "temporary" }
}
