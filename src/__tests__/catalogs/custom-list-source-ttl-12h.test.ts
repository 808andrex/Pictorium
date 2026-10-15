import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { fetchUnifiedCatalogResult } from "@/lib/custom-catalog-providers"
import { cacheInvalidate } from "@/lib/cache"

// Task 4 (user: "le liste personalizzate fai sempre 12 ore"): every
// successful normalized custom-list source caches 12h — not just MDBList.
// Errors, empties and incomplete/aborted prefixes keep short (no-cache)
// retry semantics; key/user/source isolation is unchanged. Time is driven
// via mocked Date.now (same pattern as source-cache-ttl.test.ts).

const HOUR = 60 * 60 * 1000
let now = 0

function mdblistPayload(): Response {
  return Response.json({ items: [{ imdb: "tt0133093", title: "Matrix", year: 1999, tmdb: 603 }] })
}

function traktListPayload(): Response {
  return Response.json([
    {
      type: "movie",
      movie: { ids: { imdb: "tt0133093", tmdb: 603 }, title: "Matrix", year: 1999 },
    },
  ])
}

function tmdbCollectionPayload(): Response {
  return Response.json({
    parts: [{ id: 11, title: "Saga Uno", release_date: "2012-01-01", poster_path: "/p.jpg" }],
  })
}

describe("custom list source cache 12h (Task 4)", () => {
  beforeEach(() => {
    now = 1_750_000_000_000
    vi.spyOn(Date, "now").mockImplementation(() => now)
    process.env.PICTORIUM_TRAKT_CLIENT_ID = "ttl-client-id"
    cacheInvalidate("custom_catalogs")
    cacheInvalidate("mdblist")
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.PICTORIUM_TRAKT_CLIENT_ID
    cacheInvalidate("custom_catalogs")
    cacheInvalidate("mdblist")
  })

  it("trakt public list (non-MDBList): still cached past 30min, refetch after 12h", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => traktListPayload())
    const url = "https://trakt.tv/users/someuser/lists/somelist"

    const first = await fetchUnifiedCatalogResult(url)
    expect(first.status).toBe("ok")
    expect(first.items).toHaveLength(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Past the old 30min window: must still be a hit (RED before the fix).
    now += 31 * 60_000
    const second = await fetchUnifiedCatalogResult(url)
    expect(second.status).toBe("ok")
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    now += 6 * HOUR
    await fetchUnifiedCatalogResult(url)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    now += 6 * HOUR + 1_000 // past 12h
    await fetchUnifiedCatalogResult(url)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("mdblist outer: still honors 12h (no regression)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => mdblistPayload())
    const url = "https://mdblist.com/lists/snoak/trending-movies"

    const first = await fetchUnifiedCatalogResult(url)
    expect(first.status).toBe("ok")
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    cacheInvalidate("mdblist") // isolate the outer cache from the inner one
    now += 31 * 60_000
    await fetchUnifiedCatalogResult(url)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    now += 12 * HOUR // past 12h since the outer write
    await fetchUnifiedCatalogResult(url)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("tmdb_collection: still cached past 30min, refetch after 12h", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => tmdbCollectionPayload())

    const first = await fetchUnifiedCatalogResult("tmdb:collection:86311", { apiKey: "k" })
    expect(first.status).toBe("ok")
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    now += 31 * 60_000
    await fetchUnifiedCatalogResult("tmdb:collection:86311", { apiKey: "k" })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    now += 12 * HOUR
    await fetchUnifiedCatalogResult("tmdb:collection:86311", { apiKey: "k" })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("errors are never long-cached: immediate retry refetches", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("boom", { status: 500 }))

    const first = await fetchUnifiedCatalogResult("tmdb:list:8249673", { apiKey: "k" })
    expect(first.status).toBe("empty")
    expect(first.items).toHaveLength(0)
    expect(fetchSpy).toHaveBeenCalledTimes(2) // v3 attempt + v4 fallback

    const second = await fetchUnifiedCatalogResult("tmdb:list:8249673", { apiKey: "k" })
    expect(second.status).toBe("empty")
    expect(fetchSpy).toHaveBeenCalledTimes(4)
  })

  it("empties are never long-cached: immediate retry refetches", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url: unknown) =>
        String(url).includes("/4/list/") ? Response.json({ results: [] }) : Response.json({ items: [] }),
      )

    const first = await fetchUnifiedCatalogResult("tmdb:list:8249673", { apiKey: "k" })
    expect(first.status).toBe("empty")
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    await fetchUnifiedCatalogResult("tmdb:list:8249673", { apiKey: "k" })
    expect(fetchSpy).toHaveBeenCalledTimes(4)
  })

  it("incomplete prefixes are never long-cached: partial refetches", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.includes("page=2")) return new Response("boom", { status: 500 })
      return Response.json({
        items: [{ id: 11, title: "Saga Uno", release_date: "2012-01-01", poster_path: "/p.jpg" }],
        total_pages: 2,
      })
    })

    const first = await fetchUnifiedCatalogResult("tmdb:list:8249673", { apiKey: "k" })
    expect(first.status).toBe("ok")
    expect(first.items).toHaveLength(1)
    expect(first.incomplete).toBe(true)
    const afterFirst = fetchSpy.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)

    const second = await fetchUnifiedCatalogResult("tmdb:list:8249673", { apiKey: "k" })
    expect(second.incomplete).toBe(true)
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(afterFirst)
  })

  it("key scope isolation unchanged: different apiKey refetches, same key hits", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => tmdbCollectionPayload())

    await fetchUnifiedCatalogResult("tmdb:collection:86311", { apiKey: "k1" })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    await fetchUnifiedCatalogResult("tmdb:collection:86311", { apiKey: "k1" })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    await fetchUnifiedCatalogResult("tmdb:collection:86311", { apiKey: "k2" })
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    await fetchUnifiedCatalogResult("tmdb:collection:86311", { apiKey: "k1" })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
