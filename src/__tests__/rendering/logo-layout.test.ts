import { describe, expect, it } from "vitest"
import { computeLogoBox, computeLogoLayout, computeLogoOffsetBounds, PORTRAIT_LOGO_MAX_HEIGHT_PCT } from "@/lib/logo-layout"

describe("logo layout", () => {
  it("caps wide logos by height with the portrait 25 percent cap", () => {
    const box = computeLogoBox({
      posterW: 1000,
      posterH: 1500,
      logoW: 1000,
      logoH: 500,
      logoScale: 100,
      maxHeightPct: PORTRAIT_LOGO_MAX_HEIGHT_PCT,
    })

    // 1000x500 a scala 100 = 500px h > 375px cap → 750x375.
    expect(box).toEqual({ width: 750, height: 375 })
  })

  it("uses the same uncapped logo size for movement bounds", () => {
    const bounds = computeLogoOffsetBounds({
      posterW: 1000,
      posterH: 1500,
      logoW: 1000,
      logoH: 500,
      logoScale: 100,
      hasBadges: true,
    })

    expect(bounds.minX).toBe(0)
    expect(bounds.maxX).toBe(0)
    expect(bounds.minY).toBe(-850)
    expect(bounds.maxY).toBe(150)
  })

  it("caps square logos by height with maxHeightPct (landscape)", () => {
    // Logo quadrato 1:1 su canvas 16:9: al 55% di larghezza sarebbe
    // 422x422 su 432px di altezza (98%) — il cap 28% lo ferma a 121px.
    const box = computeLogoBox({
      posterW: 768,
      posterH: 432,
      logoW: 800,
      logoH: 800,
      logoScale: 100,
      maxWidthPct: 55,
      maxHeightPct: 28,
    })

    expect(box.height).toBeLessThanOrEqual(Math.round(432 * 0.28))
    expect(box.width).toBe(box.height)
  })

  it("leaves portrait behavior untouched without caps", () => {
    const box = computeLogoBox({
      posterW: 500,
      posterH: 750,
      logoW: 400,
      logoH: 400,
      logoScale: 100,
    })

    expect(box).toEqual({ width: 500, height: 500 })
  })

  it("caps square portrait logos at 25 percent height", () => {
    const box = computeLogoBox({
      posterW: 1000,
      posterH: 1500,
      logoW: 800,
      logoH: 800,
      logoScale: 100,
      maxHeightPct: PORTRAIT_LOGO_MAX_HEIGHT_PCT,
    })

    expect(box.height).toBeLessThanOrEqual(Math.round(1500 * 0.25))
    expect(box.width).toBe(box.height)
  })

  it("anchors left with padX when align is left (Cinematic)", () => {
    const layout = computeLogoLayout({
      posterW: 768,
      posterH: 432,
      logoW: 800,
      logoH: 200,
      logoScale: 100,
      logoOffsetX: 0,
      logoOffsetY: 0,
      hasBadges: true,
      align: "left",
      maxWidthPct: 40,
      maxHeightPct: 24,
    })

    // padX = 36 a 768px; logo 800x200 -> 307x77 entro entrambi i cap.
    expect(layout.left).toBe(36)
    expect(layout.width).toBeLessThanOrEqual(Math.round(768 * 0.4))
    const centered = computeLogoLayout({
      posterW: 768,
      posterH: 432,
      logoW: 800,
      logoH: 200,
      logoScale: 100,
      logoOffsetX: 0,
      logoOffsetY: 0,
      hasBadges: true,
    })
    expect(centered.left).toBe(Math.round((768 - centered.width) / 2))
  })

  it("computes asymmetric X bounds for left align", () => {
    const bounds = computeLogoOffsetBounds({
      posterW: 768,
      posterH: 432,
      logoW: 800,
      logoH: 200,
      logoScale: 100,
      hasBadges: true,
      align: "left",
      maxWidthPct: 40,
      maxHeightPct: 24,
    })

    // minX = -padX (bordo sinistro), maxX = oltre il bordo destro.
    expect(bounds.minX).toBe(-36)
    expect(bounds.maxX).toBe(768 - Math.round(768 * 0.4) - 36)
  })

  it("applies topOffset to logo top position and bounds", () => {
    const base = computeLogoLayout({
      posterW: 768,
      posterH: 432,
      logoW: 800,
      logoH: 200,
      logoScale: 100,
      logoOffsetX: 0,
      logoOffsetY: 0,
      hasBadges: true,
      align: "left",
      maxWidthPct: 40,
      maxHeightPct: 24,
      bottomMarginPct: 25,
    })
    const shifted = computeLogoLayout({
      posterW: 768,
      posterH: 432,
      logoW: 800,
      logoH: 200,
      logoScale: 100,
      logoOffsetX: 0,
      logoOffsetY: 0,
      hasBadges: true,
      align: "left",
      maxWidthPct: 40,
      maxHeightPct: 24,
      bottomMarginPct: 25,
      topOffset: 55,
    })
    expect(shifted.top).toBe(base.top + 55)
  })
})
