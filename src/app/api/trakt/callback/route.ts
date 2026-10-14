import { NextRequest } from "next/server"
import { rateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit"
import { userExists } from "@/lib/user-auth"
import {
  getTraktOAuthConfig,
  saveTraktTokensGuarded,
  TraktConfigError,
  TraktSaveAbortedError,
  type TraktOAuthConfig,
} from "@/lib/trakt-auth"
import { exchangeTraktCode } from "@/lib/trakt-token-exchange"
import { getTraktGeneration } from "@/lib/trakt-profile-lock"
import {
  buildClearTraktOAuthCookie,
  consumeTraktOAuthState,
  TRAKT_OAUTH_COOKIE_NAME,
} from "@/lib/trakt-oauth-state"
import { createLogger } from "@/lib/logger"

const log = createLogger("trakt-callback")

/**
 * Canonical Trakt OAuth callback (multi-user, task 2/plan).
 *
 * Necessarily unauthenticated in `x-user-header` terms (Trakt redirects the
 * browser here without our profile headers): the request is bound to the
 * initiation via the opaque one-time server state + the HttpOnly browser
 * cookie. Missing/wrong cookie, tampered/replayed/expired/missing state and
 * user mixing all fail closed to a fixed relative result page.
 *
 * Terminal outcomes are 302 redirects to FIXED profile-safe relative URLs
 * (never request-derived: no open redirects, immune to
 * Host/X-Forwarded-Host poisoning) with a secret-free result indicator, the
 * binding cookie cleared and `Cache-Control: no-store`. After a VALID state
 * the browser returns to the initiating profile's configure page
 * (`/u/<uuid>/configure?trakt=<result>` — the UUID comes ONLY from the
 * consumed server state, validated at initiation, never from a `next`/`return`
 * query param); without a valid state the target is the generic home
 * (`/?trakt=failed`). The `code`/tokens/verifier never appear in the result,
 * the URL or the logs.
 *
 * The code is exchanged secretless with the initiation-bound PKCE verifier
 * (decrypted in server memory only at consume time, single-use with the
 * state). A missing/tampered verifier fails closed: no exchange, no save.
 *
 * Task 3 coordination: the callback carries the fencing snapshot bound AT
 * FLOW INITIATION (stored in the OAuth state, not re-read here): when the
 * live generation no longer matches, a disconnect/wipe/reconnect landed
 * after the user started authorizing and the link aborts. The tokens are
 * persisted with `saveTraktTokensGuarded`, which re-checks generation +
 * user existence atomically at the storage boundary (KV CAS / file mutation
 * lock, never recreating a wiped namespace). A wipe or an explicit
 * disconnect that lands mid-exchange aborts the save — a pending flow can
 * never resurrect a deleted/disconnected profile.
 */

// Fixed relative result targets: profile-safe configure page after a valid
// state (UUID from the consumed server record only), generic home otherwise.
const RESULT_FAILED_HOME = "/?trakt=failed"

function resultFor(userId: string | null, outcome: "connected" | "denied" | "failed"): string {
  if (userId && /^[0-9a-f-]{36}$/i.test(userId)) {
    return `/u/${userId}/configure?trakt=${outcome}`
  }
  return `/?trakt=${outcome}`
}

const MAX_CODE_LENGTH = 4096

function checkCode(value: unknown): string | null {
  if (typeof value !== "string") return null
  const v = value.trim()
  if (!v || v.length > MAX_CODE_LENGTH || /\s/.test(v)) return null
  return v
}

function redirectResult(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "Set-Cookie": buildClearTraktOAuthCookie(),
    },
  })
}

/**
 * Rate-limited terminal response: same no-store + binding-cookie-clear
 * contract as every other terminal outcome (fail-closed, no state touched).
 */
