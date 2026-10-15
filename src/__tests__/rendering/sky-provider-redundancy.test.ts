/**
 * Sky/NOW provider redundancy (M – Il figlio del secolo):
 * the auto studio badge "Sky" must not render alongside the visibly drawn
 * Sky-family network logo (NOW/Sky/Sky Cinema mark). Sky-family manual custom
 * text, other provider families, awards and ranks are never suppressed by the
 * new predicate; with the logo disabled or missing the Sky badge stays
 * (useful, not redundant). Legacy (non-Sky) suppression is HEAD behavior and
 * stays untouched — including manual custom text matching a legacy provider.
 *
 * Real renderer + real bundled SVGs, no network mocks: TMDB-shaped
 * networks/production for the Sky Original series.
 */
import sharp from "sharp"
import { describe, expect, it } from "vitest"
import { generatePosterBuffer, type GenerationInput } from "@/lib/poster-service"
import { STD_W, STD_H } from "@/lib/poster-render-helpers"
import { LAND_W, LAND_H } from "@/lib/image-utils"
import { matchTMDBStudios } from "@/lib/badge-labels"
import {
  isSkyFamilyName,
  shouldSuppressExtraTopBadgeForNetwork,
} from "@/lib/poster-badge"
import { getNetworkSvgResult } from "@/lib/network-svgs"
import type { WikidataResult } from "@/lib/awards"
import type { ServerDefaults } from "@/lib/server-defaults"

async function darkPoster(w = STD_W, h = STD_H): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: "#101010" } })
    .jpeg()
    .toBuffer()
}

function mInput(overrides: Partial<GenerationInput> = {}): GenerationInput {
  return {
    posterBuf: Buffer.alloc(0),
    logoFetch: null,
    backdropFetch: null,
    backdropScale: 100,
    backdropOffsetX: 0,
    backdropOffsetY: 0,
    blurEnabled: false,
    blurHeight: 50,
    blurIntensity: 10,
    blurFade: 10,
    blurDarkness: 0,
    badgesEnabled: true,
    rankingEnabled: true,
    genreName: "Dramma",
    voteAverage: 8.1,
    badgeStyle: "shadow",
    rankingBadgeStyle: "default",
    badgeGenre: true,
    badgeYear: false,
    badgeRating: true,
    topLight: false,
    targetCenter: 0,
    ribbonSide: "left",
    logoScale: null,
    logoOffsetX: null,
    logoOffsetY: null,
    topBadgeScale: 100,
    topBadgeOffsetX: 0,
    topBadgeOffsetY: 0,
    genreBadgeScale: 100,
    qualityBadgeScale: 100,
    separateBadgeScale: 100,
    networkLogoScale: 100,
    genreBadgeOffsetX: 0,
    genreBadgeOffsetY: 0,
    qualityBadgeOffsetX: 0,
    qualityBadgeOffsetY: 0,
    networkLogoOffsetX: 0,
    networkLogoOffsetY: 0,
    mediaType: "tv",
    finalRank: null,
    animeRankResult: null,
    rankingResult: null,
    mapping: null,
    tmdbNetworks: ["Sky Atlantic"],
    productionCompanies: ["Sky Studios"],
    tmdbStudios: [],
    tvType: null,
    tvStatus: null,
    releaseDate: null,
    firstAirDate: null,
    lastAirDate: null,
    seasonCount: null,
    originCountries: [],
    wikidataResult: { awards: [], nominations: [], studios: ["Sky"], director: null } satisfies WikidataResult,
    tmdbKeywords: [],
    locale: "it",
    t: (k: string) => k,
    qLabel: null,
    queryExtra: null,
    qNetLogo: null,
    networkLogo: true,
    sd: {} satisfies ServerDefaults,
    accentOverride: null,
    imdbTop250: false,
    preRelease: false,
    ...overrides,
  }
}

