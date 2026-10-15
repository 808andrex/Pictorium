/**
 * follow-rank TRANSPORT correction (not renderer subset):
 * - the explicit "follow-rank" marker is a TRANSPORT sentinel persisted
 *   validated in the per-title mapping snapshot (flat, shared by both
 *   canvases); renderer normalization (`normalizeExtraBadgeStyleForRender`
 *   -> null/own-rank via `rs`) applies ONLY at the renderer boundary, never
 *   on the save path (saving must not destroy the marker).
 * - the preview builder serializes the marker on ANY selected shape
 *   (portrait included); legacy null/absent stays omitted on both shapes
 *   (existing URLs byte-identical).
 * - legacy null/absent/invalid always INHERITS the next layer (falls
 *   through); only the explicit marker shadows. Precedence is unchanged:
 *   query > mapping > token > profile/defaults (higher query wins).
 * - this test uses the REAL usePosterSave.saveConfig (all required fields)
 *   and the production builders/resolver, not hand-built mappings alone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { usePosterSave } from "@/lib/usePosterSave"
import { resolvePosterRenderConfig, type PosterRenderConfigInput } from "@/lib/poster-config"
import { buildPreviewUrl } from "@/lib/poster-url"
import { buildStremioPosterUrl } from "@/lib/stremio-poster-url"
import { mappingSchema } from "@/lib/validation"
import type { Mapping } from "@/lib/types"
import type { PictoriumUserConfig } from "@/lib/config-token"

const noop = () => {}

let posted: { url: string; body: Record<string, unknown> }[]
beforeEach(() => {
  posted = []
  localStorage.clear()
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: unknown) => {
    const body = (init as { body?: string })?.body
    posted.push({ url: String(url), body: body ? JSON.parse(body) : {} })
    return { ok: true, status: 200, text: async () => "", json: async () => ({}) }
  }))
})

function saveDeps(overrides: Record<string, unknown> = {}) {
  return {
    selected: { id: 7, media_type: "movie", title: "T", poster_path: "/p.jpg" },
    previewPoster: { file_path: "/p.jpg", iso_639_1: null, vote_average: 0, width: 500, height: 750 },
    selectedLogo: null,
    setSelectedLogo: noop,
    setPreviewPoster: noop,
    setPreviewId: noop,
    posters: [],
    metaInfo: { genres: [{ id: 1, name: "Dramma" }], voteAverage: 7.5 },
    trendRank: null,
    mdblistAnimeList: [],
    mappingsMap: new Map<string, Mapping>(),
    loadMappings: async () => {},
    logoScale: null,
    logoOffsetX: null,
    logoOffsetY: null,
    selectedBackdrop: null,
    setSelectedBackdrop: noop,
    backdropScale: 100,
    backdropOffsetX: 0,
    backdropOffsetY: 0,
    setBackdropScale: noop,
    setBackdropOffsetX: noop,
    setBackdropOffsetY: noop,
    globalBadges: true,
    rankingBadges: true,
    badgeGenre: true,
    badgeYear: true,
    badgeRating: true,
    badgeQuality: true,
    customRatings: true,
    ratingSources: ["imdb", "tmdb"],
    separateRatings: false,
    separateRatingsStyle: "column",
    customBadge: null,
    badgeStyle: "shadow",
    rankingBadgeStyle: "default",
    extraBadgeStyle: null,
    badgeFont: "inter",
    qualityBadgeStyle: "standard",
    videoFormats: null,
    defaultBadgeStyle: "shadow",
    defaultRankingBadgeStyle: "default",
    defaultExtraBadgeStyle: null,
    blurEnabled: true,
    blurIntensity: 20,
    blurFade: 50,
    blurDarkness: 30,
    landscapeBlur: {
      gradientHeight: 30, blurIntensity: 20, blurFade: 70,
      blurDarkness: 30, tintStrength: 20, topShade: 50, blurEnabled: true,
    },
    landscapeBlurDirty: false,
    setLandscapeBlur: noop,
    defaultLogoScale: null,
    defaultLogoOffsetX: null,
    defaultLogoOffsetY: null,
    landscapeDefaults: null,
    tintStrength: 20,
    topShade: 50,
    gradientHeight: 30,
    setGradientHeight: noop,
    setBlurFade: noop,
    topBadgeScale: 100,
    topBadgeOffsetX: 0,
    topBadgeOffsetY: 0,
    extraBadgeScale: null,
    extraBadgeOffsetX: null,
    extraBadgeOffsetY: null,
    genreBadgeScale: 100,
    qualityBadgeScale: 100,
    separateBadgeScale: 130,
    separateBadgeOffsetX: 0,
    separateBadgeOffsetY: 0,
    networkLogoScale: 100,
    genreBadgeOffsetX: 0,
    genreBadgeOffsetY: 0,
    qualityBadgeOffsetX: 0,
    qualityBadgeOffsetY: 0,
    networkLogoOffsetX: 0,
    networkLogoOffsetY: 0,
    rotationPosters: [],
    autoRotateClean: false,
    defaultAutoRotateClean: false,
    excludedPosters: [],
    accentColor: null,
    logoDisabled: false,
    setLogoDisabled: noop,
    setLogoScale: noop,
    setLogoOffsetX: noop,
    setLogoOffsetY: noop,
    rotationBackdrops: [],
    autoRotateBackdrop: false,
    defaultAutoRotateBackdrop: false,
    excludedBackdrops: [],
    backdrops: [],
    networkLogo: true,
    networkLogoPosition: "auto",
    networkLogoFollowTitle: true,
    ribbonEnabled: true,
    lang: "it",
    posterShape: "poster",
    posterLayout: "standard",
    posterFreshScope: "ranked",
    ...overrides,
  } as never
}

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

const mapping = (partial: Partial<Mapping> = {}): Mapping => ({
  tmdbId: 7, mediaType: "movie", title: "T", posterPath: "/p.jpg",
  logoPath: null, originalPosterPath: null, language: null, updatedAt: "2026-01-01",
  ...partial,
})

const token = (partial: Partial<PictoriumUserConfig> = {}): PictoriumUserConfig => ({
  globalBadges: true, rankingBadges: true, badgeStyle: "shadow",
  rankingBadgeStyle: "default",
  blurEnabled: true, blurIntensity: 20, blurFade: 50, blurDarkness: 30,
  gradientHeight: 30, networkLogo: true, autoRotateClean: false,
  ...partial,
})

const baseBadgeParams = {
  globalBadges: true,
  rankingBadges: true,
  badgeStyle: "shadow" as const,
  rankingBadgeStyle: "default" as const,
  customBadge: null,
  gradientHeight: 30,
  blurIntensity: 5,
  blurFade: 60,
  blurDarkness: 40,
  blurEnabled: true,
  topBadgeScale: 100,
  topBadgeOffsetX: 0,
  topBadgeOffsetY: 0,
  genreBadgeScale: 100,
  qualityBadgeScale: 100,
  networkLogoScale: 100,
  genreBadgeOffsetX: 0,
  genreBadgeOffsetY: 0,
  qualityBadgeOffsetX: 0,
  qualityBadgeOffsetY: 0,
  networkLogoOffsetX: 0,
  networkLogoOffsetY: 0,
}

const basePosterState = {
  selected: { id: 7, media_type: "movie" as const, title: "T", poster_path: "/p.jpg" },
  previewPoster: { file_path: "/p.jpg", iso_639_1: null as string | null, vote_average: 0, width: 500, height: 750 },
  selectedLogo: null,
  selectedBackdrop: null,
  logoScale: 75,
  logoOffsetX: 0,
  logoOffsetY: 0,
  backdropScale: 100,
  backdropOffsetX: 0,
  backdropOffsetY: 0,
  metaInfo: { genres: [{ id: 1, name: "Dramma" }], voteAverage: 7.5 },
  trendRank: null,
  mdblistAnimeList: [],
  topEdgeColor: null,
  lang: "it",
  tmdbKey: "test-key",
}

describe("follow-rank transport correction: real save + production reload", () => {
  it("real saveConfig persists the marker under concrete portrait + pill token/default", async () => {
    const { result } = renderHook(() => usePosterSave(saveDeps({
      extraBadgeStyle: "follow-rank",
      posterShape: "poster",
      defaultExtraBadgeStyle: "pill",
    })))
    let ok = false
    await act(async () => {
      ok = (await result.current.saveConfig({ silent: true })) === true
    })
    expect(ok).toBe(true)
    const mappings = posted.filter((p) => String(p.url).includes("/api/mappings"))
    expect(mappings).toHaveLength(1)
    // The marker survives the save (renderer normalization is NOT applied here).
    expect(mappings[0].body.extraBadgeStyle).toBe("follow-rank")
    expect(mappingSchema.safeParse({
      tmdbId: 7, mediaType: "movie", title: "T", posterPath: "/p.jpg",
      extraBadgeStyle: mappings[0].body.extraBadgeStyle,
    }).success).toBe(true)
  })

  it("saved marker stays own-rank after token/default turn pill; Stremio + preview resolve own-rank", async () => {
    const { result } = renderHook(() => usePosterSave(saveDeps({
      extraBadgeStyle: "follow-rank",
      posterShape: "poster",
      defaultExtraBadgeStyle: "pill",
    })))
    await act(async () => {
      await result.current.saveConfig({ silent: true })
    })
    const savedMarker = posted.find((p) => String(p.url).includes("/api/mappings"))?.body.extraBadgeStyle
    expect(savedMarker).toBe("follow-rank")
    // Reload: the saved mapping now carries the marker while token/defaults
    // changed underneath to a concrete pill.
    const saved = mapping({ extraBadgeStyle: savedMarker as never })
    const pillToken = token({ extraBadgeStyle: "pill" })
    const pillSd = { extraBadgeStyle: "pill", landscape: { extraBadgeStyle: "pill" } } as never
    for (const shape of ["poster", "landscape"] as const) {
      const q = new URLSearchParams({ shape })
      expect(resolvePosterRenderConfig(baseInput({
        searchParams: q, mapping: saved, configOverride: pillToken, sd: pillSd,
      })).extraBadgeStyle).toBeNull()
    }
    // Production Stremio URL carries the marker and resolves own-rank.
    const stremio = buildStremioPosterUrl({
      origin: "https://x.test", type: "movie", id: 7, forceShape: "landscape",
      mapping: saved, defaults: pillSd,
    })
    expect(stremio.searchParams.get("xbs")).toBe("follow-rank")
    expect(resolvePosterRenderConfig(baseInput({
      searchParams: stremio.searchParams, mapping: saved,
      configOverride: pillToken, sd: pillSd,
    })).extraBadgeStyle).toBeNull()
    // Direct preview emits the marker on BOTH shapes and resolves own-rank.
    for (const shape of ["poster", "landscape"] as const) {
      const preview = new URL(buildPreviewUrl(
        { ...basePosterState } as never,
        { ...baseBadgeParams, extraBadgeStyle: "follow-rank", posterShape: shape } as never,
      ))
      expect(preview.searchParams.get("xbs")).toBe("follow-rank")
      expect(resolvePosterRenderConfig(baseInput({
        searchParams: preview.searchParams, mapping: saved,
        configOverride: pillToken, sd: pillSd,
      })).extraBadgeStyle).toBeNull()
    }
  })

  it("explicit query marker on both shapes overrides concrete mapping/token", () => {
    const concrete = mapping({ extraBadgeStyle: "vetro" })
    const concreteToken = token({ extraBadgeStyle: "corner" })
    const sd = { extraBadgeStyle: "pill" } as never
    for (const shape of ["poster", "landscape"] as const) {
      expect(resolvePosterRenderConfig(baseInput({
        searchParams: new URLSearchParams({ shape, xbs: "follow-rank" }),
        mapping: concrete, configOverride: concreteToken, sd,
      })).extraBadgeStyle).toBeNull()
    }
  })

  it("plain null still legacy-inherits (preview omits xbs, token wins)", () => {
    for (const shape of ["poster", "landscape"] as const) {
      const preview = new URL(buildPreviewUrl(
        { ...basePosterState } as never,
        { ...baseBadgeParams, extraBadgeStyle: null, posterShape: shape } as never,
      ))
      expect(preview.searchParams.has("xbs")).toBe(false)
    }
    // Null falls through to the token layer (no shadowing).
    expect(resolvePosterRenderConfig(baseInput({
      searchParams: new URLSearchParams({ shape: "landscape" }),
      mapping: mapping({ extraBadgeStyle: null }),
      configOverride: token({ extraBadgeStyle: "corner" }),
      sd: { extraBadgeStyle: "pill" } as never,
    })).extraBadgeStyle).toBe("corner")
    expect(resolvePosterRenderConfig(baseInput({
      searchParams: new URLSearchParams({ shape: "poster" }),
      mapping: mapping({ extraBadgeStyle: null }),
      sd: { extraBadgeStyle: "pill" } as never,
    })).extraBadgeStyle).toBe("pill")
  })
})
