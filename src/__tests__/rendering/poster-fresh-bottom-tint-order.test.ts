/**
 * Fresh bottom tint vs lateral shade layering (bottom COLORED gradient fix).
 *
 * Root cause: the raw bottom blur/tint overlay (`applyBlur`: blurred artwork
 * + darkening + accent tint) composited FIRST in the final layers, so the
 * Fresh lateral black shade (`freshSide`, opaque-ish at the canvas left)
 * painted OVER the accent tint wherever they overlap — the bottom-left tint
 * was blacked out while bottom-right stayed visible.
 *
 * Fix: Fresh + active bottom blur composites the tinted bottom band ABOVE the
 * lateral shade and BELOW the bottom legibility shade + content:
 *   base → strip → sideShade → blurOverlay → bottomShade → numeral/meta/provider/logo.
 * No color intensities changed; blur-off Fresh keeps the legacy combined shade
 * byte-identically; Standard/Card never take the split path.
 *
 * This suite proves the compositing order on deterministic fixtures:
 * - structure: split layers carry the same content buffers/placements as the
 *   legacy overlay (text/logo/badges unobscured, only the shade is divided);
 * - pixels: bottom-left shows the tint (no longer blacked), bottom-right and
 *   upper-left match the legacy render within rounding.
 */
import sharp from "sharp"
import { describe, expect, it } from "vitest"
import { applyBlur } from "@/lib/blur"
import {
  composeFreshOverlay,
  composeFreshOverlaySplit,
  freshGeometry,
  renderFreshBottomShade,
  renderFreshShade,
  renderFreshSideShade,
  type FreshMetaInput,
} from "@/lib/fresh-layout"
import { generatePosterBuffer, type GenerationInput } from "@/lib/poster-service"
import type { WikidataResult } from "@/lib/awards"
import type { ServerDefaults } from "@/lib/server-defaults"
import { LAND_H, LAND_W, STD_H, STD_W } from "@/lib/image-utils"
import type { PosterComposite } from "@/lib/poster-render-helpers"

/** Flat mid-tone artwork (PNG, deterministic): blur output stays flat. */
async function flatBase(w: number, h: number): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 110, g: 140, b: 170 } },
  })
    .png()
    .toBuffer()
}

async function whiteLogo(): Promise<Buffer> {
  return sharp({
    create: { width: 220, height: 100, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .png()
    .toBuffer()
}

async function redProvider(): Promise<Buffer> {
  return sharp({
    create: { width: 300, height: 120, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } },
  })
    .png()
    .toBuffer()
}

function metaInput(overrides: Partial<FreshMetaInput> = {}): FreshMetaInput {
  return {
    badgesEnabled: true,
    badgeGenre: true,
    badgeYear: true,
    badgeRating: true,
    separateRatingsEnabled: false,
    separateRatingsStyle: "column",
    customRatingsEnabled: false,
    genreName: "Dramma",
    year: "2024",
    voteAverage: 8.3,
    separateRatings: undefined,
    customRatings: undefined,
    ...overrides,
  }
}

/**
 * Measurement-only tint settings (test fixture, never shipped defaults): a
 * saturated warm accent at 50% so the "blacked vs visible" delta is
 * unambiguous on the flat bluish base. The implementation changes no
 * intensities — the delta comes purely from layer ORDER.
 */
const TINT = {
  accentColor: "#ff5500",
  tintStrength: 0.5,
  blurHeight: 30,
  blurIntensity: 40,
  blurFade: 50,
  blurDarkness: 40,
}

async function bottomBlur(base: Buffer, CW: number, CH: number) {
  const overlay = await applyBlur({
    posterBuf: base,
    blurEnabled: true,
    blurHeight: TINT.blurHeight,
    blurIntensity: TINT.blurIntensity,
    blurFade: TINT.blurFade,
    blurDarkness: TINT.blurDarkness,
    tintStrength: TINT.tintStrength,
    canvasW: CW,
    canvasH: CH,
    accentColor: TINT.accentColor,
  })
  expect(overlay).not.toBeNull()
  return overlay!
}

function toComposites(layers: readonly PosterComposite[]) {
  return layers.map((l) => ({ input: l.input, left: l.left, top: l.top }))
}

async function pixel(buf: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data } = await sharp(buf)
    .extract({ left: x, top: y, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true })
  return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0]
}

