import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Mapping } from "@/lib/types"
import type { ImdbAlias } from "@/lib/store"

// Regression: valid-JSON wrong-top-level-shape persistence reads.
// The four FILE loaders (loadFromDisk, loadUserFromDisk, loadAliasesFromDisk,
// loadUserAliasesFromDisk) assigned unchecked JSON.parse results to the
// in-memory caches, so a top-level null/array/scalar poisoned the cache and
// made public read paths throw (Object.values(null)) or misinterpret records.
// All file I/O stays in isolated TEMP dirs, never the real DATA_DIR.
const UUID_A = "11111111-1111-4111-8111-111111111111"

const SHAPES: Array<{ name: string; payload: string }> = [
  { name: "null", payload: "null" },
  { name: "array", payload: "[1,2]" },
  { name: "number", payload: "42" },
  { name: "string", payload: '"oops"' },
]

const originalPictoriumDataDir = process.env.PICTORIUM_DATA_DIR
const originalPosteriumDataDir = process.env.POSTERIUM_DATA_DIR
const originalPictoriumRedisUrl = process.env.PICTORIUM_REDIS_URL
const originalPosteriumRedisUrl = process.env.POSTERIUM_REDIS_URL
const originalRedisUrl = process.env.REDIS_URL
const originalKvRestApiUrl = process.env.KV_REST_API_URL
const originalKvRestApiToken = process.env.KV_REST_API_TOKEN
let tempDirs: string[] = []
let mtimeSeq = 0

// Isolated temp base (approved scratch area, never the real DATA_DIR).
const TEMP_BASE = path.join(os.tmpdir(), "opencode")

function restoreEnv(name: string, original: string | undefined) {
  if (original === undefined) delete process.env[name]
  else process.env[name] = original
}

async function freshStore(tempDir?: string) {
  await fsp.mkdir(TEMP_BASE, { recursive: true })
  const dir = tempDir ?? (await fsp.mkdtemp(path.join(TEMP_BASE, "pictorium-shape-")))
  tempDirs.push(dir)
  // Primary data-dir var; legacy fallback cleared so it cannot interfere
  // (PICTORIUM_* wins anyway, but isolation is explicit).
  process.env.PICTORIUM_DATA_DIR = dir
  delete process.env.POSTERIUM_DATA_DIR
  // Force file storage mode for these isolated tests regardless of caller env.
  delete process.env.PICTORIUM_REDIS_URL
  delete process.env.POSTERIUM_REDIS_URL
  delete process.env.REDIS_URL
  delete process.env.KV_REST_API_URL
  delete process.env.KV_REST_API_TOKEN
  mtimeSeq = 0
  vi.resetModules()
  return { dir, store: await import("@/lib/store") }
}

afterEach(async () => {
  restoreEnv("PICTORIUM_DATA_DIR", originalPictoriumDataDir)
  restoreEnv("POSTERIUM_DATA_DIR", originalPosteriumDataDir)
  restoreEnv("PICTORIUM_REDIS_URL", originalPictoriumRedisUrl)
  restoreEnv("POSTERIUM_REDIS_URL", originalPosteriumRedisUrl)
  restoreEnv("REDIS_URL", originalRedisUrl)
  restoreEnv("KV_REST_API_URL", originalKvRestApiUrl)
  restoreEnv("KV_REST_API_TOKEN", originalKvRestApiToken)
  vi.resetModules()
  for (const dir of tempDirs) await fsp.rm(dir, { recursive: true, force: true })
  tempDirs = []
})

// Force the stat-based readers past the in-memory mirror timestamp
// (persist() snapshots Date.now(); same-ms rewrites could look unmodified).
async function writeShaped(dir: string, rel: string, payload: string) {
  const file = path.join(dir, rel)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, payload)
  mtimeSeq += 1
  const future = new Date(Date.now() + mtimeSeq * 60_000)
  await fsp.utimes(file, future, future)
  return file
}

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

function makeAlias(imdbId: string, tmdbId: number): ImdbAlias {
  return { imdbId, mediaType: "tv", tmdbId }
}

describe("global mappings wrong-top-level-shape", () => {
  it.each(SHAPES)("cold load falls back to empty, no throw ($name)", async ({ payload }) => {
    const { dir, store } = await freshStore()
    await writeShaped(dir, "mappings.json", payload)
    await expect(store.getAll()).resolves.toEqual([])
    await expect(store.getById("movie", 1)).resolves.toBeNull()
    // A poisoned cache must not break the next write either.
    await store.upsert(makeMapping(1, "After Corruption"))
    await expect(store.getById("movie", 1)).resolves.toMatchObject({ title: "After Corruption" })
  })

  it.each(SHAPES)("warm load preserves last-known-good, no poisoning ($name)", async ({ payload }) => {
    const { dir, store } = await freshStore()
    await store.upsert(makeMapping(7, "Seeded"))
    await expect(store.getAll()).resolves.toMatchObject([{ title: "Seeded" }])
    await writeShaped(dir, "mappings.json", payload)
    await expect(store.getAll()).resolves.toMatchObject([{ title: "Seeded" }])
    await expect(store.getById("movie", 7)).resolves.toMatchObject({ title: "Seeded" })
    // Cache not poisoned: a later valid file is picked up.
    await writeShaped(dir, "mappings.json", JSON.stringify({ "movie:9": makeMapping(9, "Fresh") }))
    await expect(store.getAll()).resolves.toMatchObject([{ title: "Fresh" }])
  })
})

