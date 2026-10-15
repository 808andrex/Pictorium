/**
 * Upper-shadow HEIGHT (`tsh` / `topShadeHeight`, % of canvas, default 25) —
 * independent axis alongside the existing strength (`ts` / `topShade`):
 * - shared renderer geometry (`topShadeSVG`) honors 0/default/custom safely;
 * - the full query > mapping > config > defaults chain resolves it (flat,
 *   both canvases; landscape profile included) with fail-closed 25;
 * - preview URLs always carry it, Stremio URLs only when non-default;
 * - per-title + landscape persistence, preset projection, dirty tracking and
 *   cache-key/presets-mode normalization follow the strength wiring;
 * - default visuals are unchanged (omitted == explicit 25; `tsh=0` paints
 *   nothing, exactly like `ts=0`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { topShadeSVG } from "@/lib/badges"
import {
  effectiveTopBackgroundLuminance,
  type BandMeanRGB,
} from "@/lib/poster-render-helpers"
import { relativeLuminance } from "@/lib/accent-color"
import { resolvePosterRenderConfig, type PosterRenderConfigInput } from "@/lib/poster-config"
import { buildDefaultsPreviewUrl, buildPreviewUrl } from "@/lib/poster-url"
import { buildStremioPosterSearchParams } from "@/lib/stremio-poster-params"
import {
  POSTER_CACHE_ALLOWLIST,
  hardenPosterSearchParams,
} from "@/lib/poster-params-hardening"
import { encodeConfig, decodeConfig } from "@/lib/config-token"
import { projectPerTitleVisualPreset } from "@/lib/per-title-preset"
import { isGradientDirtyForShape } from "@/lib/gradient-dirty"
import { effectiveMappingForShape, type Mapping } from "@/lib/types"
import {
  normalizePersonalPreset,
  resolveEffectiveLandscape,
  visualPresetValuesSchema,
  type VisualPresetValues,
} from "@/lib/visual-presets"
import { APPLE_VISUAL_DEFAULTS } from "@/lib/default-visual-presets"
import { quickLookDesired, type QuickLookId } from "@/lib/quick-visual-presets"
import { useDefaults } from "@/lib/useDefaults"
import { resetGuestGuardForTests } from "@/lib/guest-guard"

function baseInput(overrides: Partial<PosterRenderConfigInput> = {}): PosterRenderConfigInput {
  return {
    searchParams: new URLSearchParams(),
    mapping: null,
    configOverride: null,
    sd: {},
    hasQuery: false,
    showBadges: true,
    rankingBadges: true,
    animeRank: null,
    rankingResult: null,
    finalRank: null,
    ...overrides,
  }
}

const mapping = (partial: Partial<Mapping> = {}): Mapping => ({
  tmdbId: 1, mediaType: "movie", title: "T", posterPath: "/p.jpg",
  logoPath: null, originalPosterPath: null, language: null, updatedAt: "2026-01-01",
  ...partial,
})

function rectHeight(svg: string): number {
  const m = svg.match(/<rect width="[^"]+" height="([^"]+)" fill="url\(#tsh\)"\/>/)
  return m ? Number(m[1]) : NaN
}

describe("topShadeSVG height geometry", () => {
  it("defaults to 25% of the canvas height (historic look)", () => {
    expect(rectHeight(topShadeSVG(380, 570, 80))).toBe(Math.round(570 * 0.25))
  })

  it("honors an explicit custom height", () => {
    expect(rectHeight(topShadeSVG(380, 570, 80, 60))).toBe(Math.round(570 * 0.6))
    expect(rectHeight(topShadeSVG(380, 570, 80, 100))).toBe(570)
  })

  it("height 0 paints a zero-height rect (caller skips the composite)", () => {
    expect(rectHeight(topShadeSVG(380, 570, 80, 0))).toBe(0)
  })

  it("clamps out-of-range and non-finite heights to 0..100 (default 25)", () => {
    expect(rectHeight(topShadeSVG(380, 570, 80, 250))).toBe(570)
    expect(rectHeight(topShadeSVG(380, 570, 80, -5))).toBe(0)
    expect(rectHeight(topShadeSVG(380, 570, 80, NaN))).toBe(Math.round(570 * 0.25))
  })

  it("strength semantics are untouched by the height axis", () => {
    const edge = (svg: string) => svg.match(/offset="0%"[^>]*stop-opacity="([^"]+)"/)?.[1]
    expect(edge(topShadeSVG(380, 570, 80))).toBe(edge(topShadeSVG(380, 570, 80, 60)))
    expect(edge(topShadeSVG(380, 570, 50, 25))).toBe(((0.75 * 50) / 100).toFixed(3))
  })
})

describe("server render chain (query > mapping > config > defaults > 25)", () => {
  it("falls back to 25 with no signal (invalid query fails closed)", () => {
    expect(resolvePosterRenderConfig(baseInput()).topShadeHeight).toBe(25)
    expect(
      resolvePosterRenderConfig(baseInput({ searchParams: new URLSearchParams({ tsh: "abc" }) })).topShadeHeight,
    ).toBe(25)
  })

  it("query wins over mapping, mapping over config, config over defaults", () => {
    expect(
      resolvePosterRenderConfig(baseInput({ searchParams: new URLSearchParams({ tsh: "60" }) })).topShadeHeight,
    ).toBe(60)
    expect(
      resolvePosterRenderConfig(
        baseInput({ searchParams: new URLSearchParams({ tsh: "60" }), mapping: mapping({ topShadeHeight: 10 }) }),
      ).topShadeHeight,
    ).toBe(60)
    expect(
      resolvePosterRenderConfig(baseInput({ mapping: mapping({ topShadeHeight: 40 }) })).topShadeHeight,
    ).toBe(40)
    expect(
      resolvePosterRenderConfig(
        baseInput({ mapping: mapping({ topShadeHeight: 40 }), configOverride: { globalBadges: true, rankingBadges: true, badgeStyle: "shadow", rankingBadgeStyle: "default", blurEnabled: true, blurIntensity: 20, blurFade: 50, blurDarkness: 30, gradientHeight: 30, autoRotateClean: false, topShadeHeight: 11 } as never }),
      ).topShadeHeight,
    ).toBe(40)
    expect(
      resolvePosterRenderConfig(baseInput({ sd: { topShadeHeight: 33 } })).topShadeHeight,
    ).toBe(33)
  })

  it("explicit 0 is preserved verbatim (never migrated to the default)", () => {
    expect(resolvePosterRenderConfig(baseInput({ mapping: mapping({ topShadeHeight: 0 }) })).topShadeHeight).toBe(0)
    expect(resolvePosterRenderConfig(baseInput({ sd: { topShadeHeight: 0 } })).topShadeHeight).toBe(0)
  })

  it("landscape profile wins per key over flats (flat preserved otherwise)", () => {
    expect(
      resolvePosterRenderConfig(
        baseInput({
          searchParams: new URLSearchParams({ shape: "landscape" }),
          mapping: mapping({ topShadeHeight: 40, landscape: { topShadeHeight: 70 } }),
        }),
      ).topShadeHeight,
    ).toBe(70)
    expect(
      resolvePosterRenderConfig(
        baseInput({
          searchParams: new URLSearchParams({ shape: "landscape" }),
          sd: { topShadeHeight: 40, landscape: { topShadeHeight: 70 } },
        }),
      ).topShadeHeight,
    ).toBe(70)
  })

  it("clamps the query to 0..100", () => {
    expect(
      resolvePosterRenderConfig(baseInput({ searchParams: new URLSearchParams({ tsh: "250" }) })).topShadeHeight,
    ).toBe(100)
  })

  it("leaves the strength chain untouched", () => {
    expect(resolvePosterRenderConfig(baseInput()).topShade).toBe(50)
    expect(
      resolvePosterRenderConfig(baseInput({ searchParams: new URLSearchParams({ tsh: "60" }) })).topShade,
    ).toBe(50)
  })
})

describe("effective top background luminance honors the height geometry", () => {
  const mean: BandMeanRGB = { r: 120, g: 100, b: 90 }
  it("two-arg call stays byte-identical to the historic model (default 25)", () => {
    expect(effectiveTopBackgroundLuminance(mean, 80)).toBeCloseTo(
      relativeLuminance(120 * 0.4, 100 * 0.4, 90 * 0.4),
      12,
    )
  })

  it("any non-zero height keeps the edge-alpha model", () => {
    expect(effectiveTopBackgroundLuminance(mean, 80, 60)).toBe(
      effectiveTopBackgroundLuminance(mean, 80),
    )
  })

  it("height 0 means no veil (raw band mean, like strength 0)", () => {
    expect(effectiveTopBackgroundLuminance(mean, 80, 0)).toBe(
      relativeLuminance(120, 100, 90),
    )
    expect(effectiveTopBackgroundLuminance(mean, 80, 0)).toBe(
      effectiveTopBackgroundLuminance(mean, 0),
    )
  })
})

describe("URL contracts (preview explicit, Stremio stable, compact signed)", () => {
  it("defaults preview always carries tsh=25 (both shapes)", () => {
    const params = (p: Parameters<typeof buildDefaultsPreviewUrl>[0]) =>
      new URL(buildDefaultsPreviewUrl(p), "http://localhost").searchParams
    expect(params({ defaultTopShadeHeight: 25 }).get("tsh")).toBe("25")
    expect(params({}).get("tsh")).toBe("25")
    expect(params({ previewShape: "landscape" }).get("tsh")).toBe("25")
    expect(params({ defaultTopShadeHeight: 60 }).get("tsh")).toBe("60")
  })

  it("editor preview always carries tsh (explicit and fallback)", () => {
    const ps = {
      selected: { id: 1, media_type: "movie" as const, poster_path: "/p.jpg" },
      previewPoster: null,
      selectedLogo: null,
      selectedBackdrop: null,
      logoScale: 100,
      logoOffsetX: 0,
      logoOffsetY: 0,
      backdropScale: 100,
      backdropOffsetX: 0,
      backdropOffsetY: 0,
      metaInfo: { genres: [], voteAverage: 0 },
      trendRank: null,
      mdblistAnimeList: [],
      topEdgeColor: null,
      lang: "it",
      tmdbKey: "",
    }
    const bp = {
      globalBadges: true, rankingBadges: true, badgeStyle: "shadow" as const,
      rankingBadgeStyle: "default" as const, customBadge: null,
      gradientHeight: 30, blurIntensity: 20, blurFade: 50, blurDarkness: 30,
      blurEnabled: true, tintStrength: 20, topShade: 80, topShadeHeight: 60,
      topBadgeScale: 100, topBadgeOffsetX: 0, topBadgeOffsetY: 0,
      genreBadgeScale: 100, genreBadgeOffsetX: 0, genreBadgeOffsetY: 0,
      qualityBadgeScale: 100, qualityBadgeOffsetX: 0, qualityBadgeOffsetY: 0,
      networkLogoScale: 100, networkLogoOffsetX: 0, networkLogoOffsetY: 0,
    }
    expect(new URL(buildPreviewUrl(ps as never, bp), "http://localhost").searchParams.get("tsh")).toBe("60")
    expect(
      new URL(buildPreviewUrl(ps as never, { ...bp, topShadeHeight: undefined }), "http://localhost").searchParams.get("tsh"),
    ).toBe("25")
  })

  it("Stremio omits tsh at the default and emits it otherwise (URLs stable)", () => {
    expect(buildStremioPosterSearchParams({}).has("tsh")).toBe(false)
    expect(buildStremioPosterSearchParams({ topShadeHeight: 25 }).has("tsh")).toBe(false)
    expect(buildStremioPosterSearchParams({ topShadeHeight: 60 }).get("tsh")).toBe("60")
    expect(buildStremioPosterSearchParams({ topShadeHeight: 0 }).get("tsh")).toBe("0")
  })

  it("compact tuning signs the height (default change invalidates the cache)", () => {
    const a = buildStremioPosterSearchParams({ compactTuning: true }).get("dv")
    const b = buildStremioPosterSearchParams({ compactTuning: true, topShadeHeight: 60 }).get("dv")
    expect(a).toMatch(/^[0-9a-f]{8}$/)
    expect(b).toMatch(/^[0-9a-f]{8}$/)
    expect(a).not.toBe(b)
  })
})

describe("cache key and presets-mode normalization", () => {
  it("tsh is allowlisted (travels into the cache key)", () => {
    expect(POSTER_CACHE_ALLOWLIST.has("tsh")).toBe(true)
  })

  it("presets mode quantizes tsh to step 5 (preview stays exact)", () => {
    const src = new URLSearchParams({ tsh: "63" })
    const hardened = hardenPosterSearchParams(src, {
      presets: true, preview: false, anonymous: false, publicInstance: true, hasMapping: false,
    })
    expect(hardened.get("tsh")).toBe("65")
    const live = hardenPosterSearchParams(src, {
      presets: true, preview: true, anonymous: false, publicInstance: true, hasMapping: false,
    })
    expect(live.get("tsh")).toBe("63")
  })
})

describe("persistence (mapping, token, presets, dirty)", () => {
  it("config token roundtrips the height (absent stays absent)", () => {
    const withHeight = decodeConfig(encodeConfig({
      globalBadges: true, rankingBadges: true, badgeStyle: "shadow", rankingBadgeStyle: "default",
      blurEnabled: true, blurIntensity: 20, blurFade: 50, blurDarkness: 30, gradientHeight: 30,
      networkLogo: true, autoRotateClean: false, topShadeHeight: 60,
    }))
    expect(withHeight?.topShadeHeight).toBe(60)
    const legacy = decodeConfig(encodeConfig({
      globalBadges: true, rankingBadges: true, badgeStyle: "shadow", rankingBadgeStyle: "default",
      blurEnabled: true, blurIntensity: 20, blurFade: 50, blurDarkness: 30, gradientHeight: 30,
      networkLogo: true, autoRotateClean: false,
    }))
    expect(legacy?.topShadeHeight).toBeUndefined()
  })

  it("per-title projection carries the height (portrait bare + landscape profile)", () => {
    const values = visualPresetValuesSchema.parse({
      ...APPLE_VISUAL_DEFAULTS,
      defaultTopShadeHeight: 60,
      landscape: { topShadeHeight: 70 },
    }) as VisualPresetValues
    const portrait = projectPerTitleVisualPreset(values, "poster")
    expect(portrait.bare.topShadeHeight).toBe(60)
    expect(portrait.landscapeBlur).toEqual({})
    const landscape = projectPerTitleVisualPreset(values, "landscape")
    expect(landscape.landscapeBlur.topShadeHeight).toBe(70)
    expect("topShadeHeight" in landscape.bare).toBe(false)
  })

  it("legacy snapshots without the height stay sparse (no invented value)", () => {
    const raw = { ...APPLE_VISUAL_DEFAULTS } as unknown as Record<string, unknown>
    delete raw.defaultTopShadeHeight
    const normalized = normalizePersonalPreset(raw as unknown as VisualPresetValues) as unknown as Record<string, unknown>
    expect("defaultTopShadeHeight" in normalized).toBe(false)
    // Schema parse (storage/load path) fills the canonical 25 instead.
    const parsed = visualPresetValuesSchema.parse(raw) as unknown as Record<string, unknown>
    expect(parsed.defaultTopShadeHeight).toBe(25)
  })

  it("effective landscape resolves profile ?? flat for the height", () => {
    const values = visualPresetValuesSchema.parse({
      ...APPLE_VISUAL_DEFAULTS,
      defaultTopShadeHeight: 60,
      landscape: {},
    }) as VisualPresetValues
    expect(resolveEffectiveLandscape(values)?.topShadeHeight).toBe(60)
  })

  it("effective mapping carries the height per shape", () => {
    const m = mapping({ topShadeHeight: 40, landscape: { topShadeHeight: 70 } })
    expect(effectiveMappingForShape(m, "poster")?.topShadeHeight).toBe(40)
    expect(effectiveMappingForShape(m, "landscape")?.topShadeHeight).toBe(70)
  })

  it("gradient dirty tracking fires on a height change only", () => {
    const saved = { gradientHeight: 30, blurEnabled: true, blurIntensity: 20, blurFade: 50, blurDarkness: 30, tintStrength: 20, topShade: 80, topShadeHeight: 25 }
    expect(isGradientDirtyForShape(saved, null, saved, "poster")).toBe(false)
    expect(isGradientDirtyForShape({ ...saved, topShadeHeight: 60 }, null, saved, "poster")).toBe(true)
    expect(
      isGradientDirtyForShape(saved, mapping({ topShadeHeight: 60 }), saved, "poster"),
    ).toBe(true)
  })

  it("quick looks pin the canonical 25 (both targets)", () => {
    for (const id of ["essential", "ratings", "full"] as QuickLookId[]) {
      expect(quickLookDesired(id, true).defaultTopShadeHeight, `${id} portrait`).toBe(25)
      expect(quickLookDesired(id, false).defaultTopShadeHeight, `${id} landscape`).toBe(25)
    }
  })
})

describe("editor defaults start at 25 and read legacy stores", () => {
  it("a fresh session starts at 25 (flat + per-title)", async () => {
    vi.useFakeTimers()
    resetGuestGuardForTests()
    localStorage.clear()
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })))
    const { result } = renderHook(() => useDefaults())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
    })
    expect(result.current.defaultTopShadeHeight).toBe(25)
    expect(result.current.topShadeHeight).toBe(25)
  })

  it("a legacy store missing the key reads 25", async () => {
    vi.useFakeTimers()
    resetGuestGuardForTests()
    localStorage.clear()
    localStorage.setItem(
      "badgeDefaults",
      JSON.stringify({ defaultBadgeYear: false, defaultGradientHeight: 45 }),
    )
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })))
    const { result } = renderHook(() => useDefaults())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
    })
    expect(result.current.defaultTopShadeHeight).toBe(25)
    expect(result.current.topShadeHeight).toBe(25)
  })
})

beforeEach(() => {
  resetGuestGuardForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
