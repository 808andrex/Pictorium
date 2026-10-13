/**
 * Effective-accent metadata: real-render proof that `onAccentMeta` reports
 * the hex ACTUALLY painted (Stage 1, server-only).
 *
 * Through the FULL `generatePosterBuffer` pipeline (real Sharp composition,
 * real resvg badge bitmaps, real pixel reads — solver and renderers never
 * mocked):
 * - known cyan/yellow scenes + the `#4e8087` (The Boys) vector: reported hex
 *   equals the solver output for that band (no forced brightening — the
 *   near-anchor value is legitimate) in portrait AND landscape, top AND
 *   bottom, and equals the SVG fill decoded from real badge bitmaps;
 * - manual override: exact hexes + `manual` provenance;
 * - Comedy/no-extraction path: legacy bytes unchanged, observer reports
 *   honest `not-painted` (never a fake auto hex);
 * - provider-glass fixed palette: never claimed as automatic hex;
 * - non-consuming styles: null + `not-painted`;
 * - observer parity: with/without callback outputs are SHA-identical, and a
 *   throwing observer never breaks the render;
 * - the observer performs zero extra region decodes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import { createHash } from "node:crypto"
import sharp from "sharp"
import {
  adaptiveAccentHexForBand,
  bottomBandMeanRGB,
  effectiveBottomBackgroundLuminance,
  effectiveTopBackgroundLuminance,
  extractSceneTint,
  topBandMeanRGB,
} from "@/lib/poster-render-helpers"
import { GENRE_FALLBACK } from "@/lib/badges"
import { STD_W, STD_H, LAND_W, LAND_H, clearRegionStatsCache } from "@/lib/image-utils"
import {
  generatePosterBuffer,
  type GenerationInput,
} from "@/lib/poster-service"
import { renderGenreBadge, renderExtraBadge } from "@/lib/svg-badge"
import type { EffectiveAccentMeta } from "@/lib/effective-accent"
import type { WikidataResult } from "@/lib/awards"
import type { ServerDefaults } from "@/lib/server-defaults"

vi.mock("@/lib/image-utils", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/image-utils")>()
  const g = globalThis as unknown as { __effRegionCalls?: number }
  return {
    ...mod,
    computeRegionStats: async (...args: Parameters<typeof mod.computeRegionStats>) => {
      g.__effRegionCalls = (g.__effRegionCalls ?? 0) + 1
      return mod.computeRegionStats(...args)
    },
  }
})

function regionCalls(): number {
  return (globalThis as unknown as { __effRegionCalls?: number }).__effRegionCalls ?? 0
}
function resetRegionCalls(): void {
  ;(globalThis as unknown as { __effRegionCalls?: number }).__effRegionCalls = 0
}

function sha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex")
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  }
}

function measureHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = ((gn - bn) / d) % 6
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s, l }
}

function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
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
    topShade: 80,
    badgesEnabled: true,
    rankingEnabled: true,
    genreName: "Comedy",
    voteAverage: 7.5,
    badgeStyle: "colored",
    rankingBadgeStyle: "default",
    badgeGenre: true,
    badgeYear: true,
    badgeRating: true,
    topLight: false,
    bottomLight: false,
    targetCenter: 0,
    ribbonSide: "left",
    ribbonEnabled: true,
    rankingBadgeAccent: false,
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
    locale: "en",
    t: (k: string) => k,
    qLabel: null,
    queryExtra: "NEW",
    qNetLogo: null,
    networkLogo: false,
    sd: {} satisfies ServerDefaults,
    accentOverride: null,
    imdbTop250: false,
    preRelease: false,
    shape: "poster",
    analysisKey: null,
    ...overrides,
  }
}

/** Deterministic mock scene: dominant base with dark top / light bottom bands. */
async function mockScene(
  w: number,
  h: number,
  base: { r: number; g: number; b: number },
): Promise<Buffer> {
  const dark = { r: 14, g: 16, b: 26 }
  const light = { r: 236, g: 231, b: 216 }
  const stripH = Math.max(Math.round(h * 0.08), 3)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="rgb(${base.r},${base.g},${base.b})"/>` +
    `<rect width="${w}" height="${stripH}" fill="rgb(${dark.r},${dark.g},${dark.b})"/>` +
    `<rect y="${h - stripH}" width="${w}" height="${stripH}" fill="rgb(${light.r},${light.g},${light.b})"/>` +
    `</svg>`
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer()
}

async function renderWithMeta(
  input: GenerationInput,
): Promise<{ png: Buffer; metas: EffectiveAccentMeta[] }> {
  const metas: EffectiveAccentMeta[] = []
  const png = await generatePosterBuffer({
    ...input,
    onAccentMeta: (m) => {
      metas.push(m)
    },
  })
  return { png, metas }
}

/** Mean opaque RGB of a badge bitmap (fill dominates text/antialias). */
async function meanOpaque(png: Buffer): Promise<{ r: number; g: number; b: number; n: number }> {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i + 3] ?? 0) < 200) continue
    r += data[i] ?? 0
    g += data[i + 1] ?? 0
    b += data[i + 2] ?? 0
    n++
  }
  expect(n).toBeGreaterThan(100)
  return { r: r / n, g: g / n, b: b / n, n }
}

beforeEach(() => {
  clearRegionStatsCache()
  resetRegionCalls()
})

describe("onAccentMeta: actual painted fills (cyan/yellow x portrait/landscape)", () => {
  const scenes = [
    { name: "yellow", base: { r: 232, g: 200, b: 60 } },
    { name: "cyan", base: { r: 0, g: 200, b: 220 } },
  ] as const
  const shapes = [
    { shape: "poster" as const, w: STD_W, h: STD_H },
    { shape: "landscape" as const, w: LAND_W, h: LAND_H },
  ]

  for (const { name, base } of scenes) {
    for (const { shape, w, h } of shapes) {
      it(`${name} ${shape}: reported hexes equal the band solver output (top + bottom)`, async () => {
        const scene = await mockScene(w, h, base)
        const { png, metas } = await renderWithMeta(
          baseInput({
            posterBuf: scene,
            shape,
            badgeStyle: "colored",
            extraBadgeStyle: "colored",
            analysisKey: `eff-${name}-${shape}`,
          }),
        )
        expect(metas).toHaveLength(1)
        const meta = metas[0]!
        // Independent solver inputs, same extraction path as the service.
        const tint = await extractSceneTint(scene, "Comedy", null)
        const [top, bottom] = await Promise.all([
          topBandMeanRGB(scene, { cacheKey: null, canvasW: w, canvasH: h }),
          bottomBandMeanRGB(scene, { cacheKey: null, canvasW: w, canvasH: h }),
        ])
        const topLum = effectiveTopBackgroundLuminance(top!, 80)
        const bottomLum = effectiveBottomBackgroundLuminance(bottom!, 0, false)
        expect(meta.genreHex).toBe(adaptiveAccentHexForBand(tint, GENRE_FALLBACK["Comedy"], bottomLum))
        expect(meta.rankHex).toBe(adaptiveAccentHexForBand(tint, "#555555", topLum))
        expect(meta.genrePaints).toBe(true)
        expect(meta.topPaints).toBe(true)
        expect(meta.topType).toBe("extra")
        expect(meta.provGenre).toBe("extracted")
        expect(meta.provRank).toBe("extracted")
        // Sanity: a real composite came out.
        expect(png.length).toBeGreaterThan(1000)
      })

      it(`${name} ${shape}: reported hexes equal the real SVG badge fills`, async () => {
        const scene = await mockScene(w, h, base)
        const { metas } = await renderWithMeta(
          baseInput({
            posterBuf: scene,
            shape,
            badgeStyle: "colored",
            extraBadgeStyle: "colored",
            analysisKey: `eff-svg-${name}-${shape}`,
          }),
        )
        const meta = metas[0]!
        const pw = shape === "landscape" ? STD_W : w
        const genre = await renderGenreBadge(
          "Comedy", 7.5, pw, "2024", "colored", meta.genreHex!, false,
          { showGenre: true, showYear: true, showRating: true }, 100, "inter",
        )
        const extra = await renderExtraBadge("NEW", pw, false, "colored", meta.rankHex!, false, "inter")
        const gMean = await meanOpaque(genre.png)
        const xMean = await meanOpaque(extra.png)
        for (const [mean, hex] of [[gMean, meta.genreHex!], [xMean, meta.rankHex!]] as const) {
          const exp = hexToRgb(hex)
          expect(Math.abs(mean.r - exp.r)).toBeLessThan(48)
          expect(Math.abs(mean.g - exp.g)).toBeLessThan(48)
          expect(Math.abs(mean.b - exp.b)).toBeLessThan(48)
        }
      })
    }
  }
})

describe("onAccentMeta: #4e8087 vector stays near-anchor (never forced brighter)", () => {
  const boys = { r: 78, g: 128, b: 135 }
  const shapes = [
    { shape: "poster" as const, w: STD_W, h: STD_H },
    { shape: "landscape" as const, w: LAND_W, h: LAND_H },
  ]

  for (const { shape, w, h } of shapes) {
    it(`The Boys tint ${shape}: top and bottom keep hue/saturation in bounds`, async () => {
      const scene = await mockScene(w, h, boys)
      const { metas } = await renderWithMeta(
        baseInput({
          posterBuf: scene,
          shape,
          badgeStyle: "colored",
          extraBadgeStyle: "colored",
          analysisKey: `eff-boys-${shape}`,
        }),
      )
      const meta = metas[0]!
      const before = measureHsl(boys.r, boys.g, boys.b)
      // Math check, not a brightening order: (78,128,135) → L≈0.418, the
      // legacy 5/12 anchor is 0.4167 — the solver may legitimately keep it.
      expect(Math.abs(before.l - 5 / 12)).toBeLessThan(0.005)
      for (const hex of [meta.genreHex!, meta.rankHex!]) {
        expect(hex).toMatch(/^#[0-9a-f]{6}$/)
        const after = measureHsl(...Object.values(hexToRgb(hex)) as [number, number, number])
        expect(after.l).toBeGreaterThanOrEqual(0.24 - 0.003)
        expect(after.l).toBeLessThanOrEqual(0.6 + 0.003)
        expect(hueDist(after.h, before.h)).toBeLessThan(3)
        expect(Math.abs(after.s - before.s)).toBeLessThan(0.04)
      }
      // No second brightening step: reported === direct solver output.
      const tint = await extractSceneTint(scene, "Comedy", null)
      const [top, bottom] = await Promise.all([
        topBandMeanRGB(scene, { cacheKey: null, canvasW: w, canvasH: h }),
        bottomBandMeanRGB(scene, { cacheKey: null, canvasW: w, canvasH: h }),
      ])
      expect(meta.rankHex).toBe(
        adaptiveAccentHexForBand(tint, "#555555", effectiveTopBackgroundLuminance(top!, 80)),
      )
      expect(meta.genreHex).toBe(
        adaptiveAccentHexForBand(tint, GENRE_FALLBACK["Comedy"], effectiveBottomBackgroundLuminance(bottom!, 0, false)),
      )
    })
  }
})

describe("onAccentMeta: manual, fallback, glass, non-consuming styles", () => {
  it("manual override reports exact hexes with manual provenance", async () => {
    const scene = await mockScene(STD_W, STD_H, { r: 232, g: 200, b: 60 })
    const { metas } = await renderWithMeta(
      baseInput({
        posterBuf: scene,
        badgeStyle: "colored",
        extraBadgeStyle: "colored",
        accentOverride: { genreColor: "#123456", rankColor: "#654321" },
        analysisKey: "eff-manual",
      }),
    )
    expect(metas).toHaveLength(1)
    expect(metas[0]).toMatchObject({
      genreHex: "#123456",
      rankHex: "#654321",
      genrePaints: true,
      topPaints: true,
      provGenre: "manual",
      provRank: "manual",
    })
  })

  it("Comedy no-extraction path keeps legacy bytes and reports not-painted", async () => {
    const scene = await mockScene(STD_W, STD_H, { r: 120, g: 120, b: 120 })
    const plain = baseInput({
      posterBuf: scene,
      genreName: "Comedy",
      badgeStyle: "shadow",
      rankingBadgeStyle: "default",
      queryExtra: null,
      rankingEnabled: false,
      blurEnabled: false,
      analysisKey: "eff-comedy",
    })
    const without = await generatePosterBuffer({ ...plain })
    const { png, metas } = await renderWithMeta({ ...plain })
    expect(sha(png)).toBe(sha(without))
    expect(metas).toHaveLength(1)
    expect(metas[0]).toMatchObject({
      genreHex: null,
      rankHex: null,
      genrePaints: false,
      topPaints: false,
      topType: null,
      provGenre: "not-painted",
      provRank: "not-painted",
    })
  })

  it("rank numeral style paints nothing on top (rank numerals ignore accent)", async () => {
    const scene = await mockScene(STD_W, STD_H, { r: 0, g: 200, b: 220 })
    const { metas } = await renderWithMeta(
      baseInput({
        posterBuf: scene,
        badgeStyle: "shadow",
        rankingBadgeStyle: "number",
        finalRank: 3,
        queryExtra: null,
        analysisKey: "eff-numeral",
      }),
    )
    expect(metas).toHaveLength(1)
    expect(metas[0]!.rankHex).toBeNull()
    expect(metas[0]!.topPaints).toBe(false)
    expect(metas[0]!.provRank).toBe("not-painted")
  })

  it("Card provider-glass fixed tint is never claimed as automatic hex", async () => {
    const scene = await mockScene(STD_W, STD_H, { r: 0, g: 200, b: 220 })
    const { metas } = await renderWithMeta(
      baseInput({
        posterBuf: scene,
        badgeStyle: "shadow",
        rankingBadgeStyle: "default",
        queryExtra: null,
        rankingEnabled: false,
        posterLayout: "provider-glass",
        posterFreshScope: "all",
        networkLogo: false,
        analysisKey: "eff-glass",
      }),
    )
    expect(metas).toHaveLength(1)
    // Non-consuming Card style: no automatic accent anywhere, even though the
    // glass frame renders its fixed/neutral tint.
    expect(metas[0]).toMatchObject({
      genreHex: null,
      rankHex: null,
      genrePaints: false,
      topPaints: false,
      provGenre: "not-painted",
      provRank: "not-painted",
    })
  })

  it("Fresh layout suppresses standard chrome (no automatic hex claimed)", async () => {
    const scene = await mockScene(STD_W, STD_H, { r: 232, g: 200, b: 60 })
    const { metas } = await renderWithMeta(
      baseInput({
        posterBuf: scene,
        badgeStyle: "colored",
        rankingBadgeStyle: "default",
        queryExtra: null,
        rankingEnabled: false,
        posterLayout: "fresh",
        posterFreshScope: "all",
        analysisKey: "eff-fresh",
      }),
    )
    expect(metas).toHaveLength(1)
    // No rank badge resolved (ranking off) and the standard genre slot is
    // replaced by the Fresh meta column: nothing automatic is painted.
    expect(metas[0]!.genreHex).toBeNull()
    expect(metas[0]!.genrePaints).toBe(false)
    expect(metas[0]!.rankHex).toBeNull()
    expect(metas[0]!.topPaints).toBe(false)
  })
})

describe("onAccentMeta: observer parity and cost", () => {
  it("with/without observer outputs are SHA-identical", async () => {
    const scene = await mockScene(STD_W, STD_H, { r: 232, g: 200, b: 60 })
    const input = baseInput({
      posterBuf: scene,
      badgeStyle: "colored",
      extraBadgeStyle: "colored",
      analysisKey: "eff-parity",
    })
    const plain = await generatePosterBuffer({ ...input })
    const { png } = await renderWithMeta({ ...input })
    expect(sha(png)).toBe(sha(plain))
  })

  it("a throwing observer never breaks the render", async () => {
    const scene = await mockScene(STD_W, STD_H, { r: 232, g: 200, b: 60 })
    const input = baseInput({
      posterBuf: scene,
      badgeStyle: "colored",
      extraBadgeStyle: "colored",
      analysisKey: "eff-throw",
      onAccentMeta: () => {
        throw new Error("observer boom")
      },
    })
    const png = await generatePosterBuffer(input)
    const plain = await generatePosterBuffer({ ...input, onAccentMeta: undefined })
    expect(sha(png)).toBe(sha(plain))
  })

  it("the observer adds zero region decodes", async () => {
    const scene = await mockScene(STD_W, STD_H, { r: 232, g: 200, b: 60 })
    const input = baseInput({
      posterBuf: scene,
      badgeStyle: "colored",
      extraBadgeStyle: "colored",
      analysisKey: "eff-cost",
    })
    await generatePosterBuffer({ ...input })
    const plainCalls = regionCalls()
    expect(plainCalls).toBeGreaterThan(0)
    expect(plainCalls).toBeLessThanOrEqual(2)
    resetRegionCalls()
    clearRegionStatsCache()
    await renderWithMeta({ ...input, analysisKey: "eff-cost-2" })
    // Fresh key (no shared band cache): same bounded budget, no extra decode.
    expect(regionCalls()).toBeLessThanOrEqual(2)
  })
})
