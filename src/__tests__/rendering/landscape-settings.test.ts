import { describe, expect, it } from "vitest"
import { resolvePosterRenderConfig, type PosterRenderConfigInput } from "@/lib/poster-config"
import { effectiveMappingForShape, type Mapping } from "@/lib/types"
import { mappingSchema } from "@/lib/validation"

const mapping = (partial: Partial<Mapping> = {}): Mapping => ({
  tmdbId: 1, mediaType: "movie", title: "T", posterPath: "/p.jpg",
  logoPath: null, originalPosterPath: null, language: null, updatedAt: "2026-01-01",
  ...partial,
})

function baseInput(overrides: Partial<PosterRenderConfigInput> = {}): PosterRenderConfigInput {
  return {
    searchParams: new URLSearchParams(),
    mapping: null,
    configOverride: null,
    sd: {},
    hasQuery: true,
    showBadges: true,
    rankingBadges: true,
    animeRank: null,
    rankingResult: null,
    finalRank: null,
    ...overrides,
  }
}

describe("effectiveMappingForShape", () => {
  it("returns the same ref for portrait (no copy)", () => {
    const m = mapping({ posterShape: "landscape", landscape: { logoScale: 50 } })
    expect(effectiveMappingForShape(m, "poster")).toBe(m)
  })

  it("returns input for null mapping", () => {
    expect(effectiveMappingForShape(null, "landscape")).toBeNull()
  })

  it("returns the same ref when no landscape profile is saved", () => {
    const m = mapping({ posterShape: "landscape", logoScale: 80 })
    expect(effectiveMappingForShape(m, "landscape")).toBe(m)
  })

  it("overrides per-key with fallback to flat values", () => {
    const m = mapping({
      posterShape: "landscape",
      logoScale: 80, logoOffsetX: 5, gradientHeight: 30, blurEnabled: true,
      landscape: { logoScale: 50, gradientHeight: null },
    })
    const eff = effectiveMappingForShape(m, "landscape")
    expect(eff).not.toBe(m)
    expect(eff?.logoScale).toBe(50)
    expect(eff?.logoOffsetX).toBe(5)
    // null nel profilo = fallback al flat, non ai default
    expect(eff?.gradientHeight).toBe(30)
    expect(eff?.blurEnabled).toBe(true)
    // il mapping originale non è mutato
    expect(m.logoScale).toBe(80)
  })

  it("explicit false (blurEnabled) overrides flat true", () => {
    const m = mapping({ blurEnabled: true, landscape: { blurEnabled: false } })
    expect(effectiveMappingForShape(m, "landscape")?.blurEnabled).toBe(false)
  })
})

describe("landscape validation", () => {
  it("accepts a valid landscape profile", () => {
    const r = mappingSchema.safeParse({
      tmdbId: 1, mediaType: "movie", title: "T", posterPath: "/p.jpg",
      posterShape: "landscape",
      landscape: { logoScale: 50, blurEnabled: false, gradientHeight: 20 },
    })
    expect(r.success).toBe(true)
  })

  it("accepts null/absent landscape", () => {
    expect(mappingSchema.safeParse({
      tmdbId: 1, mediaType: "movie", title: "T", posterPath: "/p.jpg",
    }).success).toBe(true)
    expect(mappingSchema.safeParse({
      tmdbId: 1, mediaType: "movie", title: "T", posterPath: "/p.jpg", landscape: null,
    }).success).toBe(true)
  })

  it("rejects out-of-bound landscape scale (same bounds as flat)", () => {
    const r = mappingSchema.safeParse({
      tmdbId: 1, mediaType: "movie", title: "T", posterPath: "/p.jpg",
      landscape: { logoScale: 500 },
    })
    expect(r.success).toBe(false)
  })
})

describe("backdrop rotation validation", () => {
  it("accepts backdrop rotation fields", () => {
    const r = mappingSchema.safeParse({
      tmdbId: 1, mediaType: "movie", title: "T", posterPath: "/p.jpg",
      cleanBackdrops: ["/a.jpg", "/b.jpg"],
      cleanBackdropIndex: 0,
      cleanBackdropUpdatedAt: "2026-01-01T00:00:00.000Z",
      autoRotateBackdrop: true,
      excludedBackdrops: ["/c.jpg"],
    })
    expect(r.success).toBe(true)
  })

  it("rejects negative backdrop index", () => {
    const r = mappingSchema.safeParse({
      tmdbId: 1, mediaType: "movie", title: "T", posterPath: "/p.jpg",
      cleanBackdropIndex: -1,
    })
    expect(r.success).toBe(false)
  })
})

describe("resolvePosterRenderConfig with landscape profile", () => {
  it("landscape mapping uses landscape tuning, portrait ignores it", () => {
    const m = mapping({
      posterShape: "landscape", logoScale: 80, gradientHeight: 30,
      landscape: { logoScale: 50, gradientHeight: 20 },
    })
    const land = resolvePosterRenderConfig(baseInput({ mapping: m }))
    expect(land.logoScale).toBe(50)
    expect(land.blurHeight).toBe(20)
    const port = resolvePosterRenderConfig(baseInput({
      mapping: m, searchParams: new URLSearchParams({ shape: "poster" }),
    }))
    expect(port.logoScale).toBe(80)
    expect(port.blurHeight).toBe(30)
  })

  it("query beats landscape profile, landscape beats flat", () => {
    const m = mapping({
      posterShape: "landscape", logoScale: 80,
      landscape: { logoScale: 50 },
    })
    const r = resolvePosterRenderConfig(baseInput({
      mapping: m, searchParams: new URLSearchParams({ scale: "60" }),
    }))
    expect(r.logoScale).toBe(60)
  })

  it("missing landscape keys fall back to flat (backward compatible)", () => {
    const m = mapping({ posterShape: "landscape", logoScale: 80 })
    const r = resolvePosterRenderConfig(baseInput({ mapping: m }))
    expect(r.logoScale).toBe(80)
  })
})
