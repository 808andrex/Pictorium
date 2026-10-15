import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { APP_VERSION } from "@/generated/app-version"

// RED-before/GREEN-after: the Trakt `/oauth/token` + `/oauth/revoke`
// POSTs must carry the official required headers (Content-Type +
// User-Agent app/version + trakt-api-version + trakt-api-key), otherwise
// the edge (Cloudflare) answers 403 HTML before Trakt ever sees the grant.
// Body contract (PKCE secretless, grant/verifier, no secret, no Bearer)
// and the TRAKT_API_URL test override must stay unchanged.

const CALLER_CLIENT_ID = "caller-config-client-id-xyz"
const ENV_DECOY_CLIENT_ID = "env-decoy-client-id-must-not-leak"
const REDIRECT = "https://pictorium.duckdns.org/api/trakt/callback"
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk" // 43 unreserved chars
const CODE = "auth-code-value-0123456789abcdef"
const OLD_REFRESH = "lifecycle-old-refresh-0123456789abcdef"

function tokenReply() {
  return {
    access_token: "test-oauth-access-0123456789abcdef",
    token_type: "Bearer",
    expires_in: 7776000,
    refresh_token: "test-oauth-refresh-0123456789abcdef",
    scope: "public",
    created_at: 1750000000,
  }
}

interface SeenCall {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function stubFetch(reply: () => Response) {
  const seen: SeenCall[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const raw = ((init?.headers ?? {}) as Record<string, string>) ?? {}
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v)
    seen.push({
      url: String(input),
      headers,
      body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {},
    })
    return reply()
  })
  return seen
}

function expectRequiredHeaders(headers: Record<string, string>) {
  expect(headers["content-type"]).toBe("application/json")
  expect(headers["user-agent"]).toBe(`Pictorium/${APP_VERSION}`)
  expect(headers["trakt-api-version"]).toBe("2")
  // The caller config client ID — never the env decoy, never a secret.
  expect(headers["trakt-api-key"]).toBe(CALLER_CLIENT_ID)
  expect(headers["authorization"]).toBeUndefined()
}

beforeEach(() => {
  vi.resetModules()
  process.env.PICTORIUM_TRAKT_CLIENT_ID = ENV_DECOY_CLIENT_ID
})

afterEach(() => {
  delete process.env.PICTORIUM_TRAKT_CLIENT_ID
  delete process.env.TRAKT_API_URL
  vi.restoreAllMocks()
  vi.resetModules()
})

describe("trakt oauth required headers", () => {
  it("exchangeTraktCode sends required headers + unchanged secretless body", async () => {
    const { exchangeTraktCode } = await import("@/lib/trakt-token-exchange")
    const seen = stubFetch(
      () => new Response(JSON.stringify(tokenReply()), { status: 200, headers: { "Content-Type": "application/json" } }),
    )
    const res = await exchangeTraktCode({ clientId: CALLER_CLIENT_ID, redirectUri: REDIRECT }, CODE, VERIFIER)
    expect(res.accessToken).toBe("test-oauth-access-0123456789abcdef")
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe("https://api.trakt.tv/oauth/token")
    expectRequiredHeaders(seen[0].headers)
    expect(seen[0].body).toMatchObject({
      code: CODE,
      client_id: CALLER_CLIENT_ID,
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
      code_verifier: VERIFIER,
    })
    expect(seen[0].body).not.toHaveProperty("client_secret")
    expect(JSON.stringify(seen[0].body)).not.toContain(ENV_DECOY_CLIENT_ID)
  })

  it("refreshTraktToken sends required headers + unchanged secretless body", async () => {
    const { refreshTraktToken } = await import("@/lib/trakt-token-exchange")
    const seen = stubFetch(
      () => new Response(JSON.stringify(tokenReply()), { status: 200, headers: { "Content-Type": "application/json" } }),
    )
    const res = await refreshTraktToken({ clientId: CALLER_CLIENT_ID, redirectUri: REDIRECT }, OLD_REFRESH, null)
    expect(res.accessToken).toBe("test-oauth-access-0123456789abcdef")
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe("https://api.trakt.tv/oauth/token")
    expectRequiredHeaders(seen[0].headers)
    expect(seen[0].body).toMatchObject({
      refresh_token: OLD_REFRESH,
      client_id: CALLER_CLIENT_ID,
      redirect_uri: REDIRECT,
      grant_type: "refresh_token",
    })
    expect(seen[0].body).not.toHaveProperty("client_secret")
    expect(seen[0].body).not.toHaveProperty("code_verifier")
    expect(JSON.stringify(seen[0].body)).not.toContain(ENV_DECOY_CLIENT_ID)
  })

  it("revokeTraktToken sends required headers + unchanged secretless body", async () => {
    const { revokeTraktToken } = await import("@/lib/trakt-token-exchange")
    const seen = stubFetch(() => new Response("{}", { status: 200 }))
    const ok = await revokeTraktToken(
      { clientId: CALLER_CLIENT_ID, redirectUri: REDIRECT },
      "access-token-value-0123456789abcdef",
      OLD_REFRESH,
    )
    expect(ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe("https://api.trakt.tv/oauth/revoke")
    expectRequiredHeaders(seen[0].headers)
    expect(seen[0].body).toMatchObject({ client_id: CALLER_CLIENT_ID })
    expect(seen[0].body).not.toHaveProperty("client_secret")
    expect(JSON.stringify(seen[0].body)).not.toContain(ENV_DECOY_CLIENT_ID)
  })

  it("TRAKT_API_URL base override still honored with required headers", async () => {
    process.env.TRAKT_API_URL = "http://127.0.0.1:9/"
    const { refreshTraktToken } = await import("@/lib/trakt-token-exchange")
    const seen = stubFetch(
      () => new Response(JSON.stringify(tokenReply()), { status: 200, headers: { "Content-Type": "application/json" } }),
    )
    await refreshTraktToken({ clientId: CALLER_CLIENT_ID, redirectUri: REDIRECT }, OLD_REFRESH, null)
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe("http://127.0.0.1:9/oauth/token")
    expectRequiredHeaders(seen[0].headers)
  })
})
