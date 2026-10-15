import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Mapping } from "@/lib/types"

// UUID v4 validi e distinti per i namespace di test.
const UUID_A = "11111111-1111-4111-8111-111111111111"
const UUID_B = "22222222-2222-4222-8222-222222222222"

const ENV_KEYS = ["PICTORIUM_DATA_DIR", "PICTORIUM_MULTI_USER", "PICTORIUM_MAX_MAPPINGS_PER_USER"] as const
let savedEnv: Record<string, string | undefined> = {}
let tempDir: string | undefined

beforeEach(async () => {
  savedEnv = {}
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pictorium-multiuser-"))
  process.env.PICTORIUM_DATA_DIR = tempDir
  process.env.PICTORIUM_MULTI_USER = "1"
  delete process.env.PICTORIUM_MAX_MAPPINGS_PER_USER
})

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.resetModules()
  if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

function makeMapping(id: number, title: string): Mapping {
  return {
    tmdbId: id,
    mediaType: "movie",
    title,
    posterPath: `/p${id}.jpg`,
    logoPath: null,
    originalPosterPath: null,
    language: "it",
    updatedAt: new Date().toISOString(),
  }
}

describe("user-auth", () => {
  it("sanitizeUserId accetta UUID e rifiuta traversal", async () => {
    vi.resetModules()
    const auth = await import("@/lib/user-auth")
    expect(auth.sanitizeUserId(UUID_A)).toBe(UUID_A)
    expect(auth.sanitizeUserId(UUID_A.toUpperCase())).toBe(UUID_A)
    expect(auth.sanitizeUserId("../../etc")).toBeNull()
    expect(auth.sanitizeUserId("")).toBeNull()
    expect(auth.sanitizeUserId(null)).toBeNull()
  })

  it("getScopedUserId è null con flag OFF (default-off byte-identico)", async () => {
    delete process.env.PICTORIUM_MULTI_USER
    vi.resetModules()
    const auth = await import("@/lib/user-auth")
    expect(auth.isMultiUserEnabled()).toBe(false)
    expect(auth.getScopedUserId(UUID_A)).toBeNull()
  })

  it("createUser → exists + verify (secret mostrato una volta sola)", async () => {
    vi.resetModules()
    const auth = await import("@/lib/user-auth")
    const created = await auth.createUser()
    expect(created.uuid).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.secret.length).toBeGreaterThan(20)
    expect(await auth.userExists(created.uuid)).toBe(true)
    expect(await auth.userExists(UUID_A)).toBe(false)
    expect(await auth.verifyUserToken(created.uuid, created.secret)).toBe(true)
    expect(await auth.verifyUserToken(created.uuid, "sbagliato")).toBe(false)
    expect(await auth.verifyUserToken(UUID_A, created.secret)).toBe(false)
    // A riposo solo lo sha256: mai il secret in chiaro su disco.
    const raw = await fsp.readFile(path.join(tempDir!, "users", created.uuid, "auth.json"), "utf-8")
    expect(raw).not.toContain(created.secret)
    expect(JSON.parse(raw)).toHaveProperty("hash")
  })

  it("extractUserToken: x-user-token > Bearer, mai query", async () => {
    vi.resetModules()
    const auth = await import("@/lib/user-auth")
    const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null })
    expect(auth.extractUserToken({ headers: headers({ "x-user-token": "abc" }) })).toBe("abc")
    expect(auth.extractUserToken({ headers: headers({ authorization: "Bearer xyz" }) })).toBe("xyz")
    expect(auth.extractUserToken({ headers: headers({}) })).toBeNull()
  })
})

describe("store namespaced", () => {
  it("isola A↔B: stessa chiave, titoli diversi, globale vuoto", async () => {
    vi.resetModules()
    const store = await import("@/lib/store")
    await store.upsert(makeMapping(1, "Film di A"), UUID_A)
    await store.upsert(makeMapping(1, "Film di B"), UUID_B)
    expect((await store.getById("movie", 1, UUID_A))?.title).toBe("Film di A")
    expect((await store.getById("movie", 1, UUID_B))?.title).toBe("Film di B")
    // Namespace stretto: il globale non vede nulla dei namespace.
    expect(await store.getById("movie", 1)).toBeNull()
    expect(await store.getAll(UUID_A)).toHaveLength(1)
    expect(await store.getAll()).toHaveLength(0)
    // remove in A non tocca B.
    await store.remove("movie", 1, UUID_A)
    expect(await store.getById("movie", 1, UUID_A)).toBeNull()
    expect((await store.getById("movie", 1, UUID_B))?.title).toBe("Film di B")
  })

  it("rifiuta userId non-UUID senza toccare il disco", async () => {
    vi.resetModules()
    const store = await import("@/lib/store")
    await expect(store.getById("movie", 1, "../../etc")).rejects.toThrow("Invalid user id")
    await expect(store.upsert(makeMapping(1, "X"), "..")).rejects.toThrow("Invalid user id")
  })

  it("quota: oltre il cap → QuotaExceededError, update esistente ok", async () => {
    process.env.PICTORIUM_MAX_MAPPINGS_PER_USER = "2"
    vi.resetModules()
    const store = await import("@/lib/store")
    await store.upsert(makeMapping(1, "Uno"), UUID_A)
    await store.upsert(makeMapping(2, "Due"), UUID_A)
    await expect(store.upsert(makeMapping(3, "Tre"), UUID_A)).rejects.toThrowError(store.QuotaExceededError)
    // L'update di una chiave esistente non consuma quota.
    await store.upsert(makeMapping(1, "Uno bis"), UUID_A)
    expect((await store.getById("movie", 1, UUID_A))?.title).toBe("Uno bis")
    // L'altro namespace ha quota propria.
    await store.upsert(makeMapping(3, "Tre di B"), UUID_B)
    expect((await store.getById("movie", 3, UUID_B))?.title).toBe("Tre di B")
  })
})

describe("server-defaults namespaced", () => {
  it("isola i defaults per-utente, globale intatto", async () => {
    vi.resetModules()
    const sd = await import("@/lib/server-defaults")
    await sd.setServerDefaultsForUser(UUID_A, { badgeStyle: "pill" })
    expect(await sd.getServerDefaultsForUser(UUID_A)).toMatchObject({ badgeStyle: "pill" })
    expect(await sd.getServerDefaultsForUser(UUID_B)).not.toMatchObject({ badgeStyle: "pill" })
    // Il globale non vede lo scoped e viceversa.
    expect(sd.getServerDefaults().badgeStyle).toBeUndefined()
    await sd.setServerDefaults({ badgeStyle: "bar" } as never)
    expect(sd.getServerDefaults().badgeStyle).toBe("bar")
    expect(await sd.getServerDefaultsForUser(UUID_A)).toMatchObject({ badgeStyle: "pill" })
  })
})

describe("catalog-epoch namespaced", () => {
  it("bump utente non muove il globale né gli altri", async () => {
    vi.resetModules()
    const ep = await import("@/lib/catalog-epoch")
    const beforeGlobal = await ep.getCatalogEpoch()
    const nextA = await ep.bumpCatalogEpoch(UUID_A)
    expect(await ep.getCatalogEpoch(UUID_A)).toBe(nextA)
    expect(await ep.getCatalogEpoch()).toBe(beforeGlobal)
    expect(await ep.getCatalogEpoch(UUID_B)).toBe("0")
    // Due bump consecutivi ruotano davvero la chiave.
    const nextA2 = await ep.bumpCatalogEpoch(UUID_A)
    expect(nextA2).not.toBe(nextA)
  })
})
