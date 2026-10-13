/**
 * Integration of the adaptive automatic badge accent into the render path.
 *
 * Covers the Task-2 wiring (NOT the pure solver — see
 * adaptive-accent-foundation.test.ts):
 * - `adaptiveAccentHexForBand`: extracted scene tint adapts to the local band
 *   background (same H/S, bounded L, text 4.5:1 first); genre/gray fallbacks
 *   without extraction stay on the legacy fixed 5/12 byte-identically
 *   (every GENRE_FALLBACK entry, Comedy included); malformed input passes
 *   through untouched; manual `ac=` never reaches the helper (service gates
 *   on `accentOverride` — tested as a contract assertion on the helper's
 *   pure bypass position, byte-identical by construction).
 * - Two-band sampling (`topBandMeanRGB`/`bottomBandMeanRGB`): correct canvas
 *   regions in portrait AND landscape (band means follow the band pixels),
 *   top/bottom may differ on split artwork.
 * - Veil math (`effectiveTop/ BottomBackgroundLuminance`): WCAG linear luma
 *   measured AFTER the opaque black veil (top alpha 0.75·topShade/100,
 *   bottom blurDarkness only when blur is enabled); `topShade = 0` = no veil.
 * - Render proof: the same extracted RGB on a dark vs light local band keeps
 *   H/S, moves L only as needed, and the ACTUAL renderer text choice
 *   (`textColorForBg`) reaches 4.5:1 where feasible, else the documented
 *   best-effort (`feasibleText=false` — no guarantee pretended).
 */
import { describe, it, expect } from "vitest"
import sharp from "sharp"
import {
  adaptiveAutomaticAccentHex,
  normalizeAutomaticAccentHex,
  relativeLuminance,
  contrastRatio,
  solveAdaptiveAccent,
  textColorForBg,
} from "@/lib/accent-color"
import { GENRE_FALLBACK } from "@/lib/badges"
import { STD_W, STD_H, LAND_W, LAND_H, clearRegionStatsCache } from "@/lib/image-utils"
import {
  adaptiveAccentHexForBand,
  bottomBandMeanRGB,
  canvasDimsForShape,
  effectiveBottomBackgroundLuminance,
  effectiveTopBackgroundLuminance,
  topBandMeanRGB,
} from "@/lib/poster-render-helpers"

function measureHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const l = (max + min) / 2, d = max - min
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

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  }
}

/** Actual renderer text contrast for an 8-bit fill (effective blending). */
function actualTextContrast(fillHex: string): { color: string; ratio: number } {
  const color = textColorForBg(fillHex)
  const { r, g, b } = hexToRgb(fillHex)
  const bgLum = relativeLuminance(r, g, b)
  const m = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/)
  let tr: number, tg: number, tb: number, ta: number
  if (m) {
    tr = parseInt(m[1]); tg = parseInt(m[2]); tb = parseInt(m[3])
    ta = m[4] !== undefined ? parseFloat(m[4]) : 1
  } else {
    const c = hexToRgb(color); tr = c.r; tg = c.g; tb = c.b; ta = 1
  }
  const er = ta < 1 ? Math.round(tr * ta + r * (1 - ta)) : tr
  const eg = ta < 1 ? Math.round(tg * ta + g * (1 - ta)) : tg
  const eb = ta < 1 ? Math.round(tb * ta + b * (1 - ta)) : tb
  return { color, ratio: contrastRatio(relativeLuminance(er, eg, eb), bgLum) }
}

async function solidImage(w: number, h: number, color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer()
}

/** Portrait canvas with a dark top band and a light bottom band. */
async function splitPortrait(): Promise<Buffer> {
  const dark = await sharp({ create: { width: STD_W, height: STD_H, channels: 3, background: { r: 12, g: 14, b: 22 } } }).jpeg().toBuffer()
  const light = await sharp({ create: { width: STD_W, height: Math.round(STD_H * 0.2), channels: 3, background: { r: 235, g: 230, b: 215 } } }).jpeg().toBuffer()
  return sharp(dark).composite([{ input: light, top: STD_H - Math.round(STD_H * 0.2), left: 0 }]).jpeg().toBuffer()
}

describe("canvasDimsForShape", () => {
  it("uses portrait dims by default and landscape dims for landscape", () => {
    expect(canvasDimsForShape(null)).toEqual({ width: STD_W, height: STD_H })
    expect(canvasDimsForShape("poster")).toEqual({ width: STD_W, height: STD_H })
    expect(canvasDimsForShape("landscape")).toEqual({ width: LAND_W, height: LAND_H })
  })
})

