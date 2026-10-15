import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import type { Mapping } from "@/lib/types"

const ENV_KEYS = [
  "PICTORIUM_DATA_DIR",
  "PICTORIUM_MULTI_USER",
  "PROFILE_ENCRYPTION_KEY",
] as const
let savedEnv: Record<string, string | undefined> = {}
let tempDir: string | undefined

beforeEach(async () => {
  savedEnv = {}
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pictorium-first-import-"))
  process.env.PICTORIUM_DATA_DIR = tempDir
  process.env.PICTORIUM_MULTI_USER = "1"
  process.env.PROFILE_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex")
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

function nextReq(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): NextRequest {
  return new NextRequest(url, init)
}

function createBody(pw: string): { method: string; headers: Record<string, string>; body: string } {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) }
}

describe("POST /api/users: namespace isolato, mai auto-import", () => {
  it("primo utente: NON eredita i globali (migrazione solo via import-global esplicito)", async () => {
    vi.resetModules()
    const store = await import("@/lib/store")
    const defaults = await import("@/lib/server-defaults")
    await store.upsert(makeMapping(1, "Globale"))
    await defaults.setServerDefaults({ ...defaults.getServerDefaults(), badgeStyle: "pill" })

    const route = await import("@/app/api/users/route")
    const first = await route.POST(nextReq("http://x/api/users", createBody("first-pass-1")))
    expect(first.status).toBe(200)
    const body = (await first.json()) as { uuid: string; secret: string; importedMappings: number }
    expect(body.importedMappings).toBe(0)
    // Namespace vuoto e isolato: i globali restano solo globali.
    expect(await store.getAll(body.uuid)).toHaveLength(0)
    expect(await store.getAll()).toHaveLength(1)
  })

  it("istanza vergine: creazione ok con importedMappings 0", async () => {
    vi.resetModules()
    const route = await import("@/app/api/users/route")
    const res = await route.POST(nextReq("http://x/api/users", createBody("virgin-pass-1")))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { uuid: string; secret: string; importedMappings: number }
    expect(typeof body.uuid).toBe("string")
    expect(typeof body.secret).toBe("string")
    expect(body.importedMappings).toBe(0)
  })
})