describe("Sky/NOW source resolution (real code, no mocks)", () => {
  it("matches Sky-family names to the canonical studio badge and logo keys", () => {
    // Studio side: TMDB-shaped names resolve to the "Sky" extra badge label.
    expect(matchTMDBStudios(["Sky Atlantic", "Sky Studios", "NOW"])).toContain("Sky")
    // Logo side: Sky Atlantic and NOW share the bundled NOW mark (key "sky").
    expect(getNetworkSvgResult("Sky Atlantic", 500)?.networkKey).toBe("sky")
    expect(getNetworkSvgResult("NOW", 500)?.networkKey).toBe("sky")
    expect(getNetworkSvgResult("Sky", 500)?.networkKey).toBe("sky")
    // Sky Cinema keeps its own mark but stays in the Sky family.
    expect(getNetworkSvgResult("Sky Cinema", 500)?.networkKey).toBe("sky_cinema")
    // Guards: Skydance and SKY PerfecTV! are NOT Sky EU.
    expect(getNetworkSvgResult("Skydance", 500)?.networkKey).toBe("skydance")
    expect(getNetworkSvgResult("SKY PerfecTV!", 500)).toBeNull()
  })
})

describe("Sky-family decision predicate (pure, no rendering)", () => {
  const skyNow = { networkKey: "sky", matchedName: "NOW" }
  const skyAtlantic = { networkKey: "sky", matchedName: "Sky Atlantic" }
  const skyCinema = { networkKey: "sky_cinema", matchedName: "Sky Cinema" }
  const netflix = { networkKey: "netflix", matchedName: "Netflix" }

  it("names the Sky family narrowly (no substring heuristics)", () => {
    for (const name of ["Sky", "SKY", "Sky Atlantic", "Sky Studios", "Sky Cinema", "NOW", "NOW TV"]) {
      expect(isSkyFamilyName(name), name).toBe(true)
    }
    for (const name of ["Netflix", "Skydance", "SKY PerfecTV!", "Don't Look Now", "Snow", "", null, undefined]) {
      expect(isSkyFamilyName(name), String(name)).toBe(false)
    }
  })

  it("suppresses only the auto Sky extra with a drawn Sky-family logo", () => {
    const auto = { type: "extra" as const, manualOverride: false }
    expect(shouldSuppressExtraTopBadgeForNetwork({ ...auto, label: "Sky", networkLogo: skyNow })).toBe(true)
    expect(shouldSuppressExtraTopBadgeForNetwork({ ...auto, label: "Sky", networkLogo: skyAtlantic })).toBe(true)
    expect(shouldSuppressExtraTopBadgeForNetwork({ ...auto, label: "Sky Cinema", networkLogo: skyNow })).toBe(true)
    expect(shouldSuppressExtraTopBadgeForNetwork({ ...auto, label: "Sky", networkLogo: skyCinema })).toBe(true)
  })

  it("keeps other families, ranks, manual text and missing logos", () => {
    const auto = { type: "extra" as const, manualOverride: false }
    // Different provider family on either side.
    expect(shouldSuppressExtraTopBadgeForNetwork({ ...auto, label: "Netflix", networkLogo: skyNow })).toBe(false)
    expect(shouldSuppressExtraTopBadgeForNetwork({ ...auto, label: "Sky", networkLogo: netflix })).toBe(false)
    // Near-miss names are not the family.
    expect(shouldSuppressExtraTopBadgeForNetwork({ ...auto, label: "Skydance", networkLogo: skyNow })).toBe(false)
    expect(shouldSuppressExtraTopBadgeForNetwork({ ...auto, label: "Sky", networkLogo: null })).toBe(false)
    // Rank badges and awards are never provider-redundant.
    expect(
      shouldSuppressExtraTopBadgeForNetwork({ type: "rank", manualOverride: false, label: "Sky", networkLogo: skyNow }),
    ).toBe(false)
    expect(shouldSuppressExtraTopBadgeForNetwork({ ...auto, label: "Oscar", networkLogo: skyNow })).toBe(false)
    // Manual custom text is never auto-suppressed.
    expect(
      shouldSuppressExtraTopBadgeForNetwork({ type: "extra", manualOverride: true, label: "Sky", networkLogo: skyNow }),
    ).toBe(false)
  })
})