function channelDrift(a: [number, number, number], b: [number, number, number]): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
}

describe("fresh split-shade structure (content preserved)", () => {
  it("ranked: same content buffers/placements, shade divided around the tint slot", async () => {
    for (const [CW, CH] of [[STD_W, STD_H], [LAND_W, LAND_H]] as const) {
      const base = await flatBase(CW, CH)
      const input = {
        posterBuf: base,
        CW,
        CH,
        rank: 7,
        meta: metaInput(),
        logo: { png: await whiteLogo(), w: 220, h: 100 },
        provider: { png: await redProvider(), w: 300, h: 120 },
      }
      const legacy = await composeFreshOverlay(input)
      const split = await composeFreshOverlaySplit(input)
      // Legacy ranked: [strip, shade, numeral, meta, provider, title].
      expect(legacy).toHaveLength(6)
      // Split: below = [strip, side], above = [bottom, numeral, meta, provider, title].
      expect(split.belowBottom).toHaveLength(2)
      expect(split.aboveBottom).toHaveLength(5)
      expect(split.belowBottom[0]!.left).toBe(0)
      expect(split.belowBottom[0]!.top).toBe(0)
      for (const shade of [...split.belowBottom.slice(1), split.aboveBottom[0]!]) {
        expect(shade.left).toBe(0)
        expect(shade.top).toBe(0)
        const meta = await sharp(shade.input).metadata()
        expect(meta.width).toBe(CW)
        expect(meta.height).toBe(CH)
      }
      // Content layers (numeral/meta/provider/title) are untouched: same
      // placement AND same bytes — logos/text/badges render identically.
      const legacyContent = legacy.slice(2)
      const splitContent = split.aboveBottom.slice(1)
      expect(splitContent).toHaveLength(legacyContent.length)
      for (let i = 0; i < legacyContent.length; i++) {
        expect(splitContent[i]!.top).toBe(legacyContent[i]!.top)
        expect(splitContent[i]!.left).toBe(legacyContent[i]!.left)
        expect((splitContent[i]!.input as Buffer).equals(legacyContent[i]!.input as Buffer)).toBe(true)
      }
    }
  }, 180000)

  it("unranked: no strip, shade divided, content preserved", async () => {
    const CW = STD_W
    const CH = STD_H
    const base = await flatBase(CW, CH)
    const input = {
      posterBuf: base,
      CW,
      CH,
      rank: null,
      meta: metaInput(),
      logo: { png: await whiteLogo(), w: 220, h: 100 },
      provider: { png: await redProvider(), w: 300, h: 120 },
    }
    const legacy = await composeFreshOverlay(input)
    const split = await composeFreshOverlaySplit(input)
    // Legacy unranked: [shade, meta, provider, logo].
    expect(legacy).toHaveLength(4)
    expect(split.belowBottom).toHaveLength(1)
    expect(split.aboveBottom).toHaveLength(4)
    const legacyContent = legacy.slice(1)
    const splitContent = split.aboveBottom.slice(1)
    for (let i = 0; i < legacyContent.length; i++) {
      expect(splitContent[i]!.top).toBe(legacyContent[i]!.top)
      expect(splitContent[i]!.left).toBe(legacyContent[i]!.left)
      expect((splitContent[i]!.input as Buffer).equals(legacyContent[i]!.input as Buffer)).toBe(true)
    }
  }, 180000)
})

