/**
 * Effective-accent server→client integration (Stage 2 evidence): the hexes
 * reported by the REAL render pipeline (`generatePosterBuffer` +
 * `onAccentMeta`, solver and renderers never mocked) travel through the REAL
 * wire shape (`{status:'ready', ...meta}` as served by `?accentmeta=1`) and
 * the shared validator, and resolve to the IDENTICAL picker hex the editor
 * displays — cyan/yellow/TheBoys fixtures, portrait AND landscape, with the
 * localized top reference differing by top kind (rank vs extra).
 */
import { describe, it, expect, beforeEach } from "vitest"
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
import { generatePosterBuffer, type GenerationInput } from "@/lib/poster-service"
import {
  sanitizeEffectiveAccentMeta,
  type EffectiveAccentMeta,
} from "@/lib/effective-accent"
import { resolveAccentPickerDisplay } from "@/lib/useEffectiveAccent"
import type { WikidataResult } from "@/lib/awards"
import type { ServerDefaults } from "@/lib/server-defaults"

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

function hslL(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2
}

beforeEach(() => {
  clearRegionStatsCache()
})

const FIXTURES = [
  { name: "yellow", base: { r: 232, g: 200, b: 60 } },
  { name: "cyan", base: { r: 0, g: 200, b: 220 } },
  { name: "boys", base: { r: 78, g: 128, b: 135 } },
] as const

describe("service meta → wire → picker hex (identical, both shapes)", () => {
  for (const { name, base } of FIXTURES) {
    for (const shape of ["poster", "landscape"] as const) {
      it(`${name} ${shape}: same generation input → identical metadata → identical picker hex`, async () => {
        const w = shape === "landscape" ? LAND_W : STD_W
        const h = shape === "landscape" ? LAND_H : STD_H
        const scene = await mockScene(w, h, base)
        async function renderOnce(tag: string): Promise<EffectiveAccentMeta> {
          const metas: EffectiveAccentMeta[] = []
          await generatePosterBuffer({
            ...baseInput({
              posterBuf: scene,
              shape,
              badgeStyle: "colored",
              extraBadgeStyle: "colored",
              analysisKey: `eff-int-${name}-${shape}-${tag}`,
            }),
            onAccentMeta: (m) => metas.push(m),
          })
          expect(metas).toHaveLength(1)
          return metas[0]!
        }
        const first = await renderOnce("a")
        const second = await renderOnce("b")
        // Same active poster generation: deterministic identical metadata.
        expect(second).toEqual(first)
        // Through the REAL wire shape the route serves ({status + meta}).
        const wire = JSON.parse(JSON.stringify({ status: "ready", ...first })) as Record<string, unknown>
        delete wire.status
        const clean = sanitizeEffectiveAccentMeta(wire)
        expect(clean).toEqual(first)
        // Identical resulting picker hex (bottom default), top labeled.
        const display = resolveAccentPickerDisplay(clean)
        expect(display.pickerHex).toBe(first.genreHex)
        expect(display.bottomHex).toBe(first.genreHex)
        expect(display.topHex).toBe(first.rankHex)
        // Independent solver cross-check (same extraction path, no mocks).
        const tint = await extractSceneTint(scene, "Comedy", null)
        const [top, bottom] = await Promise.all([
          topBandMeanRGB(scene, { cacheKey: null, canvasW: w, canvasH: h }),
          bottomBandMeanRGB(scene, { cacheKey: null, canvasW: w, canvasH: h }),
        ])
        expect(first.genreHex).toBe(
          adaptiveAccentHexForBand(tint, GENRE_FALLBACK["Comedy"], effectiveBottomBackgroundLuminance(bottom!, 0, false)),
        )
        expect(first.rankHex).toBe(
          adaptiveAccentHexForBand(tint, "#555555", effectiveTopBackgroundLuminance(top!, 80)),
        )
      }, 60000)
    }
  }

  it("boys: near-anchor tint is legitimate in both shapes (never forced brighter)", async () => {
    for (const shape of ["poster", "landscape"] as const) {
      const w = shape === "landscape" ? LAND_W : STD_W
      const h = shape === "landscape" ? LAND_H : STD_H
      const scene = await mockScene(w, h, { r: 78, g: 128, b: 135 })
      const metas: EffectiveAccentMeta[] = []
      await generatePosterBuffer({
        ...baseInput({
          posterBuf: scene,
          shape,
          badgeStyle: "colored",
          extraBadgeStyle: "colored",
          analysisKey: `eff-int-boys-${shape}`,
        }),
        onAccentMeta: (m) => metas.push(m),
      })
      const meta = metas[0]!
      // Natural variation, not user brightening: the reported hexes are
      // extractions (not the fallback anchor) and the picker shows the
      // bottom one verbatim.
      expect(meta.provGenre).toBe("extracted")
      expect(meta.provRank).toBe("extracted")
      expect(meta.genreHex).not.toBe(GENRE_FALLBACK["Comedy"])
      for (const hex of [meta.genreHex!, meta.rankHex!]) {
        // The solver keeps hue/saturation in bounds; lightness may sit at the
        // anchor — the picker shows it verbatim. Windows native dialogs read
        // HSL L on the 0..240 user scale (NOT percent): #4e8087 → ≈100.
        // (Prior report mislabeled the percent value L42 as Windows.)
        expect(Math.round(hslL(hex) * 240)).toBeGreaterThan(0)
        expect(Math.round(hslL(hex) * 240)).toBeLessThanOrEqual(240)
      }
      expect(resolveAccentPickerDisplay(meta).pickerHex).toBe(meta.genreHex)
    }
  }, 60000)

  it("landscape rank painter: top kind rank resolves its own label input", async () => {
    const scene = await mockScene(LAND_W, LAND_H, { r: 0, g: 200, b: 220 })
    const metas: EffectiveAccentMeta[] = []
    await generatePosterBuffer({
      ...baseInput({
        posterBuf: scene,
        shape: "landscape",
        badgeStyle: "shadow",
        rankingBadgeStyle: "colored",
        queryExtra: null,
        finalRank: 3,
        analysisKey: "eff-int-rank-land",
      }),
      onAccentMeta: (m) => metas.push(m),
    })
    const meta = metas[0]!
    // Rank-colored top paints; genre shadow does not: picker falls back to
    // the top hex with the rank (not extra) reference.
    expect(meta.topPaints).toBe(true)
    expect(meta.topType).toBe("rank")
    expect(meta.genrePaints).toBe(false)
    const display = resolveAccentPickerDisplay(meta)
    expect(display.pickerHex).toBe(meta.rankHex)
    expect(display.bottomHex).toBeNull()
  }, 60000)
})
