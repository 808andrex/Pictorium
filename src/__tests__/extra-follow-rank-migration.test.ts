import { describe, expect, it } from "vitest"
import { resolvePosterRenderConfig, type PosterRenderConfigInput } from "@/lib/poster-config"
import { buildDefaultsPreviewUrl } from "@/lib/poster-url"
import { buildStremioPosterUrl } from "@/lib/stremio-poster-url"
import { normalizePosterCacheParams } from "@/lib/poster-runtime-cache"
import {
  EXTRA_BADGE_FOLLOW_RANK,
  isExtraBadgeStyle,
  isExtraFollowRank,
  isExtraBadgeStyleTransport,
  normalizeExtraBadgeStyleForRender,
} from "@/lib/badge-styles"
import {
  canonicalInheritFreeze,
  independentLandscapeDefaults,
  isLandscapeKeyPresent,
  snapshotMissingLandscape,
} from "@/lib/visual-presets"
import { resolveTopBadgeStyle } from "@/lib/poster-service"
import type { Mapping } from "@/lib/types"
import type { PictoriumUserConfig } from "@/lib/config-token"

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
  tmdbId: 1, mediaType: "movie", title: "T", posterPath: "/p.jpg",
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

describe("extra follow-rank sentinel contract (shared single source)", () => {
  it("sentinel value and renderer subset separation", () => {
    expect(EXTRA_BADGE_FOLLOW_RANK).toBe("follow-rank")
    expect(isExtraFollowRank("follow-rank")).toBe(true)
    expect(isExtraFollowRank("pill")).toBe(false)
    expect(isExtraFollowRank(null)).toBe(false)
    expect(isExtraBadgeStyle("follow-rank")).toBe(false)
    expect(isExtraBadgeStyle("pill")).toBe(true)
    expect(isExtraBadgeStyleTransport("follow-rank")).toBe(true)
    expect(isExtraBadgeStyleTransport("pill")).toBe(true)
    expect(isExtraBadgeStyleTransport("garbage")).toBe(false)
    expect(normalizeExtraBadgeStyleForRender("follow-rank")).toBeNull()
    expect(normalizeExtraBadgeStyleForRender("pill")).toBe("pill")
    expect(normalizeExtraBadgeStyleForRender(null)).toBeNull()
    // Ribbon/numeral ranks stay reachable only through the sentinel (no
    // subset approximation): the renderer falls back to rs.
    expect(resolveTopBadgeStyle({ topBadgeType: "extra", rankingBadgeStyle: "number", extraBadgeStyle: "follow-rank" as never })).toBe("number")
    expect(resolveTopBadgeStyle({ topBadgeType: "extra", rankingBadgeStyle: "netflix", extraBadgeStyle: "follow-rank" as never })).toBe("netflix")
    expect(resolveTopBadgeStyle({ topBadgeType: "extra", rankingBadgeStyle: "netflix", extraBadgeStyle: "corner" })).toBe("corner")
  })

  it("old null ALWAYS inherits; only follow-rank shadows", () => {
    expect(isLandscapeKeyPresent({ extraBadgeStyle: null }, "extraBadgeStyle")).toBe(false)
    expect(isLandscapeKeyPresent({ extraBadgeStyle: "follow-rank" }, "extraBadgeStyle")).toBe(true)
    // Absent/null flat concrete pill freezes PRE-edit pill at the boundary.
    expect(snapshotMissingLandscape({ defaultExtraBadgeStyle: "pill" }, { extraBadgeStyle: null }, ["defaultExtraBadgeStyle"]).extraBadgeStyle).toBe("pill")
    expect(snapshotMissingLandscape({ defaultExtraBadgeStyle: "pill" }, {}, ["defaultExtraBadgeStyle"]).extraBadgeStyle).toBe("pill")
    // Flat null/absent effective own-rank freezes the sentinel (never corner/pill).
    expect(canonicalInheritFreeze("extraBadgeStyle", null)).toEqual({ freeze: true, value: "follow-rank" })
    expect(canonicalInheritFreeze("extraBadgeStyle", undefined)).toEqual({ freeze: true, value: "follow-rank" })
    expect(canonicalInheritFreeze("extraBadgeStyle", "garbage")).toEqual({ freeze: true, value: "follow-rank" })
    expect(canonicalInheritFreeze("extraBadgeStyle", "pill")).toEqual({ freeze: true, value: "pill" })
    expect(snapshotMissingLandscape({ defaultExtraBadgeStyle: null }, {}, ["defaultExtraBadgeStyle"]).extraBadgeStyle).toBe("follow-rank")
    expect(independentLandscapeDefaults({ defaultExtraBadgeStyle: null }).extraBadgeStyle).toBe("follow-rank")
    expect(independentLandscapeDefaults({ defaultExtraBadgeStyle: "pill" }).extraBadgeStyle).toBe("pill")
  })
})

