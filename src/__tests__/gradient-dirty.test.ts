import { describe, expect, it } from "vitest"
import { isGradientDirty, type GradientTuning } from "@/lib/gradient-dirty"
import type { Mapping } from "@/lib/types"

const DEFAULTS: GradientTuning = {
  gradientHeight: 30,
  blurEnabled: true,
  blurIntensity: 20,
  blurFade: 50,
  blurDarkness: 30,
  tintStrength: 20,
  topShade: 50,
}

const mapping = (partial: Partial<Mapping> = {}): Mapping => ({
  tmdbId: 1, mediaType: "movie", title: "T", posterPath: "/p.jpg",
  logoPath: null, originalPosterPath: null, language: null, updatedAt: "2026-01-01",
  ...partial,
})

describe("isGradientDirty", () => {
  it("false quando lo stato corrente coincide coi default (titolo mai salvato)", () => {
    expect(isGradientDirty({ ...DEFAULTS }, null, DEFAULTS, "poster")).toBe(false)
    expect(isGradientDirty({ ...DEFAULTS }, undefined, DEFAULTS, "poster")).toBe(false)
  })

  it("true quando un preset/slider muove un solo campo", () => {
    expect(isGradientDirty({ ...DEFAULTS, blurFade: 60 }, null, DEFAULTS, "poster")).toBe(true)
    expect(isGradientDirty({ ...DEFAULTS, topShade: 0 }, null, DEFAULTS, "poster")).toBe(true)
    expect(isGradientDirty({ ...DEFAULTS, blurEnabled: false }, null, DEFAULTS, "poster")).toBe(true)
  })

  it("false quando corrente e mapping congelato coincidono", () => {
    const m = mapping({ gradientHeight: 40, blurIntensity: 20, blurFade: 60, blurDarkness: 0, tintStrength: 100, topShade: 70, blurEnabled: true })
    expect(isGradientDirty(
      { gradientHeight: 40, blurEnabled: true, blurIntensity: 20, blurFade: 60, blurDarkness: 0, tintStrength: 100, topShade: 70 },
      m, DEFAULTS, "poster",
    )).toBe(false)
  })

  it("i null del mapping ricadono sui default (mai falsi positivi)", () => {
    const m = mapping({ gradientHeight: null, blurFade: null, topShade: null })
    expect(isGradientDirty({ ...DEFAULTS }, m, DEFAULTS, "poster")).toBe(false)
    expect(isGradientDirty({ ...DEFAULTS, blurFade: 60 }, m, DEFAULTS, "poster")).toBe(true)
  })

  it("rispetta il profilo landscape del mapping", () => {
    const m = mapping({
      posterShape: "landscape",
      blurFade: 10,
      landscape: { blurFade: 70, gradientHeight: null, blurEnabled: null, blurIntensity: null, blurDarkness: null },
    })
    // Profilo orizzontale: fade 70 effettivo, non il flat 10.
    expect(isGradientDirty({ ...DEFAULTS, blurFade: 70 }, m, DEFAULTS, "poster")).toBe(false)
    expect(isGradientDirty({ ...DEFAULTS, blurFade: 10 }, m, DEFAULTS, "poster")).toBe(true)
  })
})
