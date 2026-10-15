/**
 * BetterPoster portrait velatura (blurDarkness) 0 -> 30 — user-authorized
 * change. The horizontal recipe stays byte-identical: the shared landscape
 * profile keeps its own numbers, and only the separate universal top-shade
 * default (50) surfaces through the flat inheritance (covered in
 * default-top-shade-50). Every other portrait transform field is unchanged.
 */
import { describe, expect, it } from "vitest"
import { BETTER_POSTER_VISUAL_DEFAULTS } from "@/lib/default-visual-presets"
import { resolveEffectiveLandscape } from "@/lib/visual-presets"

describe("BetterPoster portrait velatura", () => {
  it("darkness is 30; every other portrait transform field is unchanged", () => {
    const v = BETTER_POSTER_VISUAL_DEFAULTS
    expect(v.defaultBlurDarkness).toBe(30)
    expect(v.defaultBlurEnabled).toBe(true)
    expect(v.defaultBlurIntensity).toBe(20)
    expect(v.defaultBlurFade).toBe(10)
    expect(v.defaultTintStrength).toBe(100)
    expect(v.defaultGradientHeight).toBe(35)
    // Only the universal top-shade change also moves the portrait flat.
    expect(v.defaultTopShade).toBe(50)
  })

  it("horizontal recipe is untouched: own landscape profile byte-exact", () => {
    expect(BETTER_POSTER_VISUAL_DEFAULTS.landscape).toEqual({
      gradientHeight: 50,
      blurIntensity: 1,
      blurFade: 100,
      blurDarkness: 100,
      tintStrength: 0,
    })
    // Effective landscape keeps every own number; only top surfaces as 50.
    const eff = resolveEffectiveLandscape(BETTER_POSTER_VISUAL_DEFAULTS)
    expect(eff?.blurDarkness).toBe(100)
    expect(eff?.gradientHeight).toBe(50)
    expect(eff?.blurIntensity).toBe(1)
    expect(eff?.blurFade).toBe(100)
    expect(eff?.tintStrength).toBe(0)
    expect(eff?.topShade).toBe(50)
  })
})