describe("fresh bottom tint above lateral shade (pixels)", () => {
  it("ranked: bottom-left tint no longer blacked, bottom-right + upper-left preserved", async () => {
    for (const [CW, CH] of [[STD_W, STD_H], [LAND_W, LAND_H]] as const) {
      const base = await flatBase(CW, CH)
      const input = {
        posterBuf: base,
        CW,
        CH,
        rank: 7,
        meta: metaInput(),
        logo: { png: await whiteLogo(), w: 220, h: 100 },
        provider: { png: await redProvider(), w: 300, h: 120 },
      }
      const legacy = await composeFreshOverlay(input)
      const split = await composeFreshOverlaySplit(input)
      const blur = await bottomBlur(base, CW, CH)
      const blurRaw = {
        input: blur.overlay,
        raw: { width: CW, height: blur.height, channels: 4 as const },
        top: blur.top,
        left: 0,
      }
      // Legacy service order: tint FIRST (below everything) + combined shade.
      const oldFull = await sharp(base)
        .composite([blurRaw, ...toComposites(legacy)])
        .png()
        .toBuffer()
      // Fixed service order: strip + side, THEN tint, then bottom + content.
      const newFull = await sharp(base)
        .composite([...toComposites(split.belowBottom), blurRaw, ...toComposites(split.aboveBottom)])
        .png()
        .toBuffer()
      // Reference: tint + bottom legibility only (no lateral shade at all).
      // At the opaque bottom the tint covers everything below it, so the
      // fixed render must match this reference bottom-left.
      const bottomOnly = await sharp(base)
        .composite([blurRaw, ...toComposites(split.aboveBottom.slice(0, 1))])
        .png()
        .toBuffer()

      const bl = { x: 4, y: CH - 8 }
      const br = { x: CW - 5, y: CH - 8 }
      const ul = { x: 4, y: 30 }
      const newBL = await pixel(newFull, bl.x, bl.y)
      const oldBL = await pixel(oldFull, bl.x, bl.y)
      const refBL = await pixel(bottomOnly, bl.x, bl.y)
      console.log(`[tint-order] ${CW}x${CH} BL old=${oldBL} new=${newBL} ref=${refBL}`)
      // Warm accent channel lifts bottom-left well clear of the blacked legacy.
      expect(newBL[0] - oldBL[0]).toBeGreaterThanOrEqual(15)
      // ...landing on the shade-free tinted reference (lateral shade no
      // longer contributes where the tint is opaque).
      expect(channelDrift(newBL, refBL)).toBeLessThanOrEqual(6)
      // Bottom-right never sat under the lateral shade: unchanged.
      const newBR = await pixel(newFull, br.x, br.y)
      const oldBR = await pixel(oldFull, br.x, br.y)
      console.log(`[tint-order] ${CW}x${CH} BR old=${oldBR} new=${newBR}`)
      expect(channelDrift(newBR, oldBR)).toBeLessThanOrEqual(6)
      // Upper-left is above the bottom band (tint has no coverage, bottom
      // shade is transparent there): lateral shade preserved.
      const newUL = await pixel(newFull, ul.x, ul.y)
      const oldUL = await pixel(oldFull, ul.x, ul.y)
      console.log(`[tint-order] ${CW}x${CH} UL old=${oldUL} new=${newUL}`)
      expect(channelDrift(newUL, oldUL)).toBeLessThanOrEqual(6)
    }
  }, 240000)

  it("unranked portrait: bottom-left tint visible without a strip", async () => {
    const CW = STD_W
    const CH = STD_H
    const base = await flatBase(CW, CH)
    const input = {
      posterBuf: base,
      CW,
      CH,
      rank: null,
      meta: metaInput(),
      logo: { png: await whiteLogo(), w: 220, h: 100 },
      provider: null,
    }
    const legacy = await composeFreshOverlay(input)
    const split = await composeFreshOverlaySplit(input)
    const blur = await bottomBlur(base, CW, CH)
    const blurRaw = {
      input: blur.overlay,
      raw: { width: CW, height: blur.height, channels: 4 as const },
      top: blur.top,
      left: 0,
    }
    const oldFull = await sharp(base)
      .composite([blurRaw, ...toComposites(legacy)])
      .png()
      .toBuffer()
    const newFull = await sharp(base)
      .composite([...toComposites(split.belowBottom), blurRaw, ...toComposites(split.aboveBottom)])
      .png()
      .toBuffer()
    const newBL = await pixel(newFull, 4, CH - 8)
    const oldBL = await pixel(oldFull, 4, CH - 8)
    console.log(`[tint-order] unranked BL old=${oldBL} new=${newBL}`)
    expect(newBL[0] - oldBL[0]).toBeGreaterThanOrEqual(15)
  }, 240000)
})