describe("user mappings wrong-top-level-shape", () => {
  const rel = `users/${UUID_A}/mappings.json`
  it.each(SHAPES)("cold load falls back to empty, no throw ($name)", async ({ payload }) => {
    const { dir, store } = await freshStore()
    await writeShaped(dir, rel, payload)
    await expect(store.getAll(UUID_A)).resolves.toEqual([])
    await expect(store.getById("movie", 1, UUID_A)).resolves.toBeNull()
    await store.upsert(makeMapping(1, "After Corruption"), UUID_A)
    await expect(store.getById("movie", 1, UUID_A)).resolves.toMatchObject({ title: "After Corruption" })
  })

  it.each(SHAPES)("warm load preserves last-known-good, no poisoning ($name)", async ({ payload }) => {
    const { dir, store } = await freshStore()
    await store.upsert(makeMapping(7, "Seeded"), UUID_A)
    await expect(store.getAll(UUID_A)).resolves.toMatchObject([{ title: "Seeded" }])
    await writeShaped(dir, rel, payload)
    await expect(store.getAll(UUID_A)).resolves.toMatchObject([{ title: "Seeded" }])
    await expect(store.getById("movie", 7, UUID_A)).resolves.toMatchObject({ title: "Seeded" })
    await writeShaped(dir, rel, JSON.stringify({ "movie:9": makeMapping(9, "Fresh") }))
    await expect(store.getAll(UUID_A)).resolves.toMatchObject([{ title: "Fresh" }])
  })
})

describe("global aliases wrong-top-level-shape", () => {
  it.each(SHAPES)("cold load falls back to empty, no throw ($name)", async ({ payload }) => {
    const { dir, store } = await freshStore()
    await writeShaped(dir, "aliases.json", payload)
    await expect(store.getAllAliases()).resolves.toEqual([])
    await expect(store.getImdbAlias("tt10000001")).resolves.toBeNull()
    await store.setImdbAlias(makeAlias("tt10000001", 101))
    await expect(store.getImdbAlias("tt10000001")).resolves.toMatchObject({ tmdbId: 101 })
  })

  it.each(SHAPES)("warm load preserves last-known-good, no poisoning ($name)", async ({ payload }) => {
    const { dir, store } = await freshStore()
    await store.setImdbAlias(makeAlias("tt10000001", 101))
    await expect(store.getAllAliases()).resolves.toMatchObject([{ tmdbId: 101 }])
    await writeShaped(dir, "aliases.json", payload)
    await expect(store.getAllAliases()).resolves.toMatchObject([{ tmdbId: 101 }])
    await expect(store.getImdbAlias("tt10000001")).resolves.toMatchObject({ tmdbId: 101 })
    await writeShaped(
      dir,
      "aliases.json",
      JSON.stringify({ tt10000002: { ...makeAlias("tt10000002", 102), updatedAt: new Date().toISOString() } }),
    )
    await expect(store.getImdbAlias("tt10000002")).resolves.toMatchObject({ tmdbId: 102 })
  })
})

describe("user aliases wrong-top-level-shape", () => {
  const rel = `users/${UUID_A}/aliases.json`
  it.each(SHAPES)("cold load falls back to empty, no throw ($name)", async ({ payload }) => {
    const { dir, store } = await freshStore()
    await writeShaped(dir, rel, payload)
    await expect(store.getAllAliases(UUID_A)).resolves.toEqual([])
    await expect(store.getImdbAlias("tt10000001", UUID_A)).resolves.toBeNull()
    await store.setImdbAlias(makeAlias("tt10000001", 101), UUID_A)
    await expect(store.getImdbAlias("tt10000001", UUID_A)).resolves.toMatchObject({ tmdbId: 101 })
  })

  it.each(SHAPES)("warm load preserves last-known-good, no poisoning ($name)", async ({ payload }) => {
    const { dir, store } = await freshStore()
    await store.setImdbAlias(makeAlias("tt10000001", 101), UUID_A)
    await expect(store.getAllAliases(UUID_A)).resolves.toMatchObject([{ tmdbId: 101 }])
    await writeShaped(dir, rel, payload)
    await expect(store.getAllAliases(UUID_A)).resolves.toMatchObject([{ tmdbId: 101 }])
    await expect(store.getImdbAlias("tt10000001", UUID_A)).resolves.toMatchObject({ tmdbId: 101 })
    await writeShaped(
      dir,
      rel,
      JSON.stringify({ tt10000002: { ...makeAlias("tt10000002", 102), updatedAt: new Date().toISOString() } }),
    )
    await expect(store.getImdbAlias("tt10000002", UUID_A)).resolves.toMatchObject({ tmdbId: 102 })
  })
})

describe("wrong-shape corruption stays scoped", () => {
  it("corrupt global mappings + user aliases leave the other scopes intact", async () => {
    const { dir, store } = await freshStore()
    await store.upsert(makeMapping(1, "Global"))
    await store.upsert(makeMapping(2, "Scoped"), UUID_A)
    await store.setImdbAlias(makeAlias("tt10000001", 101))
    await store.setImdbAlias(makeAlias("tt10000002", 102), UUID_A)

    await writeShaped(dir, "mappings.json", "null")
    await writeShaped(dir, `users/${UUID_A}/aliases.json`, "[1,2]")

    // Corrupted scopes fall back to last-known-good …
    await expect(store.getAll()).resolves.toMatchObject([{ title: "Global" }])
    await expect(store.getAllAliases(UUID_A)).resolves.toMatchObject([{ tmdbId: 102 }])
    // … while untouched scopes keep serving their own records.
    await expect(store.getAll(UUID_A)).resolves.toMatchObject([{ title: "Scoped" }])
    await expect(store.getAllAliases()).resolves.toMatchObject([{ tmdbId: 101 }])
  })
})