describe("Sky provider redundancy (real renders)", () => {
  it("M portrait: auto Sky badge suppressed with the Sky-family logo drawn", async () => {
    const poster = await darkPoster()
    const withStudio = await generatePosterBuffer(mInput({ posterBuf: poster }))
    const withoutStudio = await generatePosterBuffer(
      mInput({
        posterBuf: poster,
        wikidataResult: { awards: [], nominations: [], studios: [], director: null },
      }),
    )
    expect(withStudio.equals(withoutStudio)).toBe(true)
  }, 120000)

  it("M landscape: same suppression applies (shape-independent decision)", async () => {
    const wide = await darkPoster(LAND_W, LAND_H)
    const withStudio = await generatePosterBuffer(mInput({ posterBuf: wide, shape: "landscape" }))
    const withoutStudio = await generatePosterBuffer(
      mInput({
        posterBuf: wide,
        shape: "landscape",
        wikidataResult: { awards: [], nominations: [], studios: [], director: null },
      }),
    )
    expect(withStudio.equals(withoutStudio)).toBe(true)
  }, 120000)

  it("Sky Cinema logo: same-family Sky badge suppressed too", async () => {
    const poster = await darkPoster()
    const withStudio = await generatePosterBuffer(
      mInput({ posterBuf: poster, tmdbNetworks: ["Sky Cinema"], productionCompanies: [] }),
    )
    const withoutStudio = await generatePosterBuffer(
      mInput({
        posterBuf: poster,
        tmdbNetworks: ["Sky Cinema"],
        productionCompanies: [],
        wikidataResult: { awards: [], nominations: [], studios: [], director: null },
      }),
    )
    expect(withStudio.equals(withoutStudio)).toBe(true)
  }, 120000)

  it("different network unaffected: Sky badge stays next to a Netflix logo", async () => {
    const poster = await darkPoster()
    const withStudio = await generatePosterBuffer(
      mInput({ posterBuf: poster, tmdbNetworks: ["Netflix"], productionCompanies: [] }),
    )
    const withoutStudio = await generatePosterBuffer(
      mInput({
        posterBuf: poster,
        tmdbNetworks: ["Netflix"],
        productionCompanies: [],
        wikidataResult: { awards: [], nominations: [], studios: [], director: null },
      }),
    )
    expect(withStudio.equals(withoutStudio)).toBe(false)
  }, 120000)

  it("logo disabled: Sky badge stays (useful, not redundant)", async () => {
    const poster = await darkPoster()
    const withStudio = await generatePosterBuffer(mInput({ posterBuf: poster, networkLogo: false }))
    const withoutStudio = await generatePosterBuffer(
      mInput({
        posterBuf: poster,
        networkLogo: false,
        wikidataResult: { awards: [], nominations: [], studios: [], director: null },
      }),
    )
    expect(withStudio.equals(withoutStudio)).toBe(false)
  }, 120000)

  it("logo missing (unknown network): Sky badge stays", async () => {
    const poster = await darkPoster()
    const withStudio = await generatePosterBuffer(
      mInput({ posterBuf: poster, tmdbNetworks: ["Some Unknown Network XYZ"], productionCompanies: [] }),
    )
    const withoutStudio = await generatePosterBuffer(
      mInput({
        posterBuf: poster,
        tmdbNetworks: ["Some Unknown Network XYZ"],
        productionCompanies: [],
        wikidataResult: { awards: [], nominations: [], studios: [], director: null },
      }),
    )
    expect(withStudio.equals(withoutStudio)).toBe(false)
  }, 120000)

  it("manual custom text preserved: queryExtra Sky renders even with the logo", async () => {
    const poster = await darkPoster()
    const manual = await generatePosterBuffer(
      mInput({
        posterBuf: poster,
        queryExtra: "Sky",
        wikidataResult: { awards: [], nominations: [], studios: [], director: null },
      }),
    )
    const withoutBadge = await generatePosterBuffer(
      mInput({
        posterBuf: poster,
        wikidataResult: { awards: [], nominations: [], studios: [], director: null },
      }),
    )
    expect(manual.equals(withoutBadge)).toBe(false)
  }, 120000)

  it("rank priority winner untouched by the Sky logo", async () => {
    const poster = await darkPoster()
    const ranked = await generatePosterBuffer(mInput({ posterBuf: poster, finalRank: 3 }))
    const rankedNoStudio = await generatePosterBuffer(
      mInput({
        posterBuf: poster,
        finalRank: 3,
        wikidataResult: { awards: [], nominations: [], studios: [], director: null },
      }),
    )
    // Rank bucket outranks the studio extra with or without the fix: identical.
    expect(ranked.equals(rankedNoStudio)).toBe(true)
  }, 120000)

  it("award badge untouched by the Sky logo", async () => {
    const poster = await darkPoster()
    const awarded = await generatePosterBuffer(
      mInput({
        posterBuf: poster,
        wikidataResult: { awards: ["Oscar"], nominations: [], studios: [], director: null },
      }),
    )
    const plain = await generatePosterBuffer(
      mInput({
        posterBuf: poster,
        wikidataResult: { awards: [], nominations: [], studios: [], director: null },
      }),
    )
    expect(awarded.equals(plain)).toBe(false)
  }, 120000)
})

