import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearTvdbCache,
  getTvdbArtworks,
  getTvdbMovieId,
  pickTvdbPoster,
  type TvdbArtwork,
} from "@/lib/tvdb"

function loginOk(): Response {
  return Response.json({ status: "success", data: { token: "mock-jwt" } })
}

// B1 TVDB artworks (spec v4.7.10: ArtworkBaseRecord { image, thumbnail,
// language, type, width, height, includesText, score }).
describe("TVDB artworks (B1 rescue candidates)", () => {
  beforeEach(() => {
    clearTvdbCache()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearTvdbCache()
  })

  describe("getTvdbMovieId", () => {
    it("resolves a movie id from search/remoteid movie key", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(
          Response.json({ status: "success", data: [{ movie: { id: 12345 } }] }),
        )
      expect(await getTvdbMovieId("tt0133093", "k")).toBe(12345)
    })

    it("returns null on empty results without extra calls", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(Response.json({ status: "success", data: [] }))
      expect(await getTvdbMovieId("tt0000000", "k")).toBeNull()
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
  })

  describe("getTvdbArtworks", () => {
    it("parses series artworks array", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(
          Response.json({
            status: "success",
            data: [
              { id: 1, image: "https://artworks.thetvdb.com/banners/v4/poster/1.jpg", language: "eng", type: 2, width: 680, height: 1000, includesText: false, score: 9.1 },
              { id: 2, image: "https://artworks.thetvdb.com/banners/v4/fanart/2.jpg", language: "eng", type: 3, width: 1920, height: 1080, includesText: false, score: 9.9 },
            ],
          }),
        )
      const arts = await getTvdbArtworks("tv", 75710, "k")
      expect(arts).toHaveLength(2)
      expect(arts[0]).toMatchObject({ image: expect.stringContaining("/poster/1.jpg"), width: 680, height: 1000, includesText: false })
    })

    it("parses movie extended { artworks } shape", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(
          Response.json({
            status: "success",
            data: {
              id: 12345,
              artworks: [
                { id: 9, image: "https://artworks.thetvdb.com/banners/v4/poster/9.jpg", language: null, type: 2, width: 1000, height: 1500, includesText: false, score: 7 },
              ],
            },
          }),
        )
      const arts = await getTvdbArtworks("movie", 12345, "k")
      expect(arts).toHaveLength(1)
      expect(arts[0]?.image).toContain("/poster/9.jpg")
    })

    it("returns [] on garbage payloads and caches the empty result", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(Response.json({ status: "success", data: { nope: true } }))
      expect(await getTvdbArtworks("tv", 1, "k")).toEqual([])
      // Seconda chiamata: cache (0 fetch).
      expect(await getTvdbArtworks("tv", 1, "k")).toEqual([])
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
  })

  describe("pickTvdbPoster", () => {
    const art = (over: Partial<TvdbArtwork> & { image: string }): TvdbArtwork => over

    it("prefers textless portrait in the preferred language", () => {
      const arts = [
        art({ image: "a", width: 1920, height: 1080, includesText: false, score: 9.9, language: "eng" }), // landscape
        art({ image: "b", width: 680, height: 1000, includesText: true, score: 9.9, language: "eng" }), // con testo
        art({ image: "c", width: 680, height: 1000, includesText: false, score: 5, language: "spa" }), // textless altra lingua
        art({ image: "d", width: 680, height: 1000, includesText: false, score: 8, language: "eng" }), // textless eng
      ]
      expect(pickTvdbPoster(arts, "it")?.image).toBe("d")
    })

    it("prefers null-language over any spoken language", () => {
      const arts = [
        art({ image: "a", width: 680, height: 1000, includesText: false, score: 1, language: "eng" }),
        art({ image: "b", width: 680, height: 1000, includesText: false, score: 1 }),
      ]
      expect(pickTvdbPoster(arts, "it")?.image).toBe("b")
    })

    it("breaks ties by TVDB score and returns null when empty", () => {
      const arts = [
        art({ image: "a", width: 680, height: 1000, includesText: false, score: 3, language: "eng" }),
        art({ image: "b", width: 680, height: 1000, includesText: false, score: 8, language: "eng" }),
      ]
      expect(pickTvdbPoster(arts, "it")?.image).toBe("b")
      expect(pickTvdbPoster([], "it")).toBeNull()
      expect(pickTvdbPoster([art({ image: "", width: 1, height: 2 })], "it")).toBeNull()
    })
  })
})
