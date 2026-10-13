/**
 * Provider-glass FIXED brand palette (no pixel sampling).
 *
 * Contract under test:
 * - the 8 approved brand colors resolve EXACTLY by canonical brand identity
 *   (`networkKey` from the existing resolver — same priority as the drawn
 *   logo, no new matcher): Netflix #E50914, Prime Video #00A8E1, Disney+
 *   #176BCA, HBO/Max #7138E8, Apple TV #A8ADB5, Paramount+ #0064FF,
 *   Crunchyroll #F47521, NOW/Sky #00D98B;
 * - unlisted/missing providers (including TMDB fallbacks for unknown
 *   networks) render the dedicated neutral #707780 — irrespective of logo
 *   pixels (white/monochrome/vibrant marks never leak into the glass);
 * - an explicit manual accent (`ac=`/mapping) still wins when valid; an
 *   invalid manual accent is ignored (brand lookup, then neutral);
 * - the lookup NEVER samples pixels: it takes a brand key, not a bitmap
 *   (synchronous, no sharp) — even a white or monochrome logo keeps its
 *   fixed brand tint;
 * - only the Card frame/background glass is tinted: the rank numeral stays
 *   neutral crystal, nuvio/stremio/standard/fresh are byte-untouched;
 * - no new query/config/store/fetch/ranking/catalog surface (same params,
 *   same preview URL → same Stremio bytes).
 */
import sharp from "sharp"
import { createHash } from "node:crypto"
import { describe, it, expect } from "vitest"
import {
  PROVIDER_GLASS_BRAND_PALETTE,
  PROVIDER_GLASS_NEUTRAL_ACCENT,
  isProviderGlassBrandKey,
  resolveProviderGlassAccent,
  resolveProviderGlassBrandHex,
} from "@/lib/provider-brand-palette"
import {
  CARD_SKIN_NEUTRAL_ACCENT,
  STREMIO_CARD_SKIN_PALETTE,
  cardSkinBackgroundSvg,
  cardSkinPalette,
  resolveProviderGlassSkinAccent,
} from "@/lib/card-layout-skins"
import { cardNumeralMaterial } from "@/lib/card-layout"
import { cardLayoutGeometry } from "@/lib/card-layout-geometry"
import { generatePosterBuffer, type GenerationInput } from "@/lib/poster-service"
import { STD_H, STD_W, LAND_H, LAND_W } from "@/lib/image-utils"
import type { WikidataResult } from "@/lib/awards"
import type { ServerDefaults } from "@/lib/server-defaults"

function sha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex")
}

async function patternedBase(w: number, h: number): Promise<Buffer> {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><linearGradient id="p" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#3a3f55"/><stop offset="1" stop-color="#141827"/>` +
    `</linearGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#p)"/>` +
    `<rect x="${Math.round(w * 0.55)}" y="0" width="${Math.round(w * 0.45)}" height="${h}" fill="#2e4a7a" opacity="0.85"/>` +
    `<circle cx="${Math.round(w * 0.25)}" cy="${Math.round(h * 0.3)}" r="${Math.round(w * 0.18)}" fill="#7a6a2e" opacity="0.9"/>` +
    `<rect x="0" y="${Math.round(h * 0.7)}" width="${w}" height="${Math.round(h * 0.3)}" fill="#0d0d12" opacity="0.9"/>` +
    `</svg>`
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer()
}

