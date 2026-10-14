/**
 * Shared Trakt `/oauth/token` + `/oauth/revoke` helpers — PKCE public client
 * (no client secret anywhere: user sign-in runs secretless per the official
 * PKCE docs, and refresh runs secretless via `POST /oauth/token` per the
 * official Authentication docs, both Oct 2026).
 *
 * `/oauth/revoke` is NOT covered by those docs (no public refresh/revoke
 * request reference found on developer.trakt.tv): the revoke shape below is
 * best-effort and operationally unverified, so the local fence+delete in
 * `trakt-auth.ts` (`disconnectTraktProfile`) is the tested source of truth
 * for disconnect — never the upstream answer. Users who need the Trakt-side
 * authorization provably gone should also remove the app under Trakt
 * Settings → Applications (https://trakt.tv/settings/apps).
 *
 * SERVER-ONLY: no `node:` imports (fetch/AbortController only), reachable
 * only from server lib modules (`trakt-auth.ts`) and server routes
 * (`/api/trakt/callback`, `/api/users/[uuid]/trakt/disconnect`). NEVER
 * import from client components or shared client/server leaves. Carries no
 * tokens itself — callers keep them in server memory only.
 *
 * Single schema validator for every token response (initial code exchange
 * AND refresh): both token materials present, finite `expires_in`/
 * `created_at` so `expiresAt` (created_at + expires_in, per Trakt docs) is a
 * valid absolute epoch, plus the official `scope`/`token_type` metadata the
 * callback used to drop (now persisted by the coordinated save).
 *
 * All POSTs are bounded (live-read `TRAKT_TIMEOUT_MS`, clamped like
 * `KV_COMMAND_TIMEOUT_MS`), send the client ID in the JSON body only (never
 * the URL), and never log bodies (status code at most). The official token
 * API base honors the existing `TRAKT_API_URL` test override convention
 * (same as the public-list client); the authorize host stays fixed.
 */
import { envWithFallback } from "@/lib/env-compat"
import { createLogger } from "@/lib/logger"

const log = createLogger("trakt-token-exchange")

/** Deployment OAuth client (structural: matches `TraktOAuthConfig` without importing it). */
export interface TraktOAuthClient {
  clientId: string
  redirectUri: string
}

const MAX_TOKEN_LENGTH = 4096
const MAX_SCOPE_LENGTH = 256

export function traktOAuthBase(): string {
  const override = process.env.TRAKT_API_URL?.replace(/\/+$/, "")
  if (override) return override
  return "https://api.trakt.tv"
}

/** Exchange cap: live-read so tests can shrink it; clamped 100ms–30s. */
export function traktTokenTimeoutMs(): number {
  const raw = envWithFallback("TRAKT_TIMEOUT_MS")
  const n = raw ? parseInt(raw, 10) : 8000
  return Number.isFinite(n) && n >= 100 && n <= 30000 ? n : 8000
}

export interface TraktTokenResponse {
  accessToken: string
  refreshToken: string
  /** Absolute expiry as ms epoch (created_at + expires_in). */
  expiresAt: number
  scope: string | null
  tokenType: string | null
}

/**
 * Validate the official `/oauth/token` response schema BEFORE persisting.
 * Throws on anything else — callers fail closed without overwriting.
 */
export function toTraktTokenResponse(data: unknown): TraktTokenResponse {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid token response")
  const d = data as Record<string, unknown>
  const accessToken = typeof d.access_token === "string" ? d.access_token.trim() : ""
  const refreshToken = typeof d.refresh_token === "string" ? d.refresh_token.trim() : ""
  if (
    !accessToken ||
    !refreshToken ||
    accessToken.length > MAX_TOKEN_LENGTH ||
    refreshToken.length > MAX_TOKEN_LENGTH ||
    /\s/.test(accessToken) ||
    /\s/.test(refreshToken)
  ) {
    throw new Error("Invalid token response")
  }
  const expiresIn = typeof d.expires_in === "number" ? d.expires_in : NaN
  const createdAt = typeof d.created_at === "number" ? d.created_at : NaN
  if (!Number.isFinite(expiresIn) || expiresIn <= 0 || !Number.isFinite(createdAt) || createdAt < 0) {
    throw new Error("Invalid token response")
  }
  const expiresAt = Math.floor(createdAt * 1000 + expiresIn * 1000)
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) throw new Error("Invalid token response")
  const scopeRaw = typeof d.scope === "string" ? d.scope.trim() : ""
  const scope = scopeRaw && scopeRaw.length <= MAX_SCOPE_LENGTH ? scopeRaw : null
  const typeRaw = typeof d.token_type === "string" ? d.token_type.trim() : ""
  const tokenType = typeRaw && typeRaw.length <= 32 && !/\s/.test(typeRaw) ? typeRaw : null
  return { accessToken, refreshToken, expiresAt, scope, tokenType }
}

export type TraktRefreshFailure =
  | { kind: "invalid_grant" }
  | { kind: "rate_limited"; retryAfterMs?: number }
  | { kind: "transient" }

export class TraktTokenRequestError extends Error {
  readonly failure: TraktRefreshFailure
  readonly status: number | null
  constructor(failure: TraktRefreshFailure, status: number | null) {
    super("Trakt token request failed")
    this.name = "TraktTokenRequestError"
    this.failure = failure
    this.status = status
  }
}