describe("Legacy provider suppression untouched (HEAD behavior, real renders)", () => {
  it("Sky predicate never fires for legacy names (renderer legacy branch owns them)", () => {
    const auto = { type: "extra" as const, manualOverride: false }
    const netflixLogo = { networkKey: "netflix", matchedName: "Netflix" }
    expect(shouldSuppressExtraTopBadgeForNetwork({ ...auto, label: "Netflix", networkLogo: netflixLogo })).toBe(false)
    expect(shouldSuppressExtraTopBadgeForNetwork({ ...auto, label: "HBO", networkLogo: netflixLogo })).toBe(false)
    expect(
      shouldSuppressExtraTopBadgeForNetwork({ type: "extra", manualOverride: true, label: "Netflix", networkLogo: netflixLogo }),
    ).toBe(false)
  })

  it("manual legacy exact match still suppressed: queryExtra Netflix + Netflix logo renders no badge", async () => {
    const poster = await darkPoster()
    const manual = await generatePosterBuffer(
      mInput({
        posterBuf: poster,
        tmdbNetworks: ["Netflix"],
        productionCompanies: [],
        queryExtra: "Netflix",
        wikidataResult: { awards: [], nominations: [], studios: [], director: null },
      }),
    )
    const withoutBadge = await generatePosterBuffer(
      mInput({
        posterBuf: poster,
        tmdbNetworks: ["Netflix"],
        productionCompanies: [],
        wikidataResult: { awards: [], nominations: [], studios: [], director: null },
      }),
    )
    expect(manual.equals(withoutBadge)).toBe(true)
  }, 120000)

  it("manual legacy network-studio name still suppressed across families: queryExtra HBO + Netflix logo renders no badge", async () => {
    const poster = await darkPoster()
    const manual = await generatePosterBuffer(
      mInput({
        posterBuf: poster,
        tmdbNetworks: ["Netflix"],
        productionCompanies: [],
        queryExtra: "HBO",
        wikidataResult: { awards: [], nominations: [], studios: [], director: null },
      }),
    )
    const withoutBadge = await generatePosterBuffer(
      mInput({
        posterBuf: poster,
        tmdbNetworks: ["Netflix"],
        productionCompanies: [],
        wikidataResult: { awards: [], nominations: [], studios: [], director: null },
      }),
    )
    expect(manual.equals(withoutBadge)).toBe(true)
  }, 120000)

  it("Sky manual text still renders next to the Sky-family logo (no new global manual suppression)", async () => {
    const poster = await darkPoster()
    const manual = await generatePosterBuffer(
      mInput({
        posterBuf: poster,
        queryExtra: "Sky",
        wikidataResult: { awards: [], nominations: [], studios: [], director: null },
      }),
    )
    const withoutBadge = await generatePosterBuffer(
      mInput({
        posterBuf: poster,
        wikidataResult: { awards: [], nominations: [], studios: [], director: null },
      }),
    )
    expect(manual.equals(withoutBadge)).toBe(false)
  }, 120000)
})
