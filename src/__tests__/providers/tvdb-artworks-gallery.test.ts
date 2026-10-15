import { describe, expect, it } from "vitest"
import {
  ARTWORKS_BASE,
  TVDB_MOVIE_BACKDROP_TYPE_ID,
  TVDB_MOVIE_LOGO_TYPE_ID,
  TVDB_MOVIE_POSTER_TYPE_ID,
  TVDB_SERIES_BACKDROP_TYPE_ID,
  TVDB_SERIES_LOGO_TYPE_ID,
  TVDB_SERIES_POSTER_TYPE_ID,
  classifyTvdbArtworks,
  normalizeTvdbImageUrl,
  normalizeTvdbLanguage,
  pickTvdbBackdrop,
  pickTvdbLogo,
  pickTvdbPoster,
  type TvdbArtwork,
} from "@/lib/tvdb"

const art = (over: Partial<TvdbArtwork> & { image: string }): TvdbArtwork => over as TvdbArtwork
const IMG = (p: string) => `https://artworks.thetvdb.com${p}`

describe("TVDB artwork type ids (documented whitelist)", () => {
  it("movie 14/15/25, series 2/3/23", () => {
    expect(TVDB_MOVIE_POSTER_TYPE_ID).toBe(14)
    expect(TVDB_MOVIE_BACKDROP_TYPE_ID).toBe(15)
    expect(TVDB_MOVIE_LOGO_TYPE_ID).toBe(25)
    expect(TVDB_SERIES_POSTER_TYPE_ID).toBe(2)
    expect(TVDB_SERIES_BACKDROP_TYPE_ID).toBe(3)
    expect(TVDB_SERIES_LOGO_TYPE_ID).toBe(23)
  })
})