async function whiteLogo(): Promise<Buffer> {
  return sharp({
    create: { width: 220, height: 100, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .png()
    .toBuffer()
}

function baseInput(overrides: Partial<GenerationInput> = {}): GenerationInput {
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
    voteAverage: 8.3,
    badgeStyle: "shadow",
    rankingBadgeStyle: "default",
    badgeGenre: true,
    badgeYear: true,
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
    mediaType: "movie",
    finalRank: null,
    animeRankResult: null,
    rankingResult: null,
    mapping: null,
    tmdbNetworks: [],
    productionCompanies: [],
    tmdbStudios: [],
    tvType: null,
    tvStatus: null,
    releaseDate: "2024-03-10",
    firstAirDate: null,
    lastAirDate: null,
    seasonCount: null,
    originCountries: [],
    wikidataResult: { awards: [], nominations: [], studios: [], director: null } satisfies WikidataResult,
    tmdbKeywords: [],
    locale: "it",
    t: (k: string) => k,
    qLabel: null,
    queryExtra: null,
    qNetLogo: null,
    networkLogo: false,
    sd: {} satisfies ServerDefaults,
    accentOverride: null,
    imdbTop250: false,
    preRelease: false,
    shape: "poster",
    ...overrides,
  }
}

/** Network display name (service candidate) per canonical brand key. */
const BRAND_NAMES: Readonly<Record<string, string>> = {
  netflix: "Netflix",
  prime: "Prime Video",
  disney: "Disney+",
  hbo: "HBO",
  apple: "Apple TV",
  paramount: "Paramount+",
  crunchyroll: "Crunchyroll",
  sky: "NOW",
}

describe("provider-glass fixed palette leaf (no pixels, no fetch)", () => {
  it("maps exactly the 8 approved brand colors", () => {
    expect(PROVIDER_GLASS_BRAND_PALETTE).toEqual({
      netflix: "#E50914",
      prime: "#00A8E1",
      disney: "#176BCA",
      hbo: "#7138E8",
      apple: "#A8ADB5",
      paramount: "#0064FF",
      crunchyroll: "#F47521",
      sky: "#00D98B",
    })
    expect(PROVIDER_GLASS_NEUTRAL_ACCENT).toBe("#707780")
    for (const [key, hex] of Object.entries(PROVIDER_GLASS_BRAND_PALETTE)) {
      expect(resolveProviderGlassBrandHex(key)).toBe(hex)
      expect(isProviderGlassBrandKey(key)).toBe(true)
    }
  })

  it("strict lookup: aliases/malformed/hostile keys never resolve (canonical resolver owns aliasing)", () => {
    // Pre-canonical aliases must NOT resolve here: the existing network
    // resolver already maps Max->hbo, Amazon->prime, NOW/Sky->sky before
    // this lookup ever sees the key. Duplicating matchers would fork identity.
    for (const alias of ["max", "now", "amazon", "sky cinema", "hbo max", "prime video"]) {
      expect(isProviderGlassBrandKey(alias)).toBe(false)
      expect(resolveProviderGlassBrandHex(alias)).toBeNull()
    }
    // Malformed keys: case, whitespace, prefixes, wrong types.
    for (const bad of ["Netflix", "NETFLIX", "netflix ", " netflix", "", " ", "netflix+", "net-flix", "sky_cinema", "mgm_plus", null, undefined, 0, 123, {}, [], "sky\n"]) {
      expect(isProviderGlassBrandKey(bad)).toBe(false)
      expect(resolveProviderGlassBrandHex(bad)).toBeNull()
    }
    // Hostile input cannot inject SVG: it is not a key, so it never reaches
    // any SVG builder (and the skin layer re-validates regardless).
    const evil = '"><script>alert(1)</script>'
    expect(resolveProviderGlassBrandHex(evil)).toBeNull()
    expect(resolveProviderGlassAccent(evil, null)).toBeNull()
  })

  it("manual accent wins when valid; invalid manual falls through to brand/neutral", () => {
    // Valid manual wins even over a known brand (existing public contract).
    expect(
      resolveProviderGlassAccent("netflix", { genreColor: "#00ff00", rankColor: "#00ff00" }),
    ).toBe("#00ff00")
    // Valid manual wins with no brand at all.
    expect(
      resolveProviderGlassAccent(null, { genreColor: "#123456", rankColor: "#123456" }),
    ).toBe("#123456")
    // Invalid manual is ignored: known brand still resolves…
    expect(
      resolveProviderGlassAccent("hbo", { genreColor: "red", rankColor: "red" }),
    ).toBe("#7138E8")
    // …unknown brand with invalid manual stays neutral (null)…
    expect(resolveProviderGlassAccent("some-studio", { genreColor: "red", rankColor: "red" })).toBeNull()
    expect(resolveProviderGlassAccent(null, { genreColor: "#fff", rankColor: "#fff" })).toBeNull()
    expect(resolveProviderGlassAccent(null, { genreColor: "#GGGGGG", rankColor: "#GGGGGG" })).toBeNull()
    expect(resolveProviderGlassAccent(undefined, null)).toBeNull()
    expect(resolveProviderGlassAccent(null, undefined)).toBeNull()
  })

  it("lookup is synchronous and takes a brand key, never a bitmap (cannot sample pixels)", () => {
    const out = resolveProviderGlassAccent("apple", null)
    expect(out).toBe("#A8ADB5")
    // No Promise: zero async pixel work is even possible through this API.
    expect(out).not.toBeInstanceOf(Promise)
    expect(resolveProviderGlassBrandHex("sky")).not.toBeInstanceOf(Promise)
  })
})

describe("provider-glass skin neutral branch (frame only, numeral untouched)", () => {
  it("provider-glass falls back to #707780 (never the generic #555555); other skins unchanged", () => {
    expect(CARD_SKIN_NEUTRAL_ACCENT).toBe("#555555")
    for (const bad of [null, undefined, "", "red", "#fff", "#GGGGGG", 123]) {
      expect(resolveProviderGlassSkinAccent(bad)).toBe("#707780")
    }
    expect(resolveProviderGlassSkinAccent("#e50914")).toBe("#E50914")
    const neutral = cardSkinPalette("provider-glass", null)
    const fromNeutral = cardSkinPalette("provider-glass", "#707780")
    const fromBogus = cardSkinPalette("provider-glass", "bogus")
    expect(neutral).toEqual(fromNeutral)
    expect(neutral).toEqual(fromBogus)
    expect(neutral).not.toEqual(cardSkinPalette("provider-glass", "#E50914"))
    // Generic fallback untouched for every other consumer.
    expect(cardSkinPalette("nuvio", "#E50914")).toBeNull()
    expect(cardSkinPalette("stremio", "#E50914")).toEqual(STREMIO_CARD_SKIN_PALETTE)
    expect(cardSkinPalette("stremio", null)).toEqual(STREMIO_CARD_SKIN_PALETTE)
  })

  it("hostile accent cannot inject SVG through the provider-glass background", () => {
    const svg = cardSkinBackgroundSvg("provider-glass", 380, 570, '"><script>alert(1)</script>')
    expect(svg).not.toBeNull()
    expect(svg).not.toContain("<script>")
    expect(svg).not.toContain("alert(1)")
    // Hostile input falls back to the provider-glass neutral, verbatim.
    expect(svg).toContain(PROVIDER_GLASS_NEUTRAL_ACCENT)
  })

  it("rank numeral stays neutral crystal for any provider-glass accent (numbers never recolored)", () => {
    const geo = cardLayoutGeometry("poster", STD_W, STD_H, 7)!
    const fs = geo.numeral!.fontSize
    const fixed = cardNumeralMaterial("provider-glass", "#E50914", fs)
    expect(fixed).toEqual(cardNumeralMaterial("provider-glass", "#00A8E1", fs))
    expect(fixed).toEqual(cardNumeralMaterial("provider-glass", null, fs))
    expect(fixed.gradientId).toBe("cardNumCrystalStroke")
  })
})

/**
 * Glass-body probe (same gutter block as poster-card-service.test.ts):
 * x 30..70, y 30..70 — inside the glass frame, left of the artwork card,
 * above numeral ink and every badge/mark slot.
 */
async function glassMean(png: Buffer): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const W = info.width
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let y = 30; y < 70; y++) {
    for (let x = 30; x < 70; x++) {
      const o = (y * W + x) * 4
      r += data[o] ?? 0
      g += data[o + 1] ?? 0
      b += data[o + 2] ?? 0
      n++
    }
  }
  return { r: r / n, g: g / n, b: b / n }
}

