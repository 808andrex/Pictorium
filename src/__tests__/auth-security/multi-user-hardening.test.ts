import crypto from "node:crypto"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const UUID_GHOST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

const ENV_KEYS = [
  "PICTORIUM_DATA_DIR",
  "PICTORIUM_MULTI_USER",
  "PICTORIUM_MAX_USERS",
  "PICTORIUM_MULTI_USER_ALLOW_ENV_FALLBACK",
  "PICTORIUM_TMDB_KEY",
  "PROFILE_ENCRYPTION_KEY",
] as const
let savedEnv: Record<string, string | undefined> = {}
let tempDir: string | undefined

beforeEach(async () => {
  savedEnv = {}
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pictorium-hardening-"))
  process.env.PICTORIUM_DATA_DIR = tempDir
  process.env.PICTORIUM_MULTI_USER = "1"
  process.env.PROFILE_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex")
  delete process.env.PICTORIUM_MAX_USERS
  delete process.env.PICTORIUM_MULTI_USER_ALLOW_ENV_FALLBACK
  delete process.env.PICTORIUM_TMDB_KEY
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

function nextReq(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): NextRequest {
  return new NextRequest(url, init)
}

describe("exists: oracolo morto", () => {
  it("401 sia per UUID esistente che inesistente (indistinguibili), 200 con auth", async () => {
    vi.resetModules()
    const auth = await import("@/lib/user-auth")
    const route = await import("@/app/api/users/[uuid]/exists/route")
    const created = await auth.createUser()

    const anonExisting = await route.GET(
      nextReq(`http://x/api/users/${created.uuid}/exists`),
      { params: Promise.resolve({ uuid: created.uuid }) },
    )
    const anonGhost = await route.GET(
      nextReq(`http://x/api/users/${UUID_GHOST}/exists`),
      { params: Promise.resolve({ uuid: UUID_GHOST }) },
    )
    // Stesso status, stesso body shape: nessun segnale di esistenza.
    expect(anonExisting.status).toBe(401)
    expect(anonGhost.status).toBe(401)
    expect(await anonExisting.json()).toEqual(await anonGhost.json())

    // Token errato su esistente → sempre 401.
    const wrong = await route.GET(
      nextReq(`http://x/api/users/${created.uuid}/exists`, { headers: { "x-user-token": "nope" } }),
      { params: Promise.resolve({ uuid: created.uuid }) },
    )
    expect(wrong.status).toBe(401)

    // Proprietario autenticato → 200 {exists:true}.
    const ok = await route.GET(
      nextReq(`http://x/api/users/${created.uuid}/exists`, { headers: { "x-user-token": created.secret } }),
      { params: Promise.resolve({ uuid: created.uuid }) },
    )
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ exists: true })

    // UUID invalido → 400 (mai lookup).
    const bad = await route.GET(
      nextReq("http://x/api/users/nope/exists"),
      { params: Promise.resolve({ uuid: "../../etc" }) },
    )
    expect(bad.status).toBe(400)
  })
})

describe("rotate secret: revoca leak", () => {
  it("401 senza auth; nuovo secret ok, vecchio rifiutato subito", async () => {
    vi.resetModules()
    const auth = await import("@/lib/user-auth")
    const route = await import("@/app/api/users/[uuid]/rotate/route")
    const created = await auth.createUser("password-123")

    const anon = await route.POST(
      nextReq(`http://x/api/users/${created.uuid}/rotate`, { method: "POST" }),
      { params: Promise.resolve({ uuid: created.uuid }) },
    )
    expect(anon.status).toBe(401)

    const rotated = await route.POST(
      nextReq(`http://x/api/users/${created.uuid}/rotate`, {
        method: "POST",
        headers: { "x-user-token": created.secret },
      }),
      { params: Promise.resolve({ uuid: created.uuid }) },
    )
    expect(rotated.status).toBe(200)
    const { secret: fresh } = (await rotated.json()) as { secret: string }
    expect(typeof fresh).toBe("string")
    expect(fresh).not.toBe(created.secret)

    // Vecchio secret morto, nuovo vivo, password invariata.
    expect(await auth.verifyUserToken(created.uuid, created.secret)).toBe(false)
    expect(await auth.verifyUserToken(created.uuid, fresh)).toBe(true)
    expect(await auth.verifyUserPassword(created.uuid, "password-123")).toBe(true)
  })

  it("rotate via password (senza secret) funziona", async () => {
    vi.resetModules()
    const auth = await import("@/lib/user-auth")
    const route = await import("@/app/api/users/[uuid]/rotate/route")
    const created = await auth.createUser("password-123")
    const res = await route.POST(
      nextReq(`http://x/api/users/${created.uuid}/rotate`, {
        method: "POST",
        headers: { "x-user-password": "password-123" },
      }),
      { params: Promise.resolve({ uuid: created.uuid }) },
    )
    expect(res.status).toBe(200)
  })
})