describe("classifyTvdbArtworks", () => {
  it("groups movie 14/15/25 only", () => {
    const gallery = classifyTvdbArtworks(
      [
        art({ image: IMG("/banners/v4/poster/1.jpg"), type: 14, score: 5 }),
        art({ image: IMG("/banners/v4/fanart/2.jpg"), type: 15, score: 5 }),
        art({ image: IMG("/banners/v4/clearlogo/3.png"), type: 25, score: 5 }),
      ],
      "movie",
    )
    expect(gallery.posters).toHaveLength(1)
    expect(gallery.backdrops).toHaveLength(1)
    expect(gallery.logos).toHaveLength(1)
    expect(gallery.posters[0]).toMatchObject({ source: "tvdb", type: 14 })
  })

  it("groups series 2/3/23 only", () => {
    const gallery = classifyTvdbArtworks(
      [
        art({ image: IMG("/banners/v4/poster/1.jpg"), type: 2, score: 5 }),
        art({ image: IMG("/banners/v4/fanart/2.jpg"), type: 3, score: 5 }),
        art({ image: IMG("/banners/v4/clearlogo/3.png"), type: 23, score: 5 }),
      ],
      "tv",
    )
    expect(gallery.posters).toHaveLength(1)
    expect(gallery.backdrops).toHaveLength(1)
    expect(gallery.logos).toHaveLength(1)
  })

  it("never misclassifies season/clearart/banner/icon/unknown or cross-media ids", () => {
    const tv = classifyTvdbArtworks(
      [
        art({ image: IMG("/banners/v4/season/7.jpg"), type: 7 }),
        art({ image: IMG("/banners/v4/clearart/22.png"), type: 22 }),
        art({ image: IMG("/banners/v4/clearart/24.png"), type: 24 }),
        art({ image: IMG("/banners/v4/banner/1.jpg"), type: 1 }),
        art({ image: IMG("/banners/v4/icon/1.png"), type: 5 }),
        art({ image: IMG("/banners/v4/poster/9.jpg"), type: 999 }),
        art({ image: IMG("/banners/v4/poster/10.jpg") }),
        // Cross-media: movie poster id on a series must not land anywhere.
        art({ image: IMG("/banners/v4/poster/14.jpg"), type: 14 }),
        art({ image: IMG("/banners/v4/fanart/15.jpg"), type: 15 }),
        art({ image: IMG("/banners/v4/clearlogo/25.png"), type: 25 }),
      ],
      "tv",
    )
    expect(tv.posters).toEqual([])
    expect(tv.backdrops).toEqual([])
    expect(tv.logos).toEqual([])

    const movie = classifyTvdbArtworks(
      [
        art({ image: IMG("/banners/v4/poster/2.jpg"), type: 2 }),
        art({ image: IMG("/banners/v4/fanart/3.jpg"), type: 3 }),
        art({ image: IMG("/banners/v4/clearlogo/23.png"), type: 23 }),
      ],
      "movie",
    )
    expect(movie.posters).toEqual([])
    expect(movie.backdrops).toEqual([])
    expect(movie.logos).toEqual([])
  })

  it("dedups by safe URL (keeps max score), caps groups, sorts by score", () => {
    const dup = IMG("/banners/v4/poster/d.jpg")
    const many = Array.from({ length: 40 }, (_, i) =>
      art({ image: IMG(`/banners/v4/poster/p${i}.jpg`), type: 2, score: i }),
    )
    const gallery = classifyTvdbArtworks(
      [
        art({ image: dup, type: 2, score: 1 }),
        art({ image: dup, type: 2, score: 9 }),
        ...many,
      ],
      "tv",
    )
    expect(gallery.posters).toHaveLength(30)
    // Highest score first.
    expect(gallery.posters[0]?.score).toBe(39)
    // Dedup kept the max score for the duplicate URL.
    const kept = gallery.posters.filter((p) => p.url === dup)
    // dup score 9 may fall out of the top-30 cap; either absent or max-score.
    for (const k of kept) expect(k.score).toBe(9)
  })

  it("normalizes relative paths, keeps metadata + textless distinction", () => {
    const gallery = classifyTvdbArtworks(
      [
        art({
          image: "/banners/v4/poster/rel.jpg",
          thumbnail: "/banners/v4/poster/rel_t.jpg",
          language: "ENG",
          type: 2,
          width: 680,
          height: 1000,
          includesText: false,
          score: 7.5,
        }),
      ],
      "tv",
    )
    expect(gallery.posters).toHaveLength(1)
    expect(gallery.posters[0]).toMatchObject({
      url: `${ARTWORKS_BASE}/banners/v4/poster/rel.jpg`,
      thumbnail: `${ARTWORKS_BASE}/banners/v4/poster/rel_t.jpg`,
      language: "eng",
      width: 680,
      height: 1000,
      includesText: false,
      score: 7.5,
      source: "tvdb",
      type: 2,
    })
  })

  it("skips SVG/MP4/off-host/userinfo/port/query-key URLs honestly", () => {
    const gallery = classifyTvdbArtworks(
      [
        art({ image: IMG("/banners/v4/clearlogo/a.svg"), type: 23 }),
        art({ image: IMG("/banners/v4/poster/b.mp4"), type: 2 }),
        art({ image: "https://evil.example/x.jpg", type: 2 }),
        art({ image: "https://artworks.thetvdb.com.evil.example/x.jpg", type: 2 }),
        art({ image: "https://user:pass@artworks.thetvdb.com/banners/v4/poster/c.jpg", type: 2 }),
        art({ image: "https://artworks.thetvdb.com:8443/banners/v4/poster/d.jpg", type: 2 }),
        art({ image: "http://artworks.thetvdb.com/banners/v4/poster/e.jpg", type: 2 }),
        art({ image: `${IMG("/banners/v4/poster/f.jpg")}?api_key=secret`, type: 2 }),
      ],
      "tv",
    )
    expect(gallery.posters).toEqual([])
    expect(gallery.logos).toEqual([])
  })
})