function expectClose(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
  tol: number,
) {
  expect(Math.abs(a.r - b.r)).toBeLessThan(tol)
  expect(Math.abs(a.g - b.g)).toBeLessThan(tol)
  expect(Math.abs(a.b - b.b)).toBeLessThan(tol)
}

describe("service provider-glass fixed tint (pixel proof, real renders)", () => {
  it("all 8 brands render their exact fixed tint (= manual accent of the same hex, unranked scope-all)", async () => {
    const logo = await whiteLogo()
    const base = await patternedBase(STD_W, STD_H)
    const hashes = new Set<string>()
    for (const [key, hex] of Object.entries(PROVIDER_GLASS_BRAND_PALETTE)) {
      const name = BRAND_NAMES[key]!
      // Recognized brand, no manual accent: fixed palette color by identity.
      const auto = await generatePosterBuffer(
        baseInput({
          posterBuf: base,
          logoFetch: logo,
          posterLayout: "provider-glass",
          posterFreshScope: "all",
          finalRank: null,
          networkLogo: true,
          tmdbNetworks: [name],
        }),
      )
      // Same hex forced manually with NO network: identical glass block.
      // (The full bytes differ by design — the provider mark is absent —
      // so the assertion is pixel-scoped to the frame, not byte-scoped.)
      const manual = await generatePosterBuffer(
        baseInput({
          posterBuf: base,
          logoFetch: logo,
          posterLayout: "provider-glass",
          posterFreshScope: "all",
          finalRank: null,
          accentOverride: { genreColor: hex, rankColor: hex },
        }),
      )
      expectClose(await glassMean(auto), await glassMean(manual), 8)
      hashes.add(sha(auto))
    }
    // All 8 frames differ from each other (intentional per-provider frame).
    expect(hashes.size).toBe(8)
  }, 240000)

  it("NOW resolves through the canonical sky alias; unknown/missing brands share the #707780 neutral", async () => {
    const logo = await whiteLogo()
    const base = await patternedBase(STD_W, STD_H)
    const render = (over: Partial<GenerationInput>) =>
      generatePosterBuffer(
        baseInput({
          posterBuf: base,
          logoFetch: logo,
          posterLayout: "provider-glass",
          posterFreshScope: "all",
          finalRank: null,
          ...over,
        }),
      )
    const now = await render({ networkLogo: true, tmdbNetworks: ["NOW"] })
    const nowManual = await render({
      accentOverride: { genreColor: "#00D98B", rankColor: "#00D98B" },
    })
    expectClose(await glassMean(now), await glassMean(nowManual), 8)
    // Unknown network (no SVG, no TMDB logo): neutral, byte-identical to a
    // missing provider — pixels never invent a brand.
    const unknown = await render({ networkLogo: true, tmdbNetworks: ["Some Unknown Network XYZ"] })
    const missing = await render({})
    const neutralManual = await render({
      accentOverride: { genreColor: "#707780", rankColor: "#707780" },
    })
    expectClose(await glassMean(unknown), await glassMean(missing), 2)
    expectClose(await glassMean(unknown), await glassMean(neutralManual), 8)
    expect(sha(unknown)).toBe(sha(missing))
    expect(sha(now)).not.toBe(sha(missing))
  }, 240000)

  it("ranked portrait + landscape keep the fixed tint and stay distinct from neutral", async () => {
    const logo = await whiteLogo()
    for (const [w, h, shape] of [
      [STD_W, STD_H, "poster"],
      [LAND_W, LAND_H, "landscape"],
    ] as const) {
      const base = await patternedBase(w, h)
      const render = (over: Partial<GenerationInput>) =>
        generatePosterBuffer(
          baseInput({
            posterBuf: base,
            logoFetch: logo,
            shape,
            posterLayout: "provider-glass",
            finalRank: 7,
            ...over,
          }),
        )
      const auto = await render({ networkLogo: true, tmdbNetworks: ["Netflix"] })
      const neutral = await render({})
      const mean = await glassMean(auto)
      // Fixed Netflix #E50914 glass: red-dominant on both shapes.
      expect(mean.r - mean.g).toBeGreaterThan(25)
      expect(mean.r - mean.b).toBeGreaterThan(25)
      const neutralMean = await glassMean(neutral)
      expect(Math.abs(neutralMean.r - neutralMean.g)).toBeLessThan(25)
      expect(Math.abs(neutralMean.r - neutralMean.b)).toBeLessThan(25)
      expect(Math.abs(neutralMean.g - neutralMean.b)).toBeLessThan(25)
      expect(sha(auto)).not.toBe(sha(neutral))
    }
  }, 240000)

  it("manual accent still wins on provider-glass but stays inert on the nuvio/stremio frame", async () => {
    const logo = await whiteLogo()
    const base = await patternedBase(STD_W, STD_H)
    const manual = await generatePosterBuffer(
      baseInput({
        posterBuf: base,
        logoFetch: logo,
        posterLayout: "provider-glass",
        finalRank: 7,
        networkLogo: true,
        tmdbNetworks: ["Netflix"],
        accentOverride: { genreColor: "#00ff00", rankColor: "#00ff00" },
      }),
    )
    const green = await glassMean(manual)
    expect(green.g - green.r).toBeGreaterThan(25)
    expect(green.g - green.b).toBeGreaterThan(25)
    for (const skin of ["nuvio", "stremio"] as const) {
      const mk = (accent: { genreColor: string; rankColor: string } | null) =>
        generatePosterBuffer(
          baseInput({
            posterBuf: base,
            logoFetch: logo,
            posterLayout: skin,
            finalRank: 7,
            networkLogo: true,
            tmdbNetworks: ["Netflix"],
            accentOverride: accent,
          }),
        )
      const a = await glassMean(await mk(null))
      const b = await glassMean(await mk({ genreColor: "#00ff00", rankColor: "#00ff00" }))
      expect(Math.abs(a.r - b.r)).toBeLessThan(8)
      expect(Math.abs(a.g - b.g)).toBeLessThan(8)
      expect(Math.abs(a.b - b.b)).toBeLessThan(8)
    }
  }, 240000)
})