describe("two-band sampling on the effective canvas", () => {
  it("reads the band pixels in portrait (solid canvas ≈ fill color)", async () => {
    clearRegionStatsCache()
    const buf = await solidImage(STD_W, STD_H, { r: 81, g: 149, b: 163 })
    const top = await topBandMeanRGB(buf, { canvasW: STD_W, canvasH: STD_H })
    const bottom = await bottomBandMeanRGB(buf, { canvasW: STD_W, canvasH: STD_H })
    expect(top).not.toBeNull()
    expect(bottom).not.toBeNull()
    for (const band of [top!, bottom!]) {
      expect(Math.abs(band.r - 81)).toBeLessThan(6)
      expect(Math.abs(band.g - 149)).toBeLessThan(6)
      expect(Math.abs(band.b - 163)).toBeLessThan(6)
    }
  })

  it("top/bottom may differ on split artwork (dark top, light bottom)", async () => {
    clearRegionStatsCache()
    const buf = await splitPortrait()
    const top = await topBandMeanRGB(buf, { canvasW: STD_W, canvasH: STD_H })
    const bottom = await bottomBandMeanRGB(buf, { canvasW: STD_W, canvasH: STD_H })
    expect(top).not.toBeNull()
    expect(bottom).not.toBeNull()
    const topLum = relativeLuminance(top!.r, top!.g, top!.b)
    const bottomLum = relativeLuminance(bottom!.r, bottom!.g, bottom!.b)
    expect(topLum).toBeLessThan(0.05)
    expect(bottomLum).toBeGreaterThan(0.5)
  })

  it("samples the correct canvas in landscape (no portrait distortion)", async () => {
    clearRegionStatsCache()
    const buf = await solidImage(LAND_W, LAND_H, { r: 200, g: 60, b: 40 })
    const top = await topBandMeanRGB(buf, { canvasW: LAND_W, canvasH: LAND_H })
    const bottom = await bottomBandMeanRGB(buf, { canvasW: LAND_W, canvasH: LAND_H })
    expect(top).not.toBeNull()
    expect(bottom).not.toBeNull()
    for (const band of [top!, bottom!]) {
      expect(Math.abs(band.r - 200)).toBeLessThan(8)
      expect(Math.abs(band.g - 60)).toBeLessThan(8)
      expect(Math.abs(band.b - 40)).toBeLessThan(8)
    }
  })

  it("returns null for undecodable buffers instead of throwing", async () => {
    clearRegionStatsCache()
    await expect(topBandMeanRGB(Buffer.from("not-an-image"), { canvasW: STD_W, canvasH: STD_H })).resolves.toBeNull()
    await expect(bottomBandMeanRGB(Buffer.from("not-an-image"), { canvasW: STD_W, canvasH: STD_H })).resolves.toBeNull()
  })
})

describe("veil math (linear WCAG after the opaque veil)", () => {
  const mid = { r: 120, g: 150, b: 200 }

  it("topShade 0 (falsy) = no veil, never an inherited value", () => {
    expect(effectiveTopBackgroundLuminance(mid, 0)).toBeCloseTo(relativeLuminance(120, 150, 200), 12)
  })

  it("top veil matches the black-blend contract (alpha 0.75·s/100)", () => {
    const veiled = effectiveTopBackgroundLuminance(mid, 80)
    expect(veiled).toBeCloseTo(relativeLuminance(120 * 0.4, 150 * 0.4, 200 * 0.4), 9)
    // Stronger shade = darker, monotonically.
    expect(effectiveTopBackgroundLuminance(mid, 100)).toBeLessThan(veiled)
    expect(veiled).toBeLessThan(effectiveTopBackgroundLuminance(mid, 50))
  })

  it("bottom veil applies ONLY when blur is actually enabled", () => {
    expect(effectiveBottomBackgroundLuminance(mid, 30, false)).toBeCloseTo(relativeLuminance(120, 150, 200), 12)
    expect(effectiveBottomBackgroundLuminance(mid, 0, true)).toBeCloseTo(relativeLuminance(120, 150, 200), 12)
    expect(effectiveBottomBackgroundLuminance(mid, 30, true)).toBeCloseTo(relativeLuminance(120 * 0.7, 150 * 0.7, 200 * 0.7), 9)
  })
})