/**
 * Read a 400/401 error body for the OAuth2 `invalid_grant` marker. The body
 * is consumed as text (never logged, never returned) and only the boolean
 * travels on. Any read/parse trouble → false (fail transient, never delete).
 */
async function isInvalidGrant(res: Response): Promise<boolean> {
  try {
    const text = await res.text()
    if (!text || text.length > 4096) return false
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const err = (parsed as Record<string, unknown>).error
        if (typeof err === "string" && err.toLowerCase().includes("invalid_grant")) return true
      }
    } catch {
      /* not JSON: fall through to substring check */
    }
    return text.toLowerCase().includes("invalid_grant")
  } catch {
    return false
  }
}

async function postTokenFormWithGrantCheck(body: Record<string, string>): Promise<TraktTokenResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), traktTokenTimeoutMs())
  try {
    const res = await fetch(`${traktOAuthBase()}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      log.warn("trakt token request failed", { status: res.status })
      if ((res.status === 400 || res.status === 401) && (await isInvalidGrant(res))) {
        throw new TraktTokenRequestError({ kind: "invalid_grant" }, res.status)
      }
      const retryAfter = res.status === 429 ? parseRetryAfterMs(res.headers.get("retry-after")) : undefined
      throw new TraktTokenRequestError(
        res.status === 429 ? { kind: "rate_limited", retryAfterMs: retryAfter } : { kind: "transient" },
        res.status,
      )
    }
    let data: unknown
    try {
      data = (await res.json()) as unknown
    } catch {
      log.warn("trakt token request returned malformed response")
      throw new TraktTokenRequestError({ kind: "transient" }, res.status)
    }
    try {
      return toTraktTokenResponse(data)
    } catch {
      log.warn("trakt token request returned malformed response")
      throw new TraktTokenRequestError({ kind: "transient" }, res.status)
    }
  } catch (e) {
    if (e instanceof TraktTokenRequestError) throw e
    log.warn("trakt token request error")
    throw new TraktTokenRequestError({ kind: "transient" }, null)
  } finally {
    clearTimeout(timer)
  }
}

function parseRetryAfterMs(raw: string | null): number | undefined {
  if (!raw) return undefined
  const n = parseInt(raw.trim(), 10)
  return Number.isFinite(n) && n >= 0 && n <= 3600 ? n * 1000 : undefined
}

/** Authorization-code exchange (callback path). Throws `TraktTokenRequestError`. */
export async function exchangeTraktCode(
  config: TraktOAuthClient,
  code: string,
  verifier: string,
): Promise<TraktTokenResponse> {
  return postTokenFormWithGrantCheck({
    code,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
    code_verifier: checkCodeVerifier(verifier),
  })
}

/**
 * Local PKCE verifier check before the exchange: 43–128 unreserved chars.
 * A wrong/tampered verifier fails closed here (no network spent, nothing
 * persisted) — and would fail upstream too, since Trakt compares it against
 * the initiation challenge. Never logged, never returned.
 */
function checkCodeVerifier(verifier: unknown): string {
  if (typeof verifier !== "string" || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) {
    throw new TraktTokenRequestError({ kind: "transient" }, null)
  }
  return verifier
}

/**
 * Refresh-token grant (secretless PKCE public client). The redirect URI
 * binds the refresh to the issuance registration: prefer the stored
 * binding, fall back to the live config. Refresh tokens stay single-use:
 * every success rotates both materials and the caller persists the
 * replacement. Throws `TraktTokenRequestError` (`invalid_grant` = permanent).
 */
export async function refreshTraktToken(
  config: TraktOAuthClient,
  refreshToken: string,
  redirectUri: string | null,
): Promise<TraktTokenResponse> {
  return postTokenFormWithGrantCheck({
    refresh_token: refreshToken,
    client_id: config.clientId,
    redirect_uri: redirectUri ?? config.redirectUri,
    grant_type: "refresh_token",
  })
}

/**
 * Best-effort server-side revocation attempt for explicit disconnect. The
 * request shape (`token` + `client_id`, no secret — there is none to send)
 * is NOT documented in the current official PKCE/Authentication docs
 * (operational verification pending), so this is best-effort only.
 * Returns true only on a 2xx from the provider; every other outcome
 * (outage, 4xx/5xx, timeout, misconfiguration) is false — the caller ALWAYS
 * proceeds with the local disconnect regardless (the local fence+delete is
 * the source of truth, never the upstream answer). Never throws, never logs
 * bodies/tokens. A `false` here means the Trakt-side authorization may still
 * exist: users can remove it manually under Trakt Settings → Applications
 * (https://trakt.tv/settings/apps).
 */
export async function revokeTraktToken(
  config: TraktOAuthClient | null,
  accessToken: string | null,
  refreshToken: string | null,
): Promise<boolean> {
  const token = accessToken ?? refreshToken
  if (!config || !token) return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), traktTokenTimeoutMs())
  try {
    const res = await fetch(`${traktOAuthBase()}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, client_id: config.clientId }),
      signal: controller.signal,
    })
    if (!res.ok) {
      log.warn("trakt token revoke failed", { status: res.status })
      return false
    }
    return true
  } catch {
    log.warn("trakt token revoke error")
    return false
  } finally {
    clearTimeout(timer)
  }
}