function rateLimitedResult(retAfter: number): Response {
  const inner = rateLimitResponse(retAfter)
  const headers = new Headers(inner.headers)
  headers.set("Cache-Control", "no-store")
  headers.set("Set-Cookie", buildClearTraktOAuthCookie())
  return new Response(inner.body, { status: inner.status, headers })
}

export async function GET(req: NextRequest) {
  const rl = await rateLimit(rateLimitKey(req), "defaults")
  if (!rl.ok) return rateLimitedResult(rl.retAfter)
  let params: URLSearchParams
  try {
    params = new URL(req.url).searchParams
  } catch {
    return redirectResult(RESULT_FAILED_HOME)
  }
  const state = params.get("state")
  const code = params.get("code")
  const denied = params.get("error")
  // The state burns on consume whatever happens next (replay-safe): every
  // outcome below, including Trakt-denied, is single-use.
  const nonce = req.cookies.get(TRAKT_OAUTH_COOKIE_NAME)?.value ?? null
  const consumed = await consumeTraktOAuthState(state, nonce)
  if (!consumed.ok) return redirectResult(RESULT_FAILED_HOME)
  const { record, verifier } = consumed
  // From here on the initiating profile is proven (server state, not request
  // params): every terminal outcome returns to its configure page.
  const failed = resultFor(record.userId, "failed")
  // The stored redirect must EXACTLY match the currently configured one
  // (env-only, never request-derived): a rotated/misconfigured deployment
  // cannot complete flows started under a different registration.
  let config: TraktOAuthConfig
  try {
    config = getTraktOAuthConfig()
  } catch (e) {
    if (e instanceof TraktConfigError) return redirectResult(failed)
    throw e
  }
  if (record.redirectUri !== config.redirectUri) return redirectResult(failed)
  // User-denied (or provider-side error) and missing code: no exchange, no
  // storage touched. `denied` keeps its own indicator for the result page.
  if (denied) return redirectResult(resultFor(record.userId, "denied"))
  const cleanCode = checkCode(code)
  if (!cleanCode) return redirectResult(failed)
  // The profile must still exist: a wiped account must not be resurrected by
  // a pending flow (the guarded save below never recreates the namespace).
  if (!(await userExists(record.userId))) return redirectResult(failed)
  // Initiator snapshot check BEFORE the network round-trip: the state
  // carries the fencing generation bound at initiation. A disconnect, wipe
  // or newer write since then moved the live generation → abort without
  // exchanging (a pending authorization started, then disconnected before
  // the callback, must never relink). A generation outage also fails
  // closed: linking against an unknown fence is not allowed.
  let liveGeneration: string | null
  try {
    liveGeneration = await getTraktGeneration(record.userId)
  } catch {
    return redirectResult(failed)
  }
  const expectedGeneration = record.traktGen ?? null
  if (liveGeneration !== expectedGeneration) return redirectResult(failed)
  let tokens: { accessToken: string; refreshToken: string; expiresAt: number; scope: string | null; tokenType: string | null }
  try {
    // Secretless PKCE exchange: the initiation-bound verifier proves this
    // callback is the flow that started the grant. A wrong verifier fails
    // closed (no save, profile-safe failure page).
    tokens = await exchangeTraktCode(config, cleanCode, verifier)
  } catch {
    return redirectResult(failed)
  }
  try {
    await saveTraktTokensGuarded(
      record.userId,
      {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope ?? undefined,
        tokenType: tokens.tokenType ?? undefined,
        redirectUri: config.redirectUri,
      },
      expectedGeneration,
    )
  } catch (e) {
    // Fenced (stale generation / wiped profile): fail closed without
    // resurrecting. Storage/encryption failure: generic failure, nothing
    // half-persisted is exposed (writes are atomic or not at all).
    if (e instanceof TraktSaveAbortedError) {
      log.info("Trakt account link aborted (profile wiped or disconnected mid-flow)")
    }
    return redirectResult(failed)
  }
  log.info("Trakt account linked")
  return redirectResult(resultFor(record.userId, "connected"))
}
