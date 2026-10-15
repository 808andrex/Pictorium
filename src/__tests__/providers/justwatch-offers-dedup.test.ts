import { beforeEach, describe, expect, it, vi } from "vitest"
import { __resetJWRankingsCache, getJWTitleQuality, hasJWOffers } from "@/lib/justwatch"

const EDGES = [
  {
    node: {
      content: { title: "Dune", externalIds: { tmdbId: 438631, imdbId: "tt1160419" } },
      offers: [{ monetizationType: "RENT", presentationType: "4K" }],
    },
  },
]

function mockOffers() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ data: { popularTitles: { edges: EDGES } } }),
  )
}

beforeEach(() => {
  __resetJWRankingsCache()
  vi.restoreAllMocks()
})

describe("GetTitleOffers in-flight dedup", () => {
  it("concurrent quality + availability on the same title = 1 POST", async () => {
    const spy = mockOffers()
    const [q, a] = await Promise.all([
      getJWTitleQuality(438631, "MOVIE", "Dune"),
      hasJWOffers(438631, "MOVIE", "Dune"),
    ])
    expect(q).toBe("4K")
    expect(a).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("second round serves from result caches = still 1 POST", async () => {
    const spy = mockOffers()
    await Promise.all([
      getJWTitleQuality(438631, "MOVIE", "Dune"),
      hasJWOffers(438631, "MOVIE", "Dune"),
    ])
    await getJWTitleQuality(438631, "MOVIE", "Dune")
    await hasJWOffers(438631, "MOVIE", "Dune")
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("different titles do not share the flight", async () => {
    const spy = mockOffers()
    await getJWTitleQuality(438631, "MOVIE", "Dune")
    await hasJWOffers(999999, "MOVIE", "Other")
    // 2 POST: filtri diversi (searchQuery diversa) = chiavi diverse.
    // Il secondo titolo non matcha: disponibilità ignota, mai false.
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