describe("extra follow-rank production resolution (query > mapping > token > profile)", () => {
  it("legacy null flat pill inherits across resolve/preview/Stremio (byte-identical)", () => {
    const sd = { extraBadgeStyle: "pill", landscape: { extraBadgeStyle: null } } as never
    expect(resolvePosterRenderConfig(baseInput({
      searchParams: new URLSearchParams({ shape: "landscape" }), sd,
    })).extraBadgeStyle).toBe("pill")
    const preview = new URL(buildDefaultsPreviewUrl({
      defaultExtraBadgeStyle: "pill", landscape: { extraBadgeStyle: null }, previewShape: "landscape",
    })).searchParams
    expect(preview.get("xbs")).toBe("pill")
    const stremio = buildStremioPosterUrl({
      origin: "https://x.test", type: "movie", id: 1, forceShape: "landscape",
      defaults: { extraBadgeStyle: "pill", landscape: { extraBadgeStyle: null } },
    })
    expect(stremio.searchParams.get("xbs")).toBe("pill")
  })

  it("follow-rank shadows the flat and still renders own number/ribbon", () => {
    const sd = {
      extraBadgeStyle: "pill",
      rankingBadgeStyle: "number",
      landscape: { extraBadgeStyle: "follow-rank", rankingBadgeStyle: "number" },
    } as never
    const r = resolvePosterRenderConfig(baseInput({ searchParams: new URLSearchParams({ shape: "landscape" }), sd }))
    expect(r.extraBadgeStyle).toBeNull()
    expect(r.rankingBadgeStyle).toBe("number")
    // Portrait on the same sd keeps the flat (independence).
    expect(resolvePosterRenderConfig(baseInput({ sd })).extraBadgeStyle).toBe("pill")
    // Builders carry the sentinel; production resolves own-rank.
    const preview = new URL(buildDefaultsPreviewUrl({
      defaultExtraBadgeStyle: "pill", landscape: { extraBadgeStyle: "follow-rank" }, previewShape: "landscape",
    })).searchParams
    expect(preview.get("xbs")).toBe("follow-rank")
    expect(resolvePosterRenderConfig(baseInput({ searchParams: preview, sd })).extraBadgeStyle).toBeNull()
    const stremio = buildStremioPosterUrl({
      origin: "https://x.test", type: "movie", id: 1, forceShape: "landscape", defaults: sd,
    })
    expect(stremio.searchParams.get("xbs")).toBe("follow-rank")
    expect(resolvePosterRenderConfig(baseInput({ searchParams: stremio.searchParams, sd })).extraBadgeStyle).toBeNull()
  })

  it("query follow-rank beats mapping/token/concrete flat; mapping/token follow obey precedence", () => {
    const sd = { extraBadgeStyle: "pill", landscape: { extraBadgeStyle: "pill" } } as never
    // Query sentinel beats everything.
    expect(resolvePosterRenderConfig(baseInput({
      searchParams: new URLSearchParams({ shape: "landscape", xbs: "follow-rank" }),
      mapping: mapping({ extraBadgeStyle: "vetro" }),
      configOverride: token({ extraBadgeStyle: "corner" }),
      sd,
    })).extraBadgeStyle).toBeNull()
    // Mapping sentinel beats token/profile but loses to query.
    expect(resolvePosterRenderConfig(baseInput({
      searchParams: new URLSearchParams({ shape: "landscape" }),
      mapping: mapping({ extraBadgeStyle: "follow-rank" as never }),
      configOverride: token({ extraBadgeStyle: "corner" }),
      sd,
    })).extraBadgeStyle).toBeNull()
    expect(resolvePosterRenderConfig(baseInput({
      searchParams: new URLSearchParams({ shape: "landscape", xbs: "corner" }),
      mapping: mapping({ extraBadgeStyle: "follow-rank" as never }),
      sd,
    })).extraBadgeStyle).toBe("corner")
    // Token sentinel beats profile/flat but loses to query/mapping.
    expect(resolvePosterRenderConfig(baseInput({
      searchParams: new URLSearchParams({ shape: "landscape" }),
      configOverride: token({ extraBadgeStyle: "follow-rank" as never }),
      sd,
    })).extraBadgeStyle).toBeNull()
    expect(resolvePosterRenderConfig(baseInput({
      searchParams: new URLSearchParams({ shape: "landscape" }),
      mapping: mapping({ extraBadgeStyle: "vetro" }),
      configOverride: token({ extraBadgeStyle: "follow-rank" as never }),
      sd,
    })).extraBadgeStyle).toBe("vetro")
    // Concrete mapping/token still win over the profile sentinel when no query.
    expect(resolvePosterRenderConfig(baseInput({
      searchParams: new URLSearchParams({ shape: "landscape" }),
      mapping: mapping({ extraBadgeStyle: "vetro" }),
      sd: { extraBadgeStyle: "pill", landscape: { extraBadgeStyle: "follow-rank" } } as never,
    })).extraBadgeStyle).toBe("vetro")
  })

  it("cache hardening: sentinel keeps its own key; absent/invalid collapse without contamination", () => {
    const follow = normalizePosterCacheParams(new URLSearchParams({ xbs: "follow-rank", shape: "landscape" }))
    expect(follow.get("xbs")).toBe("follow-rank")
    const absent = normalizePosterCacheParams(new URLSearchParams({ shape: "landscape" }))
    expect(absent.has("xbs")).toBe(false)
    const garbage = normalizePosterCacheParams(new URLSearchParams({ xbs: "garbage", shape: "landscape" }))
    expect(garbage.has("xbs")).toBe(false)
    expect(garbage.toString()).toBe(absent.toString())
    expect(follow.toString()).not.toBe(absent.toString())
    const pill = normalizePosterCacheParams(new URLSearchParams({ xbs: "pill", shape: "landscape" }))
    expect(pill.get("xbs")).toBe("pill")
    expect(follow.toString()).not.toBe(pill.toString())
  })
})
