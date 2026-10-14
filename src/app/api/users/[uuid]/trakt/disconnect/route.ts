import { NextRequest } from "next/server"
import { rateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit"
import {
  checkUserAuth,
  invalidUserResponse,
  isMultiUserEnabled,
  sanitizeUserId,
  userAuthResponse,
  userRateLimitKey,
} from "@/lib/user-auth"
import { isSameOrigin, originMismatchResponse } from "@/lib/auth"
import {
  disconnectTraktProfile,
  getTraktOAuthConfig,
  getTraktTokens,
  TraktConfigError,
} from "@/lib/trakt-auth"
import { revokeTraktToken } from "@/lib/trakt-token-exchange"
import { createLogger } from "@/lib/logger"

const log = createLogger("trakt-disconnect")

type RouteParams = { uuid: string }

/**
 * Explicit Trakt disconnect (multi-user, task 3/plan).
 *
 * DELETE → attempts a best-effort server-side token revocation
 * (`POST /oauth/revoke`, secret-free shape, never logged — the revoke
 * request shape itself is NOT documented in the current official Trakt docs,
 * so operational verification is pending and `revoked` only reports whether
 * the upstream call returned 2xx) and then ALWAYS performs the
 * local disconnect (generation fence bump + record delete), even when the
 * provider is unreachable, slow, or rejects the revocation, and even when
 * the deployment OAuth config is broken (a misconfigured instance must not
 * trap users in a connected state). Response is `{ ok: true, revoked }`
 * (secret-free) with `Cache-Control: no-store`. An in-flight refresh or
 * callback save that captured the pre-disconnect generation aborts at the
 * storage boundary — disconnect wins over pending writes.
 *
 * Fail-closed on LOCAL STORAGE trouble: when the durable fence+delete
 * cannot be established (KV EVAL outage, lock contention, IO), the route
 * answers 503 and reports no success — claiming `{ ok: true }` over an
 * intact record would let a stale in-flight write resurrect the connection
 * against an unchanged generation. Upstream revocation failure stays
 * best-effort (local disconnect still proceeds): a success response only
 * guarantees the LOCAL tokens are gone, never that the Trakt-side
 * authorization was removed — users who need that guarantee should also
 * remove the app under Trakt Settings → Applications
 * (https://trakt.tv/settings/apps).
 *
 * Authenticated owner + same-origin + rate-limit, like the other Trakt
 * mutations. Never throws tokens or secrets into responses or logs.
 */

function noStore(res: Response): Response {
  const headers = new Headers(res.headers)
  headers.set("Cache-Control", "no-store")
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<RouteParams> }) {
  const { uuid } = await params
  const userId = sanitizeUserId(uuid)
  const rl = await rateLimit(userId ? userRateLimitKey(req, userId) : rateLimitKey(req), "defaults")
  if (!rl.ok) return noStore(rateLimitResponse(rl.retAfter))
  if (!isMultiUserEnabled()) {
    return noStore(Response.json({ error: "Multi-user is disabled" }, { status: 404 }))
  }
  if (!userId) return noStore(invalidUserResponse())
  if (!(await checkUserAuth(req, userId))) return noStore(userAuthResponse())
  if (!isSameOrigin(req)) return noStore(originMismatchResponse())

  // Tokens for the server-side revocation call only: decrypted in server
  // memory, never echoed. Any read trouble → skip revocation, still
  // disconnect locally (fail-open locally, fail-closed remotely).
  const read = await getTraktTokens(userId)
  let config = null
  try {
    config = getTraktOAuthConfig()
  } catch (e) {
    if (!(e instanceof TraktConfigError)) throw e
    config = null
  }
  const revoked =
    read.status === "connected"
      ? await revokeTraktToken(config, read.tokens.accessToken, read.tokens.refreshToken)
      : false

  try {
    await disconnectTraktProfile(userId)
  } catch (e) {
    // Local storage could not durably fence+delete: fail closed (never a
    // success claim over a possibly-intact record). Upstream revoke trouble
    // never lands here (revokeTraktToken is best-effort by contract).
    log.warn("Trakt local disconnect failed", { error: e instanceof Error ? e.message : String(e) })
    return noStore(Response.json({ error: "Could not disconnect Trakt" }, { status: 503 }))
  }
  // Never tokens, never secrets, never the config: only the outcome.
  log.info("Trakt account disconnected", { revoked })
  return noStore(Response.json({ ok: true, revoked }))
}
