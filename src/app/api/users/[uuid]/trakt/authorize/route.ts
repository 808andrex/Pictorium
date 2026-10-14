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
import { getTraktOAuthConfig, TraktConfigError } from "@/lib/trakt-auth"
import { isProfileEncryptionAvailable } from "@/lib/profile-crypto"
import { getTraktGeneration, TraktGenerationUnavailableError } from "@/lib/trakt-profile-lock"
import {
  buildTraktOAuthCookie,
  createTraktOAuthState,
  TRAKT_OAUTH_STATE_TTL_MS,
} from "@/lib/trakt-oauth-state"

type RouteParams = { uuid: string }

/**
 * Start a Trakt connect flow (multi-user, task 2/plan).
 *
 * POST only (a GET must never create side effects → 405 by convention: only
 * POST is exported). Authenticated owner + same-origin + rate-limit, like the
 * keys routes. Fail-closed BEFORE the user is sent to Trakt: OAuth
 * unconfigured (503) or token encryption unavailable (503) never mint state.
 *
 * Returns `{ authorizeUrl, expiresIn }` (secret-free: client ID + redirect +
 * opaque state are all public to the initiating browser) and binds the
 * browser via an HttpOnly cookie. API credentials never appear in the URL.
 */

// PKCE authorize host is ALWAYS auth.trakt.tv — never derived from the
// request (Host/XFH poisoning cannot steer the grant) and never from env.
// (Previous integrations used trakt.tv; the current PKCE docs moved the
// authorization endpoint to auth.trakt.tv.)
const TRAKT_AUTHORIZE_URL = "https://auth.trakt.tv/oauth/authorize"

function buildTraktAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  })
  return `${TRAKT_AUTHORIZE_URL}?${params.toString()}`
}

function noStore(res: Response): Response {
  const headers = new Headers(res.headers)
  headers.set("Cache-Control", "no-store")
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

export async function POST(req: NextRequest, { params }: { params: Promise<RouteParams> }) {
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
  let config
  try {
    config = getTraktOAuthConfig()
  } catch (e) {
    if (e instanceof TraktConfigError) {
      return noStore(Response.json({ error: "Trakt OAuth is not configured" }, { status: 503 }))
    }
    throw e
  }
  // The callback must encrypt tokens at rest: refuse to start when it can't.
  if (!isProfileEncryptionAvailable()) {
    return noStore(Response.json({ error: "Trakt token encryption is unavailable" }, { status: 503 }))
  }
  // Bind the fencing generation AT INITIATION: the callback carries this
  // snapshot and links only when it still matches. A storage outage here
  // fails closed (503) — starting an unbound flow would let a disconnect
  // that lands before the callback relink the profile.
  let traktGen: string | null
  try {
    traktGen = await getTraktGeneration(userId)
  } catch (e) {
    if (e instanceof TraktGenerationUnavailableError) {
      return noStore(Response.json({ error: "Could not start Trakt authorization" }, { status: 503 }))
    }
    throw e
  }
  let created
  try {
    created = await createTraktOAuthState(userId, config.redirectUri, { traktGen })
  } catch {
    return noStore(Response.json({ error: "Could not start Trakt authorization" }, { status: 503 }))
  }
  const authorizeUrl = buildTraktAuthorizeUrl(config.clientId, config.redirectUri, created.state, created.codeChallenge)
  return new Response(
    JSON.stringify({ authorizeUrl, expiresIn: Math.floor(TRAKT_OAUTH_STATE_TTL_MS / 1000) }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Set-Cookie": buildTraktOAuthCookie(created.nonce),
      },
    },
  )
}