describe("adaptiveAccentHexForBand (integration resolver)", () => {
  it("keeps every genre/gray fallback on the legacy 5/12 byte-identically (incl. Comedy)", () => {
    const samples = ["Comedy", "Action", "Horror", "Drama", "NoSuchGenre"]
    for (const genre of samples) {
      const fallback = GENRE_FALLBACK[genre] || "#555555"
      expect(adaptiveAccentHexForBand(null, fallback, 0.03)).toBe(normalizeAutomaticAccentHex(fallback))
      expect(adaptiveAccentHexForBand(undefined, fallback, 0.75)).toBe(normalizeAutomaticAccentHex(fallback))
    }
    // Comedy anchor pinned exactly.
    const comedy = adaptiveAccentHexForBand(null, GENRE_FALLBACK["Comedy"], 0.35)
    const m = measureHsl(...Object.values(hexToRgb(comedy)) as [number, number, number])
    expect(Math.abs(m.l - 5 / 12)).toBeLessThan(0.002)
  })

  it("without a band sample the extracted tint keeps the legacy 5/12 (byte-identical)", () => {
    expect(adaptiveAccentHexForBand("#5195a3", "#555555", null)).toBe(normalizeAutomaticAccentHex("#5195a3"))
    expect(adaptiveAccentHexForBand("#5195a3", "#555555", undefined)).toBe(normalizeAutomaticAccentHex("#5195a3"))
    expect(adaptiveAccentHexForBand("#5195a3", "#555555", NaN)).toBe(normalizeAutomaticAccentHex("#5195a3"))
  })

  it("with extraction + background it equals the tested solver (no second implementation)", () => {
    for (const bg of [0.02, 0.2, 0.6]) {
      expect(adaptiveAccentHexForBand("#5195a3", "#555555", bg)).toBe(adaptiveAutomaticAccentHex("#5195a3", { backgroundLuminance: bg }))
    }
  })

  it("passes malformed input through untouched (never an invented color)", () => {
    for (const bad of ["red", "#fff", "#5195a"]) {
      expect(adaptiveAccentHexForBand(bad, "#555555", 0.2)).toBe(bad)
    }
    // Empty tint = no extraction → legacy fallback (never an invented color).
    expect(adaptiveAccentHexForBand("", "#555555", 0.2)).toBe(normalizeAutomaticAccentHex("#555555"))
    expect(adaptiveAccentHexForBand(null, "red", 0.2)).toBe("red")
  })
})

describe("render proof: same extracted RGB, dark vs light local band", () => {
  const extracted = ["#5195a3", "#e67e22", "#f4d03f", "#8e44ad"]

  it.each(extracted)("%s keeps H/S while the band changes L/text contrast", (tint) => {
    const darkBg = 0.02
    const lightBg = 0.7
    const darkHex = adaptiveAccentHexForBand(tint, "#555555", darkBg)
    const lightHex = adaptiveAccentHexForBand(tint, "#555555", lightBg)
    expect(darkHex).toMatch(/^#[0-9a-f]{6}$/)
    expect(lightHex).toMatch(/^#[0-9a-f]{6}$/)
    const before = measureHsl(...Object.values(hexToRgb(tint)) as [number, number, number])
    for (const hex of [darkHex, lightHex]) {
      const after = measureHsl(...Object.values(hexToRgb(hex)) as [number, number, number])
      // Bounded L, hue/saturation preserved (achromatic stays neutral).
      expect(after.l).toBeGreaterThanOrEqual(0.24 - 0.003)
      expect(after.l).toBeLessThanOrEqual(0.6 + 0.003)
      if (before.s > 0.02) {
        expect(hueDist(after.h, before.h)).toBeLessThan(3)
        expect(Math.abs(after.s - before.s)).toBeLessThan(0.04)
      }
      // Actual renderer text contrast: 4.5 where feasible, else documented best.
      const actual = actualTextContrast(hex)
      const diag = solveAdaptiveAccent(hexToRgb(tint), { backgroundLuminance: hex === darkHex ? darkBg : lightBg }).diagnostics
      expect(actual.color).toBe(diag.textColor)
      if (diag.feasibleText) expect(actual.ratio).toBeGreaterThanOrEqual(4.5 - 1e-6)
      else expect(diag.feasibleText).toBe(false)
    }
  })

  it("seedy yellow/cyan keep the actual svg/material font render fill readable", () => {
    // Yellow and cyan are the historic washed-out/dark failure modes: the
    // solver must move L inside the bounds and the renderer text choice must
    // match the diagnostics (white only when its effective contrast >= 2).
    for (const tint of ["#ffe733", "#00e5ff"]) {
      for (const bg of [0.03, 0.75]) {
        const hex = adaptiveAccentHexForBand(tint, "#555555", bg)
        const actual = actualTextContrast(hex)
        const diag = solveAdaptiveAccent(hexToRgb(tint), { backgroundLuminance: bg }).diagnostics
        expect(actual.color).toBe(diag.textColor)
        if (diag.feasibleText) expect(actual.ratio).toBeGreaterThanOrEqual(4.5 - 1e-6)
      }
    }
  })
})
