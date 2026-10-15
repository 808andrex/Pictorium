import { describe, it, expect } from "vitest"
import {
  CLEAN_GRADIENT_HEIGHT,
  NON_CLEAN_GRADIENT_HEIGHT,
  CLEAN_BLUR_FADE,
  NON_CLEAN_BLUR_FADE,
  defaultGradientHeightForPoster,
  defaultBlurFadeForPoster,
} from "@/lib/gradient-defaults"

describe("poster-type defaults (clean vs non-clean)", () => {
  it("clean posters keep the legacy look (tall band, short fade)", () => {
    expect(defaultGradientHeightForPoster({ iso_639_1: null })).toBe(CLEAN_GRADIENT_HEIGHT)
    expect(defaultBlurFadeForPoster({ iso_639_1: null })).toBe(CLEAN_BLUR_FADE)
  })

  it("non-clean posters get a shorter band with a longer fade", () => {
    expect(NON_CLEAN_GRADIENT_HEIGHT).toBe(20)
    expect(NON_CLEAN_BLUR_FADE).toBe(80)
    expect(defaultGradientHeightForPoster({ iso_639_1: "it" })).toBe(20)
    expect(defaultBlurFadeForPoster({ iso_639_1: "en" })).toBe(80)
  })

  it("unknown poster falls back to the non-clean defaults", () => {
    expect(defaultGradientHeightForPoster(null)).toBe(20)
    expect(defaultBlurFadeForPoster(undefined)).toBe(80)
  })
})
