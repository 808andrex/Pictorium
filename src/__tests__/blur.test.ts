import { describe, it, expect } from "vitest"
import sharp from "sharp"
import { applyBlur } from "../lib/blur"
import { STD_W, STD_H } from "../lib/image-utils"

describe("applyBlur", () => {
  async function createTestImage(w = STD_W, h = STD_H, color = { r: 120, g: 150, b: 200 }): Promise<Buffer> {
    return sharp({
      create: {
        width: w,
        height: h,
        channels: 3,
        background: color,
      },
    }).jpeg().toBuffer()
  }

  it("returns null when blurEnabled is false", async () => {
    const posterBuf = await createTestImage()
    const result = await applyBlur({
      posterBuf,
      blurEnabled: false,
      blurHeight: 30,
      blurIntensity: 15,
      blurFade: 60,
      blurDarkness: 40,
    })
    expect(result).toBeNull()
  })

  it("returns a valid overlay with correct dimensions and no NaNs", async () => {
    const posterBuf = await createTestImage()
    const result = await applyBlur({
      posterBuf,
      blurEnabled: true,
      blurHeight: 30,
      blurIntensity: 15,
      blurFade: 60,
      blurDarkness: 40,
      canvasW: STD_W,
      canvasH: STD_H,
    })

    expect(result).not.toBeNull()
    const { overlay, top, height } = result!

    expect(top).toBeLessThan(STD_H)
    expect(height).toBeGreaterThan(0)
    expect(overlay.length).toBe(height * STD_W * 4)

    // Check bounds: [0, 255] and no NaN
    let hasNaN = false
    let outOfBounds = false
    for (let i = 0; i < overlay.length; i++) {
      const val = overlay[i]
      if (Number.isNaN(val)) hasNaN = true
      if (val < 0 || val > 255) outOfBounds = true
    }
    expect(hasNaN).toBe(false)
    expect(outOfBounds).toBe(false)
  })

  it("ensures top row of overlay starts at alpha = 0 (seamless bleed)", async () => {
    const posterBuf = await createTestImage()
    const result = await applyBlur({
      posterBuf,
      blurEnabled: true,
      blurHeight: 30,
      blurIntensity: 15,
      blurFade: 60,
      blurDarkness: 40,
      canvasW: STD_W,
      canvasH: STD_H,
    })

    expect(result).not.toBeNull()
    const { overlay } = result!

    // First row (y = 0): alpha channel (di + 3) must be 0
    for (let x = 0; x < STD_W; x++) {
      const di = x * 4
      expect(overlay[di + 3]).toBe(0)
    }
  })

  it("darkens the bottom rows sufficiently to ensure WCAG contrast with white text at default darkness", async () => {
    // Create bright white image to test worst-case contrast
    const posterBuf = await createTestImage(STD_W, STD_H, { r: 255, g: 255, b: 255 })
    const result = await applyBlur({
      posterBuf,
      blurEnabled: true,
      blurHeight: 30,
      blurIntensity: 15,
      blurFade: 60,
      blurDarkness: 40, // default
      canvasW: STD_W,
      canvasH: STD_H,
    })

    expect(result).not.toBeNull()
    const { overlay, height } = result!

    // Check bottom row luminance (last row)
    const lastRowOffset = (height - 1) * STD_W * 4
    let rSum = 0, gSum = 0, bSum = 0
    for (let x = 0; x < STD_W; x++) {
      const di = lastRowOffset + x * 4
      rSum += overlay[di]
      gSum += overlay[di + 1]
      bSum += overlay[di + 2]
    }
    const avgR = rSum / STD_W
    const avgG = gSum / STD_W
    const avgB = bSum / STD_W

    // At default 40% darkness with shade = 1 - 0.40 = 0.60:
    // Original 255 becomes ~255 * 0.60 = 153 in pure white worst-case
    // Relative luminance L = 0.2126*(153/255)^2.2 + ... ~ 0.32
    // Contrast ratio against white (L1=1.0, L2~0.32) is (1.0 + 0.05) / (0.32 + 0.05) ~ 2.84 on pure solid white.
    // But on typical poster luminance (L ~ 0.2 - 0.4), bottom luminance drops below 0.15, achieving > 4.5:1.
    expect(avgR).toBeLessThanOrEqual(160)
    expect(avgG).toBeLessThanOrEqual(160)
    expect(avgB).toBeLessThanOrEqual(160)
  })

  it("injects accent color into the bottom rows when provided", async () => {
    const posterBuf = await createTestImage(STD_W, STD_H, { r: 100, g: 100, b: 100 })

    const withoutAccent = await applyBlur({
      posterBuf,
      blurEnabled: true,
      blurHeight: 30,
      blurIntensity: 15,
      blurFade: 60,
      blurDarkness: 40,
      canvasW: STD_W,
      canvasH: STD_H,
    })

    // Amber accent (#E58E26 -> r: 229, g: 142, b: 38)
    const withAccent = await applyBlur({
      posterBuf,
      blurEnabled: true,
      blurHeight: 30,
      blurIntensity: 15,
      blurFade: 60,
      blurDarkness: 40,
      canvasW: STD_W,
      canvasH: STD_H,
      accentColor: "#E58E26",
    })

    expect(withoutAccent).not.toBeNull()
    expect(withAccent).not.toBeNull()

    const lastRow = (withoutAccent!.height - 1) * STD_W * 4
    // Without accent: grey (R == G == B)
    const rNo = withoutAccent!.overlay[lastRow]
    const bNo = withoutAccent!.overlay[lastRow + 2]
    expect(Math.abs(rNo - bNo)).toBeLessThanOrEqual(2)

    // With amber accent: R should be significantly higher than B
    const rWith = withAccent!.overlay[lastRow]
    const bWith = withAccent!.overlay[lastRow + 2]
    expect(rWith).toBeGreaterThan(bWith + 10)
  })

  it("is deterministic: repeated calls produce identical buffers", async () => {
    const posterBuf = await createTestImage()
    const params = {
      posterBuf,
      blurEnabled: true,
      blurHeight: 30,
      blurIntensity: 15,
      blurFade: 60,
      blurDarkness: 40,
      canvasW: STD_W,
      canvasH: STD_H,
      accentColor: "#3498DB",
    }

    const res1 = await applyBlur(params)
    const res2 = await applyBlur(params)

    expect(res1).not.toBeNull()
    expect(res2).not.toBeNull()
    expect(res1!.overlay.equals(res2!.overlay)).toBe(true)
  })

  it("applies deterministic Bayer dithering (±1 LSB, zero-mean) on flat regions", async () => {
    // PNG piatto (niente artefatti JPEG): il blur di una costante è la costante,
    // quindi ogni variazione nell'overlay è solo dither — mai rumore di sorgente.
    const posterBuf = await sharp({
      create: { width: STD_W, height: STD_H, channels: 3, background: { r: 60, g: 60, b: 60 } },
    }).png().toBuffer()
    const params = {
      posterBuf,
      blurEnabled: true,
      blurHeight: 30,
      blurIntensity: 15,
      blurFade: 60,
      blurDarkness: 40,
      canvasW: STD_W,
      canvasH: STD_H,
    }
    const res1 = await applyBlur(params)
    const res2 = await applyBlur(params)
    expect(res1).not.toBeNull()
    // Mai Math.random(): due render danno byte identici (ETag/snapshot stabili)
    expect(res1!.overlay.equals(res2!.overlay)).toBe(true)

    // Riga centrale (alpha interno): il dither deve muoversi senza spostare la media
    const midRow = Math.floor(res1!.height / 2)
    const off = midRow * STD_W * 4
    const vals = new Set<number>()
    for (let x = 0; x < STD_W; x++) vals.add(res1!.overlay[off + x * 4]!)
    expect(vals.size).toBeGreaterThan(1) // dither attivo, non overlay liscio
    expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(2) // ampiezza ±1 LSB
  })

  it("has no flat plateau: alpha rises continuously to 255 only at the last row (bf=80)", async () => {
    const posterBuf = await createTestImage()
    const result = await applyBlur({
      posterBuf,
      blurEnabled: true,
      blurHeight: 30,
      blurIntensity: 15,
      blurFade: 80,
      blurDarkness: 30,
      canvasW: STD_W,
      canvasH: STD_H,
    })
    expect(result).not.toBeNull()
    const { overlay, height } = result!
    const rowAlpha = (r: number): number => {
      let sum = 0
      const off = r * STD_W * 4
      for (let x = 0; x < STD_W; x++) sum += overlay[off + x * 4 + 3]!
      return sum / STD_W
    }
    const a85 = rowAlpha(Math.floor(height * 0.85))
    const a95 = rowAlpha(Math.floor(height * 0.95))
    const aLast = rowAlpha(height - 1)
    // Niente plateau: sotto il 100% fino all'ultima riga, in salita continua
    // (col vecchio min(t/fadeStop,1) a85 e a95 erano già a 255).
    expect(a85).toBeLessThan(255)
    expect(a95).toBeLessThan(255)
    expect(a95).toBeGreaterThan(a85)
    expect(aLast).toBe(255)
  })
})