describe("env fallback: mai open-proxy sugli scoped", () => {
  it("scoped + flag ON + env → none; opt-in → env; globale → env", async () => {
    process.env.PICTORIUM_TMDB_KEY = "env-key"
    vi.resetModules()
    const tmdb = await import("@/lib/tmdb")

    // Scoped senza opt-in: l'env NON passa (chiude l'open-proxy).
    let r = await tmdb.resolveUserApiKey(nextReq(`http://x/?u=${UUID_A}`), UUID_A, "tmdb")
    expect(r).toEqual({ key: undefined, source: "none" })

    // Chiave esplicita vince comunque.
    r = await tmdb.resolveUserApiKey(
      nextReq(`http://x/?u=${UUID_A}`, { headers: { "x-api-key": "hdr" } }), UUID_A, "tmdb",
    )
    expect(r).toEqual({ key: "hdr", source: "header" })

    // Opt-in operatore: env anche sugli scoped.
    process.env.PICTORIUM_MULTI_USER_ALLOW_ENV_FALLBACK = "1"
    vi.resetModules()
    const tmdb2 = await import("@/lib/tmdb")
    r = await tmdb2.resolveUserApiKey(nextReq(`http://x/?u=${UUID_A}`), UUID_A, "tmdb")
    expect(r).toEqual({ key: "env-key", source: "env" })
    delete process.env.PICTORIUM_MULTI_USER_ALLOW_ENV_FALLBACK

    // Globale (senza uuid): fallback storico invariato.
    vi.resetModules()
    const tmdb3 = await import("@/lib/tmdb")
    r = await tmdb3.resolveUserApiKey(nextReq("http://x/"), null, "tmdb")
    expect(r).toEqual({ key: "env-key", source: "env" })
  })
})

describe("resolvePathUser: path vince, mismatch → 400", () => {
  it("matrice A/A, A/B, A/garbage, path invalido", async () => {
    vi.resetModules()
    const { resolvePathUser } = await import("@/lib/user-auth")
    expect(resolvePathUser(UUID_A, null)).toEqual({ user: UUID_A.toLowerCase(), mismatch: false })
    expect(resolvePathUser(UUID_A, UUID_A.toUpperCase())).toEqual({ user: UUID_A.toLowerCase(), mismatch: false })
    expect(resolvePathUser(UUID_A, UUID_B).mismatch).toBe(true)
    expect(resolvePathUser(UUID_A, "garbage").mismatch).toBe(true)
    expect(resolvePathUser("not-a-uuid", UUID_A).mismatch).toBe(true)
  })

  it("route /u/: inconsistent query → 400 senza toccare namespace", async () => {
    vi.resetModules()
    const catalog = await import("@/app/u/[user]/catalog/[type]/[id]/route")
    const res = await catalog.GET(
      nextReq(`http://x/u/${UUID_A}/catalog/movie/pictorium-trending.json?u=${UUID_B}`),
      { params: Promise.resolve({ user: UUID_A, type: "movie", id: "pictorium-trending.json" }) },
    )
    expect(res.status).toBe(400)
    const meta = await import("@/app/u/[user]/meta/[type]/[id]/route")
    const res2 = await meta.GET(
      nextReq(`http://x/u/${UUID_A}/meta/movie/tmdb:1.json?user=${UUID_B}`),
      { params: Promise.resolve({ user: UUID_A, type: "movie", id: "tmdb:1.json" }) },
    )
    expect(res2.status).toBe(400)
  })
})