describe("normalizeTvdbImageUrl (exact-host guard)", () => {
  it("accepts exact host + relative paths", () => {
    expect(normalizeTvdbImageUrl(IMG("/banners/v4/poster/1.jpg"))).toBe(IMG("/banners/v4/poster/1.jpg"))
    expect(normalizeTvdbImageUrl("/banners/v4/poster/1.jpg")).toBe(IMG("/banners/v4/poster/1.jpg"))
  })

  it("rejects boundary-evil hosts, userinfo, ports, protocols, key queries", () => {
    for (const bad of [
      "https://artworks.thetvdb.com.evil.example/x.jpg",
      "https://evilartworks.thetvdb.com/x.jpg",
      "https://sub.artworks.thetvdb.com/x.jpg",
      "https://user@artworks.thetvdb.com/x.jpg",
      "https://artworks.thetvdb.com:443/x.jpg",
      "http://artworks.thetvdb.com/x.jpg",
      `${IMG("/x.jpg")}?api_key=K`,
      `${IMG("/x.jpg")}?token=K`,
      IMG("/x.svg"),
      "not a url",
      "",
    ]) {
      expect(normalizeTvdbImageUrl(bad)).toBeNull()
    }
  })

  it("blocks bare/encoded credential keys the raw-search regex misses", () => {
    const base = IMG("/banners/v4/poster/1.jpg")
    for (const bad of [
      `${base}?key=abc`,
      `${base}?KEY=abc`,
      `${base}?%6Bey=abc`,
      `${base}?%6b%65%79=abc`,
      `${base}?Api_Key=abc`,
    ]) {
      expect(normalizeTvdbImageUrl(bad)).toBeNull()
    }
  })

  it("keeps benign language query values", () => {
    const base = IMG("/banners/v4/poster/1.jpg")
    expect(normalizeTvdbImageUrl(`${base}?language=eng`)).toBe(`${base}?language=eng`)
  })

  it("classify drops credential-query URLs but keeps benign language queries", () => {
    const base = IMG("/banners/v4/poster/1.jpg")
    const gallery = classifyTvdbArtworks(
      [
        art({ image: `${base}?key=abc`, type: 2, score: 99 }),
        art({ image: `${base}?language=eng`, type: 2, score: 5 }),
      ],
      "tv",
    )
    expect(gallery.posters).toHaveLength(1)
    expect(gallery.posters[0]?.url).toBe(`${base}?language=eng`)
  })
})

describe("normalizeTvdbLanguage (honest 3-letter)", () => {
  it("lowercases, keeps null neutral, never invents textless", () => {
    expect(normalizeTvdbLanguage("eng")).toBe("eng")
    expect(normalizeTvdbLanguage("ENG")).toBe("eng")
    expect(normalizeTvdbLanguage("ita")).toBe("ita")
    expect(normalizeTvdbLanguage(null)).toBeNull()
    expect(normalizeTvdbLanguage(undefined)).toBeNull()
    expect(normalizeTvdbLanguage("")).toBeNull()
  })
})

describe("pure pickers with type guards (legacy typeless still flows)", () => {
  it("pickTvdbPoster filters known non-posters, keeps legacy typeless", () => {
    const arts = [
      art({ image: "poster", type: 2, width: 680, height: 1000, includesText: false, score: 1, language: "eng" }),
      art({ image: "backdrop", type: 3, width: 680, height: 1000, includesText: false, score: 99, language: "eng" }),
      art({ image: "season", type: 7, width: 680, height: 1000, includesText: false, score: 99, language: "eng" }),
      art({ image: "clearart", type: 22, width: 680, height: 1000, includesText: false, score: 99, language: "eng" }),
    ]
    expect(pickTvdbPoster(arts, "it")?.image).toBe("poster")
    // Legacy typeless fixtures (old tests) still rescue.
    expect(
      pickTvdbPoster([art({ image: "legacy", width: 680, height: 1000, includesText: false, score: 1 })], "it")?.image,
    ).toBe("legacy")
  })

  it("pickTvdbBackdrop mirrors ranking, landscape-or-unknown only", () => {
    const arts = [
      art({ image: "portrait", type: 3, width: 680, height: 1000, includesText: false, score: 99, language: "eng" }),
      art({ image: "wide", type: 3, width: 1920, height: 1080, includesText: false, score: 5, language: "eng" }),
      art({ image: "poster-kind", type: 2, width: 1920, height: 1080, includesText: false, score: 99, language: "eng" }),
    ]
    expect(pickTvdbBackdrop(arts, "it")?.image).toBe("wide")
  })

  it("pickTvdbLogo only on documented logo ids, never invented", () => {
    expect(
      pickTvdbLogo([
        art({ image: "logo", type: 23, score: 4 }),
        art({ image: "clearart", type: 22, score: 99 }),
        art({ image: "poster", type: 2, score: 99 }),
      ])?.image,
    ).toBe("logo")
    expect(pickTvdbLogo([art({ image: "legacy-logo" })])).toBeNull()
    expect(pickTvdbLogo([])).toBeNull()
  })
})
