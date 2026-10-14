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
import { getTraktOAuthStatus, getTraktTokens } from "@/lib/trakt-auth"

type RouteParams = { uuid: string }

/**
 * Secret-free Trakt connection status for the owning profile (task 2/plan).
 *
 * GET → `{ configured, status }` where `status` is `connected` (decryptable
 * record) | `disconnected` (never linked or explicitly cleared) |
 * `unavailable` (present-but-unreadable: transient/operational, NEVER treated
 * as a disconnect). No tokens, no secrets, no redirect URI echo beyond what
 * `getTraktOAuthPublicInfo` already exposes — this endpoint stays minimal.
 * Authenticated owner only (same access rule as the keys GET); no-store.
 */

function noStore(res: Response): Response {
  const headers = new Headers(res.headers)
  headers.set("Cache-Control", "no-store")
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

export async function GET(req: NextRequest, { params }: { params: Promise<RouteParams> }) {
  const { uuid } = await params
  const userId = sanitizeUserId(uuid)
  const rl = await rateLimit(userId ? userRateLimitKey(req, userId) : rateLimitKey(req), "defaults")
  if (!rl.ok) return noStore(rateLimitResponse(rl.retAfter))
  if (!isMultiUserEnabled()) {
    return noStore(Response.json({ error: "Multi-user is disabled" }, { status: 404 }))
  }
  if (!userId) return noStore(invalidUserResponse())
  if (!(await checkUserAuth(req, userId))) return noStore(userAuthResponse())
  const { configured } = getTraktOAuthStatus()
  const read = await getTraktTokens(userId)
  return noStore(Response.json({ configured, status: read.status }))
}
