import { afterEach, describe, expect, it, vi } from "vitest"
import { __clearTMDBCache, __resetKey401Cache, getDetails } from "@/lib/tmdb"
import { cacheGetShared } from "@/lib/cache"
import { getById } from "@/lib/store"
import {
  getKv,
  KvTimeoutError,
  withKvTimeout,
  type KvClient,
} from "@/lib/kv"

// KV appeso: getKv() reale non toccato mai (nessuna connessione), solo la
// risposta che non arriva — replica il TCP stallato visto in produzione.
vi.mock("@/lib/kv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/kv")>()
  return { ...actual, getKv: vi.fn() }
})

const getKvMock = vi.mocked(getKv)

function hangingKvClient(): KvClient {
  const hang = <T,>() => new Promise<T>(() => {})
  return {
    get: () => hang<null>(),
    set: async () => {},
    del: async () => 0,
    hgetall: () => hang<null>(),
    hset: async () => 0,
    hdel: async () => 0,
    incr: async () => 0,
    expire: async () => 0,
    scan: async () => [0, []] as [number, string[]],
  } as unknown as KvClient
}

/** Fetch appesa che onora l'abort (come undici): rigetta solo su signal. */
function mockHangingFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation((_url: unknown, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      ;(init?.signal as AbortSignal | undefined)?.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted", "AbortError")),
        { once: true },
      )
    })
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  __clearTMDBCache()
  __resetKey401Cache()
  delete process.env.PICTORIUM_REDIS_URL
})

describe("withKvTimeout", () => {
  it("rigetta KvTimeoutError su promise mai risolta e pulisce il timer", async () => {
    const start = Date.now()
    await expect(withKvTimeout(new Promise(() => {}), 60)).rejects.toBeInstanceOf(KvTimeoutError)
    expect(Date.now() - start).toBeLessThan(1000)
  })

  it("risolve il valore quando la promise è veloce", async () => {
    await expect(withKvTimeout(Promise.resolve(42), 60)).resolves.toBe(42)
  })
})

describe("tmdbFetch waiter con signal proprio", () => {
  it("il waiter esce al proprio abort senza aspettare il primo (ostaggio)", async () => {
    mockHangingFetch()
    const id = 977001
    const p1 = getDetails("movie", id, "it-IT", "waiter-key-a", undefined, 1200)
    await new Promise((r) => setTimeout(r, 50))
    const start = Date.now()
    // Stessa neutral-URL (chiave senza api_key), signal corto da catalogo.
    await expect(
      getDetails("movie", id, "it-IT", "waiter-key-b", AbortSignal.timeout(150), 10000),
    ).rejects.toThrow()
    expect(Date.now() - start).toBeLessThan(900)
    // Il primo chiude al proprio tetto: niente poison residuo.
    await expect(p1).rejects.toThrow()
  }, 10000)

  it("senza signal il waiter condivide ancora l'esito (compatibilità)", async () => {
    mockHangingFetch()
    const id = 977002
    const p1 = getDetails("movie", id, "it-IT", "shared-key-a", undefined, 300)
    await new Promise((r) => setTimeout(r, 50))
    const start = Date.now()
    await expect(getDetails("movie", id, "it-IT", "shared-key-b")).rejects.toThrow()
    expect(Date.now() - start).toBeLessThan(2000)
    await expect(p1).rejects.toThrow()
  }, 10000)

  it("dopo il settle l'inflight è libero: la chiave non resta avvelenata", async () => {
    mockHangingFetch()
    const id = 977003
    await expect(getDetails("movie", id, "it-IT", "poison-key", undefined, 100)).rejects.toThrow()
    vi.restoreAllMocks()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ id, genres: [], vote_average: 7, vote_count: 10 }),
    )
    const d = await getDetails("movie", id, "it-IT", "poison-key", undefined, 5000)
    expect(d.id).toBe(id)
  }, 10000)
})

describe("store KV stallata: fail-open senza hang", () => {
  it("getById scoped esce entro il tetto con null e non avvelena il namespace", async () => {
    process.env.PICTORIUM_REDIS_URL = "redis://localhost:9"
    getKvMock.mockReturnValue(hangingKvClient())
    const userId = "11111111-1111-4111-8111-111111111111"
    const start = Date.now()
    await expect(getById("movie", 977011, userId)).resolves.toBeNull()
    expect(Date.now() - start).toBeLessThan(5000)
    // Seconda chiamata sullo stesso namespace: veloce, niente poison.
    const start2 = Date.now()
    await expect(getById("movie", 977012, userId)).resolves.toBeNull()
    expect(Date.now() - start2).toBeLessThan(5000)
  }, 15000)

  it("getById globale esce entro il tetto con null", async () => {
    process.env.PICTORIUM_REDIS_URL = "redis://localhost:9"
    getKvMock.mockReturnValue(hangingKvClient())
    const start = Date.now()
    await expect(getById("tv", 977013)).resolves.toBeNull()
    expect(Date.now() - start).toBeLessThan(5000)
  }, 15000)
})

describe("cache L2 stallata: miss senza hang", () => {
  it("cacheGetShared ritorna null entro il tetto", async () => {
    process.env.PICTORIUM_REDIS_URL = "redis://localhost:9"
    getKvMock.mockReturnValue(hangingKvClient())
    const start = Date.now()
    await expect(cacheGetShared("hang-resilience-key", [])).resolves.toBeNull()
    expect(Date.now() - start).toBeLessThan(4000)
  }, 15000)
})