/**
 * Production interleave proof (actual shipped renderer, no second renderer).
 *
 * The pixel suites above recomposite the order manually, so they would stay
 * green if production silently returned to the legacy prepend. This suite
 * calls `generatePosterBuffer` (the shipped pipeline) and intercepts the
 * FINAL sharp composite layers: the raw bottom blur/tint overlay (the only
 * `raw` layer) must sit BETWEEN the split lateral shade (below) and the
 * bottom legibility shade (above) for Fresh + active blur. Legacy prepend
 * puts the raw blur at index 0 with the combined shade — every assertion
 * below fails in that state. Shade identity is by byte equality with the
 * single-source helpers (identification only, never recomposited).
 */
describe("fresh bottom blur production interleave (actual service layer order)", () => {
  type CapturedLayer = {
    input: Buffer
    top?: number
    left?: number
    raw?: { width: number; height: number; channels: number }
  }

  function serviceInput(overrides: Partial<GenerationInput> = {}): GenerationInput {
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
      rankingEnabled: false,
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

  /** Run production once, capturing every sharp composite call; return the FINAL call. */
  async function captureFinalLayers(input: GenerationInput): Promise<CapturedLayer[]> {
    const probe = sharp({ create: { width: 1, height: 1, channels: 3, background: "#000000" } })
    const proto = Object.getPrototypeOf(probe) as { composite: (...args: never[]) => unknown }
    const orig = proto.composite
    const calls: CapturedLayer[][] = []
    proto.composite = function (layers: unknown, ...rest: unknown[]) {
      if (Array.isArray(layers)) calls.push(layers as CapturedLayer[])
      return (orig as (...a: unknown[]) => unknown).call(this, layers, ...rest)
    }
    try {
      await generatePosterBuffer(input)
    } finally {
      proto.composite = orig
      await probe.destroy?.()
    }
    expect(calls.length).toBeGreaterThan(0)
    return calls[calls.length - 1]!
  }

  const isRawBlur = (l: CapturedLayer): boolean => l.raw != null && typeof l.raw.width === "number"

  it("fresh + active blur: raw tint interleaves between side and bottom shades", async () => {
    const CW = STD_W
    const CH = STD_H
    const base = await flatBase(CW, CH)
    const layers = await captureFinalLayers(
      serviceInput({
        posterBuf: base,
        posterLayout: "fresh",
        rankingEnabled: true,
        finalRank: 7,
        blurEnabled: true,
        blurHeight: 30,
        blurIntensity: 40,
        blurFade: 50,
        blurDarkness: 40,
        tintStrength: 20,
      }),
    )
    const rawIdx = layers.findIndex(isRawBlur)
    // Legacy prepend puts the raw blur FIRST: this fails in that state.
    expect(rawIdx).toBeGreaterThan(0)
    // Split-shade identity by bytes (single-source helpers, not a renderer).
    const zoneW = freshGeometry(CW, CH, 7).zoneW
    const sideRef = await renderFreshSideShade(CW, CH, zoneW)
    const bottomRef = await renderFreshBottomShade(CW, CH)
    const combinedRef = await renderFreshShade(CW, CH, zoneW)
    const sideIdx = layers.findIndex(
      (l) => !isRawBlur(l) && Buffer.isBuffer(l.input) && (l.input as Buffer).equals(sideRef),
    )
    const bottomIdx = layers.findIndex(
      (l) => !isRawBlur(l) && Buffer.isBuffer(l.input) && (l.input as Buffer).equals(bottomRef),
    )
    const combinedIdx = layers.findIndex(
      (l) => !isRawBlur(l) && Buffer.isBuffer(l.input) && (l.input as Buffer).equals(combinedRef),
    )
    expect(sideIdx).toBeGreaterThanOrEqual(0)
    expect(bottomIdx).toBeGreaterThanOrEqual(0)
    // Split path only: no combined shade alongside the split halves.
    expect(combinedIdx).toBe(-1)
    // Order: side BELOW the tint, bottom shade immediately ABOVE it.
    expect(sideIdx).toBeLessThan(rawIdx)
    expect(bottomIdx).toBe(rawIdx + 1)
    console.log(`[tint-order-service] fresh+blur raw=${rawIdx} side=${sideIdx} bottom=${bottomIdx} n=${layers.length}`)
  }, 180000)

  it("standard + active blur keeps the legacy prepend (blur first)", async () => {
    const CW = STD_W
    const CH = STD_H
    const base = await flatBase(CW, CH)
    const layers = await captureFinalLayers(
      serviceInput({
        posterBuf: base,
        posterLayout: "standard",
        rankingEnabled: true,
        finalRank: 7,
        blurEnabled: true,
        blurHeight: 30,
        blurIntensity: 40,
        blurFade: 50,
        blurDarkness: 40,
        tintStrength: 20,
      }),
    )
    const rawIdx = layers.findIndex(isRawBlur)
    expect(rawIdx).toBe(0)
    // Standard never takes the split path: neither split half is present.
    const zoneW = freshGeometry(CW, CH, 7).zoneW
    const sideRef = await renderFreshSideShade(CW, CH, zoneW)
    const bottomRef = await renderFreshBottomShade(CW, CH)
    expect(
      layers.some((l) => !isRawBlur(l) && Buffer.isBuffer(l.input) && (l.input as Buffer).equals(sideRef)),
    ).toBe(false)
    expect(
      layers.some((l) => !isRawBlur(l) && Buffer.isBuffer(l.input) && (l.input as Buffer).equals(bottomRef)),
    ).toBe(false)
    console.log(`[tint-order-service] standard+blur raw=${rawIdx} n=${layers.length}`)
  }, 180000)

  it("fresh blur-off keeps the legacy combined shade with no raw overlay", async () => {
    const CW = STD_W
    const CH = STD_H
    const base = await flatBase(CW, CH)
    const layers = await captureFinalLayers(
      serviceInput({
        posterBuf: base,
        posterLayout: "fresh",
        rankingEnabled: true,
        finalRank: 7,
        blurEnabled: false,
      }),
    )
    expect(layers.some(isRawBlur)).toBe(false)
    const zoneW = freshGeometry(CW, CH, 7).zoneW
    const combinedRef = await renderFreshShade(CW, CH, zoneW)
    const sideRef = await renderFreshSideShade(CW, CH, zoneW)
    const bottomRef = await renderFreshBottomShade(CW, CH)
    expect(
      layers.some((l) => Buffer.isBuffer(l.input) && (l.input as Buffer).equals(combinedRef)),
    ).toBe(true)
    expect(
      layers.some((l) => Buffer.isBuffer(l.input) && (l.input as Buffer).equals(sideRef)),
    ).toBe(false)
    expect(
      layers.some((l) => Buffer.isBuffer(l.input) && (l.input as Buffer).equals(bottomRef)),
    ).toBe(false)
    console.log(`[tint-order-service] fresh blur-off n=${layers.length}`)
  }, 180000)
})
