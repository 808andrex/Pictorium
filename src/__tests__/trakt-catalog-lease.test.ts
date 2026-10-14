import crypto from "node:crypto"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Real `getTraktCatalogLease` (trakt-auth.ts) against a scripted fencing
// store: only `@/lib/trakt-profile-lock` is mocked (generation sequences /
// outages). Token records are real files under an isolated temp DATA_DIR,
// so the snapshot protocol (generation-before, token, generation-after with
// one refresh-tolerant retry) is exercised for real — no network is ever
// touched (tokens are saved fresh; the expired-token case stops at the
// missing-deployment-config check before any exchange).
const genMock = vi.hoisted(() => ({
  impl: null as null | ((userId: string) => Promise<string | null>),
}))

vi.mock("@/lib/trakt-profile-lock", () => ({
  getTraktGeneration: vi.fn(async (userId: string) => {
    if (!genMock.impl) throw new Error("genMock.impl not set for this test")
    return genMock.impl(userId)
  }),
  acquireTraktRefreshLock: vi.fn(async () => {
    throw new Error("no refresh locks expected in lease tests")
  }),
  acquireTraktProfileLock: vi.fn(async () => {
    throw new Error("no profile locks expected in lease tests")
  }),
  bumpTraktGeneration: vi.fn(async () => {
    throw new Error("no generation bumps expected in lease tests")
  }),
  clearTraktGeneration: vi.fn(async () => {}),
  TraktGenerationUnavailableError: class TraktGenerationUnavailableError extends Error {
    constructor() {
      super("Trakt fencing generation is unavailable")
      this.name = "TraktGenerationUnavailableError"
    }
  },
}))

const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const ACCESS_A = "lease-test-access-token-alpha-0123456789"
const REFRESH_A = "lease-test-refresh-token-alpha-0123456789"

const ENV_KEYS = [
  "PICTORIUM_DATA_DIR",
  "PROFILE_ENCRYPTION_KEY",
  "PICTORIUM_TRAKT_CLIENT_ID",
  "POSTERIUM_TRAKT_CLIENT_ID",
  "TRAKT_CLIENT_ID",
  "PICTORIUM_TRAKT_CLIENT_SECRET",
  "POSTERIUM_TRAKT_CLIENT_SECRET",
  "PICTORIUM_TRAKT_REDIRECT_URI",
  "POSTERIUM_TRAKT_REDIRECT_URI",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
] as const
let savedEnv: Record<string, string | undefined> = {}
let tempDir: string | undefined

beforeEach(async () => {
  savedEnv = {}
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pictorium-lease-"))
  process.env.PICTORIUM_DATA_DIR = tempDir
  process.env.PROFILE_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex")
  delete process.env.PICTORIUM_TRAKT_CLIENT_ID
  delete process.env.POSTERIUM_TRAKT_CLIENT_ID
  delete process.env.TRAKT_CLIENT_ID
  delete process.env.PICTORIUM_TRAKT_CLIENT_SECRET
  delete process.env.POSTERIUM_TRAKT_CLIENT_SECRET
  delete process.env.PICTORIUM_TRAKT_REDIRECT_URI
  delete process.env.POSTERIUM_TRAKT_REDIRECT_URI
  delete process.env.KV_REST_API_URL
  delete process.env.KV_REST_API_TOKEN
  genMock.impl = null
})

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.resetModules()
  vi.restoreAllMocks()
  if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

async function loadTrakt() {
  vi.resetModules()
  return import("@/lib/trakt-auth")
}

async function saveFreshTokens(userId: string, accessToken = ACCESS_A) {
  const trakt = await loadTrakt()
  await trakt.saveTraktTokens(userId, {
    accessToken,
    refreshToken: REFRESH_A,
    expiresAt: Date.now() + 3600_000,
  })
}