describe("keys health: status onesto", () => {
  it("presente ma indecifrabile dopo rotazione env → decryptable:false", async () => {
    vi.resetModules()
    const auth = await import("@/lib/user-auth")
    const keys = await import("@/lib/user-keys")
    const created = await auth.createUser()
    await keys.setUserKeys(created.uuid, { tmdb: "ns-key-123" })

    let health = await keys.getUserKeysHealth(created.uuid)
    expect(health.present.tmdb).toBe(true)
    expect(health.decryptable.tmdb).toBe(true)
    expect(health.encryptionAvailable).toBe(true)

    // Env ruotata: il bundle resta ma non decifra più.
    process.env.PROFILE_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex")
    vi.resetModules()
    const keys2 = await import("@/lib/user-keys")
    health = await keys2.getUserKeysHealth(created.uuid)
    expect(health.present.tmdb).toBe(true)
    expect(health.decryptable.tmdb).toBe(false)
    // getUserKeys degrada a missing senza throw (contratto esistente).
    expect(await keys2.getUserKeys(created.uuid)).toEqual({})
  })
})

describe("MAX_USERS cap anti-Sybil", () => {
  it("oltre il cap → 429", async () => {
    process.env.PICTORIUM_MAX_USERS = "1"
    vi.resetModules()
    const route = await import("@/app/api/users/route")
    const body = (pw: string) => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    })
    const first = await route.POST(nextReq("http://x/api/users", body("password-1")))
    expect(first.status).toBe(200)
    const second = await route.POST(nextReq("http://x/api/users", body("password-2")))
    expect(second.status).toBe(429)
  })
})

describe("manifest: namespace + config composti", () => {
  it("config senza regione eredita la regione del namespace", async () => {
    vi.resetModules()
    const auth = await import("@/lib/user-auth")
    const defaults = await import("@/lib/server-defaults")
    const { encodeConfig } = await import("@/lib/config-token")
    const { buildManifestResponse } = await import("@/lib/build-manifest")
    const created = await auth.createUser()
    await defaults.setServerDefaultsForUser(created.uuid, {
      ...defaults.getServerDefaults(),
      region: "US",
    })
    // Token senza regione: la regione manifest deve venire dal namespace (US),
    // non dal default globale (IT).
    const token = encodeConfig({
      globalBadges: true,
      rankingBadges: false,
      badgeStyle: "pill",
      rankingBadgeStyle: "pill",
      blurEnabled: false,
      blurIntensity: 3,
      blurFade: 50,
      blurDarkness: 30,
      gradientHeight: 20,
      networkLogo: false,
      autoRotateClean: true,
      logoFitEnabled: false,
    })
    const res = await buildManifestResponse(
      nextReq(`http://x/u/${created.uuid}/manifest.json?config=${token}`),
      created.uuid,
      token,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { catalogs: Array<{ name: string }> }
    const names = body.catalogs.map((c) => c.name).join(" ")
    expect(names).toContain("USA")
  })
})

describe("fail limiter password (anti grinding via bucket larghi)", () => {
  const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null })

  it("5 fallimenti → blocco anche della corretta; reset riapre", async () => {
    vi.resetModules()
    const auth = await import("@/lib/user-auth")
    const created = await auth.createUser("grind-pass-1")
    const bad = { headers: headers({ "x-user-password": "wrong-wrong" }) }
    for (let i = 0; i < 5; i++) {
      expect(await auth.checkUserAuth(bad, created.uuid)).toBe(false)
    }
    // Soglia raggiunta: anche la corretta è rifiutata senza scrypt.
    expect(await auth.checkUserAuth({ headers: headers({ "x-user-password": "grind-pass-1" }) }, created.uuid)).toBe(false)
    auth.__resetPwFailsForTests()
    expect(await auth.checkUserAuth({ headers: headers({ "x-user-password": "grind-pass-1" }) }, created.uuid)).toBe(true)
  })

  it("i successi non contano: autosave legittimo non 429a mai", async () => {
    vi.resetModules()
    const auth = await import("@/lib/user-auth")
    const created = await auth.createUser("steady-pass-1")
    const good = { headers: headers({ "x-user-password": "steady-pass-1" }) }
    // 20 auth corrette di fila (autosave): mai bloccate.
    for (let i = 0; i < 20; i++) {
      expect(await auth.checkUserAuth(good, created.uuid)).toBe(true)
    }
  })

  it("fantasma senza password: false (scrypt dummy anti-oracolo)", async () => {
    vi.resetModules()
    const auth = await import("@/lib/user-auth")
    expect(await auth.verifyUserPassword(UUID_GHOST, "whatever-12")).toBe(false)
  })
})

