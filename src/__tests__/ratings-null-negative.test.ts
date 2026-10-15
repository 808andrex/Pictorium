import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  __resetMdblistBreaker,
  __resetRatingsNullForTest,
  fetchAggregatedRating,
} from "@/lib/ratings"
import { cacheClear } from "@/lib/cache"

beforeEach(() => {
  cacheClear()
  __resetMdblistBreaker()
  __resetRatingsNullForTest()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("MDBList rating null negative cache (60s)", () => {
  it("a 404 miss fetches once for repeated calls", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 404 }))
    expect(await fetchAggregatedRating("tt9900001", "k")).toBeNull()
    expect(await fetchAggregatedRating("tt9900001", "k")).toBeNull()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("an empty-sources payload is also absorbed", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ score: 0, ratings: [] }),
    )
    expect(await fetchAggregatedRating("tt9900002", "k")).toBeNull()
    expect(await fetchAggregatedRating("tt9900002", "k")).toBeNull()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("a real result still caches and returns data", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ratings: [{ source: "imdb", value: 84, score: 84 }] }),
    )
    const r = await fetchAggregatedRating("tt9900003", "k")
    expect(r?.average).toBe(8.4)
    await fetchAggregatedRating("tt9900003", "k")
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