describe("getTraktCatalogLease: coherent token+generation snapshot (task 4 correction cycle 1)", () => {
  it("returns a stable keyed lease for a connected profile with a readable fence", async () => {
    await saveFreshTokens(UUID_A)
    genMock.impl = async () => "gen-1"
    const trakt = await loadTrakt()
    const lease = await trakt.getTraktCatalogLease(UUID_A)
    expect(lease).toEqual({ ok: true, accessToken: ACCESS_A, generation: "gen-1", noCache: false })
  })

  it("keys legacy unfenced profiles on a stable null generation (no outage, no guess)", async () => {
    await saveFreshTokens(UUID_A)
    genMock.impl = async () => null
    const trakt = await loadTrakt()
    const lease = await trakt.getTraktCatalogLease(UUID_A)
    expect(lease).toEqual({ ok: true, accessToken: ACCESS_A, generation: null, noCache: false })
  })

  it("retries once after a fence bump mid-snapshot and binds the current fence (refresh-style race)", async () => {
    await saveFreshTokens(UUID_A)
    // g1 (before) vs g2 (after): the retry re-reads a stable g2 pair and
    // binds the token to the fence that is current — never g1-to-g2.
    const seq = ["gen-1", "gen-2", "gen-2", "gen-2"]
    genMock.impl = async () => seq.shift() ?? "gen-2"
    const trakt = await loadTrakt()
    const lease = await trakt.getTraktCatalogLease(UUID_A)
    expect(lease).toEqual({ ok: true, accessToken: ACCESS_A, generation: "gen-2", noCache: false })
  })

  it("fails closed as temporary on a persistently moving fence (never binds across generations)", async () => {
    await saveFreshTokens(UUID_A)
    let n = 0
    genMock.impl = async () => `gen-moving-${++n}`
    const trakt = await loadTrakt()
    const lease = await trakt.getTraktCatalogLease(UUID_A)
    expect(lease).toEqual({ ok: false, reason: "temporary" })
    expect("accessToken" in lease).toBe(false)
  })

  it("degrades to noCache serve (never persist) on generation outage with a verified token", async () => {
    await saveFreshTokens(UUID_A)
    genMock.impl = async () => {
      throw new Error("fencing store outage (injected)")
    }
    const trakt = await loadTrakt()
    const lease = await trakt.getTraktCatalogLease(UUID_A)
    expect(lease).toEqual({ ok: true, accessToken: ACCESS_A, generation: null, noCache: true })
  })

  it("maps a post-disconnect outage to connection_required (no token, never a noCache serve)", async () => {
    // No record at all (never linked / wiped): even with the fence down, an
    // unverifiable identity must not degrade to serving.
    genMock.impl = async () => {
      throw new Error("fencing store outage (injected)")
    }
    const trakt = await loadTrakt()
    const lease = await trakt.getTraktCatalogLease(UUID_B)
    expect(lease).toEqual({ ok: false, reason: "connection_required" })
    expect("accessToken" in lease).toBe(false)
  })

  it("maps disconnected profiles to connection_required without touching token material", async () => {
    genMock.impl = async () => "gen-1"
    const trakt = await loadTrakt()
    const lease = await trakt.getTraktCatalogLease(UUID_B)
    expect(lease).toEqual({ ok: false, reason: "connection_required" })
    expect("accessToken" in lease).toBe(false)
  })

  it("maps unreadable token stores (encryption unavailable) to temporary, never to cached identity", async () => {
    await saveFreshTokens(UUID_A)
    delete process.env.PROFILE_ENCRYPTION_KEY
    genMock.impl = async () => "gen-1"
    const trakt = await loadTrakt()
    // Same fence as the connected state, but the connection is no longer
    // provable: temporary, so outer layers must bypass their caches.
    expect(await trakt.getTraktCatalogLease(UUID_A)).toEqual({ ok: false, reason: "temporary" })
  })

  it("maps expired tokens without deployment OAuth config to key_missing (no network, no serve)", async () => {
    const trakt = await loadTrakt()
    await trakt.saveTraktTokens(UUID_B, {
      accessToken: ACCESS_A,
      refreshToken: REFRESH_A,
      expiresAt: Date.now() - 1000,
    })
    genMock.impl = async () => "gen-1"
    const reloaded = await loadTrakt()
    const lease = await reloaded.getTraktCatalogLease(UUID_B)
    expect(lease).toEqual({ ok: false, reason: "key_missing" })
    expect("accessToken" in lease).toBe(false)
  })

  it("rejects invalid UUIDs fail-closed before any storage access", async () => {
    genMock.impl = async () => "gen-1"
    const trakt = await loadTrakt()
    await expect(trakt.getTraktCatalogLease("not-a-uuid")).rejects.toThrow()
  })
})