describe("defaults GET rate-limit + auth", () => {
  it("401 senza auth su scoped, 400 uuid invalido", async () => {
    vi.resetModules()
    const auth = await import("@/lib/user-auth")
    const route = await import("@/app/api/defaults/route")
    const created = await auth.createUser()
    const anon = await route.GET(nextReq(`http://x/api/defaults?u=${created.uuid}`))
    expect(anon.status).toBe(401)
    const bad = await route.GET(nextReq("http://x/api/defaults?u=not-a-uuid"))
    expect(bad.status).toBe(400)
    const ok = await route.GET(
      nextReq(`http://x/api/defaults?u=${created.uuid}`, { headers: { "x-user-token": created.secret } }),
    )
    expect(ok.status).toBe(200)
  })

  it("PUT scoped fonde sullo storato: l'env non si cuoce nel file", async () => {
    vi.resetModules()
    const auth = await import("@/lib/user-auth")
    const defaults = await import("@/lib/server-defaults")
    const route = await import("@/app/api/defaults/route")
    const created = await auth.createUser()
    const headers = { "Content-Type": "application/json", "x-user-token": created.secret }
    // L'utente salva solo blurEnabled: region resta non-scelta (assente nel file).
    const put = await route.PUT(
      nextReq(`http://x/api/defaults?u=${created.uuid}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ blurEnabled: true }),
      }),
    )
    expect(put.status).toBe(200)
    const stored = await defaults.getStoredUserDefaults(created.uuid)
    expect(stored.blurEnabled).toBe(true)
    expect(stored.region).toBeUndefined()
    // Ma la lettura effettiva vede comunque il salvato.
    const effective = await defaults.getServerDefaultsForUser(created.uuid)
    expect(effective.blurEnabled).toBe(true)
  })
})

describe("/u/ con path uuid invalido → 400 (flag ON)", () => {
  it("catalog, meta e manifest rifiutano il path non-UUID", async () => {
    vi.resetModules()
    const catalog = await import("@/app/u/[user]/catalog/[type]/[id]/route")
    const meta = await import("@/app/u/[user]/meta/[type]/[id]/route")
    const manifest = await import("@/app/u/[user]/manifest.json/route")
    const res = await catalog.GET(
      nextReq("http://x/u/not-a-uuid/catalog/movie/pictorium-trending.json"),
      { params: Promise.resolve({ user: "not-a-uuid", type: "movie", id: "pictorium-trending.json" }) },
    )
    expect(res.status).toBe(400)
    const res2 = await meta.GET(
      nextReq("http://x/u/not-a-uuid/meta/movie/tmdb:1.json"),
      { params: Promise.resolve({ user: "not-a-uuid", type: "movie", id: "tmdb:1.json" }) },
    )
    expect(res2.status).toBe(400)
    const res3 = await manifest.GET(
      nextReq("http://x/u/not-a-uuid/manifest.json"),
      { params: Promise.resolve({ user: "not-a-uuid" }) },
    )
    expect(res3.status).toBe(400)
  })
})

describe("hashUserFragment: isolamento cache a 64-bit", () => {
  it("16 hex, deterministico, mai uuid in chiaro, distinti", async () => {
    vi.resetModules()
    const { hashUserFragment } = await import("@/lib/cache")
    const a = hashUserFragment(UUID_A)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(hashUserFragment(UUID_A)).toBe(a)
    expect(hashUserFragment(UUID_B)).not.toBe(a)
    expect(a).not.toContain(UUID_A.replace(/-/g, "").slice(0, 8))
  })
})
