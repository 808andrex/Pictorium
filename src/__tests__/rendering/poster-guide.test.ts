import { describe, expect, it } from "vitest"
import {
  applyGuideBuiltinToDraft,
  buildGuideConfirmValues,
  buildGuideGradientPatch,
  buildGuideInfoPatch,
  buildGuidePreviewEditor,
  captureGuideBaseline,
  createGuideDraft,
  extractGuideConflictExtras,
  guideSessionKey,
  isGuideBaselineStale,
  isGuideBottomActive,
  normalizeGuideConfirmExtra,
  readGuideEffective,
  readGuideInfoToggles,
  updateGuideDraft,
} from "@/lib/poster-guide"
import {
  APPLE_VISUAL_DEFAULTS,
  BETTER_POSTER_VISUAL_DEFAULTS,
} from "@/lib/default-visual-presets"
import { captureVisualPreset } from "@/lib/visual-presets"
import { resolveNetworkEffectiveView } from "@/lib/network-follow"
import { buildDefaultsPreviewUrl } from "@/lib/poster-url"

describe("poster-guide helpers", () => {
  it("seeds the draft from the baseline without aliasing live state", () => {
    const baseline = captureGuideBaseline(
      { ...APPLE_VISUAL_DEFAULTS, landscape: { ...APPLE_VISUAL_DEFAULTS.landscape } },
      "user-1",
      "portrait",
    )
    const draft = createGuideDraft(baseline)
    expect(draft).toEqual(captureVisualPreset(APPLE_VISUAL_DEFAULTS))
    draft.defaultBadgeStyle = "pill"
    expect(baseline.values.defaultBadgeStyle).toBe("minimal")
  })

  it("applies a builtin into the draft as a pure clone", () => {
    const baseline = captureGuideBaseline(
      { ...APPLE_VISUAL_DEFAULTS, landscape: { ...APPLE_VISUAL_DEFAULTS.landscape } },
      null,
      "portrait",
    )
    const draft = applyGuideBuiltinToDraft(createGuideDraft(baseline), BETTER_POSTER_VISUAL_DEFAULTS)
    expect(draft.defaultBadgeStyle).toBe(BETTER_POSTER_VISUAL_DEFAULTS.defaultBadgeStyle)
    expect(draft.defaultRankingBadgeStyle).toBe(BETTER_POSTER_VISUAL_DEFAULTS.defaultRankingBadgeStyle)
    // No live aliasing: mutating the draft never touches the builtin.
    draft.defaultSashOrder = []
    expect(BETTER_POSTER_VISUAL_DEFAULTS.defaultSashOrder.length).toBeGreaterThan(0)
  })

  it("merges draft patches (flats + nested landscape) without touching the input", () => {
    const baseline = captureGuideBaseline(
      { ...APPLE_VISUAL_DEFAULTS, landscape: { ...APPLE_VISUAL_DEFAULTS.landscape } },
      null,
      "landscape",
    )
    const draft = createGuideDraft(baseline)
    const next = updateGuideDraft(draft, {
      defaultBadgeGenre: false,
      landscape: { badgeGenre: false },
    })
    expect(next.defaultBadgeGenre).toBe(false)
    expect(next.landscape?.badgeGenre).toBe(false)
    expect(draft.defaultBadgeGenre).toBe(true)
  })

  it("portrait confirm freezes the effective landscape and preserves raw extras", () => {
    const liveLandscape = {
      ...APPLE_VISUAL_DEFAULTS.landscape,
      // Unknown extra outside the preset contract (server-supported).
      minQuality: "1080p",
    } as never
    const baseline = captureGuideBaseline(
      { ...APPLE_VISUAL_DEFAULTS, landscape: liveLandscape },
      "user-1",
      "portrait",
    )
    const draft = applyGuideBuiltinToDraft(createGuideDraft(baseline), BETTER_POSTER_VISUAL_DEFAULTS)
    const out = buildGuideConfirmValues(baseline, liveLandscape, draft, "portrait")
    // Portrait flats follow the draft (builtin).
    expect(out.defaultBadgeStyle).toBe(BETTER_POSTER_VISUAL_DEFAULTS.defaultBadgeStyle)
    // Raw extras survive the single atomic payload.
    expect((out.landscape as unknown as Record<string, unknown>).minQuality).toBe("1080p")
    // Delivery/region-adjacent globals keep helper semantics (preset-owned).
    expect(out.defaultPosterShape).toBe(BETTER_POSTER_VISUAL_DEFAULTS.defaultPosterShape)
  })

  it("landscape confirm writes the profile only, portrait flats byte-identical", () => {
    const baseline = captureGuideBaseline(
      { ...APPLE_VISUAL_DEFAULTS, landscape: { ...APPLE_VISUAL_DEFAULTS.landscape } },
      "user-1",
      "landscape",
    )
    const draft = applyGuideBuiltinToDraft(createGuideDraft(baseline), BETTER_POSTER_VISUAL_DEFAULTS)
    const out = buildGuideConfirmValues(baseline, baseline.landscapeRaw, draft, "landscape")
    expect(out.defaultBadgeStyle).toBe(APPLE_VISUAL_DEFAULTS.defaultBadgeStyle)
    expect(out.landscape?.badgeStyle).toBe(BETTER_POSTER_VISUAL_DEFAULTS.defaultBadgeStyle)
  })

  it("rejects stale baselines on value, shape, or user change", () => {
    const baseline = captureGuideBaseline(
      { ...APPLE_VISUAL_DEFAULTS, landscape: { ...APPLE_VISUAL_DEFAULTS.landscape } },
      "user-1",
      "portrait",
    )
    const same = captureVisualPreset({ ...APPLE_VISUAL_DEFAULTS, landscape: APPLE_VISUAL_DEFAULTS.landscape })
    expect(isGuideBaselineStale(baseline, same, "user-1", "portrait")).toBe(false)
    const moved = { ...same, defaultBadgeStyle: "pill" } as typeof same
    expect(isGuideBaselineStale(baseline, moved, "user-1", "portrait")).toBe(true)
    expect(isGuideBaselineStale(baseline, same, "user-1", "landscape")).toBe(true)
    expect(isGuideBaselineStale(baseline, same, "user-2", "portrait")).toBe(true)
  })

  it("keys sessions by target + user", () => {
    expect(guideSessionKey("portrait", "u1")).toBe("portrait::u1")
    expect(guideSessionKey("portrait", null)).toBe("portrait::anon")
    expect(guideSessionKey("portrait", "u1")).not.toBe(guideSessionKey("landscape", "u1"))
    expect(guideSessionKey("portrait", "u1")).not.toBe(guideSessionKey("portrait", "u2"))
  })

  it("detects bottom separate modes that suppress genre/year", () => {
    expect(isGuideBottomActive({ defaultSeparateRatings: true, defaultSeparateRatingsStyle: "bottom-bar" })).toBe(true)
    expect(isGuideBottomActive({ defaultSeparateRatings: true, defaultSeparateRatingsStyle: "bottom-pills" })).toBe(true)
    expect(isGuideBottomActive({ defaultSeparateRatings: true, defaultSeparateRatingsStyle: "column" })).toBe(false)
    expect(isGuideBottomActive({ defaultSeparateRatings: false, defaultSeparateRatingsStyle: "bottom-bar" })).toBe(false)
  })

  it("reads information toggles from the draft", () => {
    const toggles = readGuideInfoToggles(APPLE_VISUAL_DEFAULTS)
    expect(toggles.genre).toBe(true)
    expect(toggles.rank).toBe(true)
    expect(toggles.globalBadges).toBe(true)
    const off = readGuideInfoToggles({ ...APPLE_VISUAL_DEFAULTS, defaultRankingBadges: false, defaultSashOrder: [] })
    expect(off.rank).toBe(false)
  })
})

describe("guide target-aware controls (landscape effective)", () => {
  const conflicted = {
    ...APPLE_VISUAL_DEFAULTS,
    defaultBadgeGenre: false,
    defaultBadgeYear: true,
    defaultBadgeRating: false,
    defaultBadgeQuality: true,
    defaultGlobalBadges: false,
    defaultRankingBadges: false,
    defaultSashOrder: [],
    defaultNetworkLogo: false,
    defaultBlurEnabled: false,
    defaultGradientHeight: 10,
    landscape: {
      ...APPLE_VISUAL_DEFAULTS.landscape,
      badgeGenre: true,
      badgeYear: false,
      badgeRating: true,
      badgeQuality: false,
      globalBadges: true,
      rankingBadges: true,
      sashOrder: ["rank"],
      networkLogo: true,
      blurEnabled: true,
      gradientHeight: 90,
    },
  } as typeof APPLE_VISUAL_DEFAULTS

  it("reads every Information toggle from the effective layer per shape", () => {
    const portrait = readGuideInfoToggles(conflicted, "portrait")
    expect(portrait).toMatchObject({
      genre: false, year: true, rating: false, quality: true,
      rank: false, network: false, globalBadges: false,
    })
    const landscape = readGuideInfoToggles(conflicted, "landscape")
    expect(landscape).toMatchObject({
      genre: true, year: false, rating: true, quality: false,
      rank: true, network: true, globalBadges: true,
    })
  })

  it("resolves the Apple explicit landscape gradient (not the flat)", () => {
    // Apple flats (portrait) vs explicit nested landscape profile.
    expect(readGuideEffective(APPLE_VISUAL_DEFAULTS, "portrait", "defaultBlurFade")).toBe(50)
    expect(readGuideEffective(APPLE_VISUAL_DEFAULTS, "landscape", "defaultBlurFade")).toBe(100)
    expect(readGuideEffective(APPLE_VISUAL_DEFAULTS, "landscape", "defaultQualityBadgeStyle")).toBe("color")
    expect(readGuideEffective(APPLE_VISUAL_DEFAULTS, "portrait", "defaultQualityBadgeStyle")).toBe("knockout")
  })

  it("resolves master/sash/bottom-mode per target (landscape-only bottom)", () => {
    const bottomLand = {
      ...APPLE_VISUAL_DEFAULTS,
      defaultSeparateRatings: false,
      defaultSeparateRatingsStyle: "column",
      landscape: {
        ...APPLE_VISUAL_DEFAULTS.landscape,
        separateRatings: true,
        separateRatingsStyle: "bottom-bar",
      },
    } as typeof APPLE_VISUAL_DEFAULTS
    const landEff = {
      defaultSeparateRatings: readGuideEffective(bottomLand, "landscape", "defaultSeparateRatings"),
      defaultSeparateRatingsStyle: readGuideEffective(bottomLand, "landscape", "defaultSeparateRatingsStyle"),
    }
    const flatEff = {
      defaultSeparateRatings: readGuideEffective(bottomLand, "portrait", "defaultSeparateRatings"),
      defaultSeparateRatingsStyle: readGuideEffective(bottomLand, "portrait", "defaultSeparateRatingsStyle"),
    }
    expect(isGuideBottomActive(landEff as never)).toBe(true)
    expect(isGuideBottomActive(flatEff as never)).toBe(false)
  })

  it("patches nested profile keys for ALL Information fields in landscape, flats in portrait", () => {
    for (const key of ["genre", "year", "rating", "quality", "network"] as const) {
      const landPatch = buildGuideInfoPatch(conflicted, "landscape", key, true)
      expect(landPatch.landscape).toBeDefined()
      expect((landPatch as Record<string, unknown>).defaultBadgeGenre).toBeUndefined()
      const flatPatch = buildGuideInfoPatch(conflicted, "portrait", key, false)
      expect(flatPatch.landscape).toBeUndefined()
    }
    // Landscape genre-on powers the same-layer master, flats untouched.
    const landGenre = buildGuideInfoPatch(
      { ...conflicted, landscape: { ...conflicted.landscape, globalBadges: false, badgeGenre: false } },
      "landscape", "genre", true,
    )
    expect(landGenre.landscape).toMatchObject({ globalBadges: true, badgeGenre: true })
    expect((landGenre as Record<string, unknown>).defaultGlobalBadges).toBeUndefined()
  })

  it("master off + stored child on: enabling powers the visible item per the render contract (quality independent)", () => {
    // Genre (master-gated): master off + stored child on -> click enables master + child in target.
    const gated = { ...APPLE_VISUAL_DEFAULTS, defaultGlobalBadges: false, defaultBadgeGenre: true }
    expect(buildGuideInfoPatch(gated, "portrait", "genre", true)).toMatchObject({
      defaultGlobalBadges: true, defaultBadgeGenre: true,
    })
    const gatedLand = {
      ...APPLE_VISUAL_DEFAULTS,
      landscape: { ...APPLE_VISUAL_DEFAULTS.landscape, globalBadges: false, badgeGenre: true },
    }
    expect(buildGuideInfoPatch(gatedLand, "landscape", "genre", true).landscape).toMatchObject({
      globalBadges: true, badgeGenre: true,
    })
    // Quality is master-independent: never enables the master (either shape).
    expect(buildGuideInfoPatch(gated, "portrait", "quality", true)).not.toHaveProperty("defaultGlobalBadges")
    const landQuality = buildGuideInfoPatch(gatedLand, "landscape", "quality", true)
    expect(landQuality.landscape).toMatchObject({ badgeQuality: true })
    expect((landQuality.landscape as Record<string, unknown>).globalBadges).toBeUndefined()
    // Rank-on powers both masters + sash in the target layer only.
    const rankLand = buildGuideInfoPatch(gatedLand, "landscape", "rank", true)
    expect(rankLand.landscape).toMatchObject({ rankingBadges: true, globalBadges: true })
    expect(Array.isArray((rankLand.landscape as Record<string, unknown>).sashOrder)).toBe(true)
    expect((rankLand as Record<string, unknown>).defaultRankingBadges).toBeUndefined()
  })

  it("patches every gradient field into the nested profile for landscape", () => {
    const land = buildGuideGradientPatch("landscape", {
      defaultBlurEnabled: true,
      defaultGradientHeight: 42,
      defaultBlurIntensity: 7,
      defaultBlurFade: 8,
      defaultBlurDarkness: 9,
      defaultTintStrength: 3,
    })
    expect(land).toEqual({
      landscape: {
        blurEnabled: true, gradientHeight: 42, blurIntensity: 7,
        blurFade: 8, blurDarkness: 9, tintStrength: 3,
      },
    })
    expect(buildGuideGradientPatch("portrait", { defaultBlurEnabled: true })).toEqual({
      defaultBlurEnabled: true,
    })
  })
})

describe("guide single projection source + conflict completeness", () => {
  it("clears missing/null extra like the provider (legacy follows own rank, explicit wins)", () => {
    const legacy = {
      ...APPLE_VISUAL_DEFAULTS,
      defaultTopBadgeScale: 100, defaultTopBadgeOffsetX: 1, defaultTopBadgeOffsetY: 2,
      defaultExtraBadgeScale: undefined, defaultExtraBadgeOffsetX: undefined, defaultExtraBadgeOffsetY: undefined,
    } as unknown as typeof APPLE_VISUAL_DEFAULTS
    const cleared = normalizeGuideConfirmExtra(legacy, "portrait")
    expect(cleared.defaultExtraBadgeScale).toBeNull()
    expect(cleared.defaultExtraBadgeOffsetX).toBeNull()
    const explicit = { ...legacy, defaultExtraBadgeScale: 80, defaultExtraBadgeOffsetX: 3, defaultExtraBadgeOffsetY: 4 }
    expect(normalizeGuideConfirmExtra(explicit, "portrait").defaultExtraBadgeScale).toBe(80)
    const legacyLand = {
      ...APPLE_VISUAL_DEFAULTS,
      landscape: { topBadgeScale: 100, topBadgeOffsetX: 1, topBadgeOffsetY: 2 },
    } as unknown as typeof APPLE_VISUAL_DEFAULTS
    const clearedLand = normalizeGuideConfirmExtra(legacyLand, "landscape")
    expect((clearedLand.landscape as Record<string, unknown>).extraBadgeScale).toBeNull()
  })

  it("projects the preview editor over complete live fields (age/layout/sources survive)", () => {
    const baseline = captureGuideBaseline(
      { ...APPLE_VISUAL_DEFAULTS, landscape: { ...APPLE_VISUAL_DEFAULTS.landscape } },
      "u1", "portrait",
    )
    const liveEd = {
      ...APPLE_VISUAL_DEFAULTS,
      landscape: { ...APPLE_VISUAL_DEFAULTS.landscape, minQuality: "1080p" },
      defaultAgeBadge: true,
      defaultPosterLayout: "fresh",
    } as unknown as Record<string, unknown>
    const draft = applyGuideBuiltinToDraft(createGuideDraft(baseline), BETTER_POSTER_VISUAL_DEFAULTS)
    const projected = buildGuidePreviewEditor(liveEd, baseline, liveEd.landscape as never, draft, "portrait") as Record<string, unknown>
    // Draft wins on preset keys, live-only roots survive, raw extras survive.
    // Shared globals keep the isolated-helper semantics (baseline/live, not
    // the builtin's own list): the live state equals the baseline whenever
    // confirm is allowed (any drift is a conflict), so sources stay put.
    expect(projected.defaultBadgeStyle).toBe(BETTER_POSTER_VISUAL_DEFAULTS.defaultBadgeStyle)
    expect(projected.defaultAgeBadge).toBe(true)
    expect(projected.defaultPosterLayout).toBe("fresh")
    expect(projected.defaultRatingSources).toEqual(APPLE_VISUAL_DEFAULTS.defaultRatingSources)
    expect(projected.defaultRatingSources).not.toEqual(BETTER_POSTER_VISUAL_DEFAULTS.defaultRatingSources)
    expect((projected.landscape as Record<string, unknown>).minQuality).toBe("1080p")
  })

  it("snapshots complete visual state outside the schema (no credentials)", () => {
    const source = {
      ...APPLE_VISUAL_DEFAULTS,
      landscape: { ...APPLE_VISUAL_DEFAULTS.landscape, minQuality: "1080p", logoAlign: "left" },
      defaultAgeBadge: true,
      defaultAgeCountry: "US",
      defaultPosterLayout: "fresh",
      defaultPosterFreshScope: "ranked",
      tmdbKey: "SECRET",
      customRatingApiKey: "SECRET",
    } as unknown as Record<string, unknown>
    const baseline = captureGuideBaseline(source as never, "u1", "portrait")
    expect(baseline.extraFlats.defaultAgeBadge).toBe(true)
    expect(baseline.extraFlats.defaultPosterLayout).toBe("fresh")
    expect(baseline.landscapeRawFull.minQuality).toBe("1080p")
    expect(baseline.extraFlats).not.toHaveProperty("tmdbKey")
    expect(baseline.extraFlats).not.toHaveProperty("customRatingApiKey")
    const { extraFlats } = extractGuideConflictExtras(source)
    expect(extraFlats.defaultAgeCountry).toBe("US")
    // Unchanged live = fresh; age/layout/land-alignment/minQuality moves = stale.
    const same = captureVisualPreset(source as never)
    expect(isGuideBaselineStale(baseline, same, "u1", "portrait", source)).toBe(false)
    expect(isGuideBaselineStale(baseline, same, "u1", "portrait", { ...source, defaultAgeBadge: false })).toBe(true)
    expect(isGuideBaselineStale(baseline, same, "u1", "portrait", { ...source, defaultPosterLayout: "standard" })).toBe(true)
    expect(isGuideBaselineStale(
      baseline, same, "u1", "portrait",
      { ...source, landscape: { ...(source.landscape as object), logoAlign: "center" } },
    )).toBe(true)
    expect(isGuideBaselineStale(
      baseline, same, "u1", "portrait",
      { ...source, landscape: { ...(source.landscape as object), minQuality: "4K" } },
    )).toBe(true)
  })
})

describe("guide current-origin sparse network + bottom gate", () => {
  const sparseSource = {
    ...APPLE_VISUAL_DEFAULTS,
    defaultNetworkLogoFollowTitle: false,
    defaultNetworkLogoOffsetX: 11,
    defaultNetworkLogoOffsetY: -7,
    // Sparse landscape: relative offsets only, NO own follow flag — the
    // real resolver reads this as follow (inherits the flat toggle but has
    // no fixed layer of its own).
    landscape: { networkLogoOffsetX: 20, networkLogoOffsetY: 30 },
  } as unknown as typeof APPLE_VISUAL_DEFAULTS

  function netView(values: typeof APPLE_VISUAL_DEFAULTS, shape: "poster" | "landscape") {
    const flat = {
      networkLogoFollowTitle: (values as unknown as Record<string, unknown>).defaultNetworkLogoFollowTitle as boolean | null | undefined,
      networkLogoOffsetX: values.defaultNetworkLogoOffsetX,
      networkLogoOffsetY: values.defaultNetworkLogoOffsetY,
    }
    const profile = (values.landscape ?? {}) as unknown as {
      networkLogoFollowTitle?: boolean | null
      networkLogoOffsetX?: number | null
      networkLogoOffsetY?: number | null
    }
    return resolveNetworkEffectiveView(null, flat, profile, shape)
  }

  function netUrl(values: typeof APPLE_VISUAL_DEFAULTS, shape: "poster" | "landscape") {
    return buildDefaultsPreviewUrl({
      defaultNetworkLogoFollowTitle: (values as unknown as Record<string, unknown>).defaultNetworkLogoFollowTitle as boolean | null | undefined,
      defaultNetworkLogoOffsetX: values.defaultNetworkLogoOffsetX,
      defaultNetworkLogoOffsetY: values.defaultNetworkLogoOffsetY,
      landscape: (values.landscape ?? {}) as never,
      previewShape: shape,
    } as never)
  }

  it("untouched current sparse landscape confirm adds no follow flag (byte/pixel-equivalent)", () => {
    const baseline = captureGuideBaseline(sparseSource as never, "u1", "landscape")
    const draft = createGuideDraft(baseline)
    const before = netView(sparseSource, "landscape")
    expect(before.follow).toBe(true)
    const out = buildGuideConfirmValues(baseline, baseline.landscapeRaw, draft, "landscape", "current")
    const land = out.landscape as unknown as Record<string, unknown>
    // No invented inherited override: the sparse profile stays sparse.
    expect("networkLogoFollowTitle" in land).toBe(false)
    expect(land.networkLogoOffsetX).toBe(20)
    expect(land.networkLogoOffsetY).toBe(30)
    expect(out.defaultNetworkLogoFollowTitle).toBe(false)
    // Same effective view + same network URL params as the live state.
    expect(netView(out, "landscape")).toEqual(before)
    const beforeParams = new URL(netUrl(sparseSource, "landscape"), "http://localhost").searchParams
    const afterParams = new URL(netUrl(out, "landscape"), "http://localhost").searchParams
    expect(afterParams.get("netFollow")).toBe(beforeParams.get("netFollow"))
    expect(afterParams.get("nox")).toBe(beforeParams.get("nox"))
    expect(afterParams.get("noy")).toBe(beforeParams.get("noy"))
  })

  it("current landscape edit of an unrelated key preserves follow semantics", () => {
    const baseline = captureGuideBaseline(sparseSource as never, "u1", "landscape")
    const draft = updateGuideDraft(createGuideDraft(baseline), {
      landscape: { badgeGenre: !((sparseSource.landscape as unknown as Record<string, unknown>).badgeGenre ?? true) },
    })
    const out = buildGuideConfirmValues(baseline, baseline.landscapeRaw, draft, "landscape", "current")
    const land = out.landscape as unknown as Record<string, unknown>
    expect("networkLogoFollowTitle" in land).toBe(false)
    expect(land.networkLogoOffsetX).toBe(20)
    expect(land.networkLogoOffsetY).toBe(30)
    // Portrait flats untouched by the landscape edit.
    expect(out.defaultNetworkLogoFollowTitle).toBe(false)
    expect(out.defaultNetworkLogoOffsetX).toBe(11)
    expect(netView(out, "landscape")).toEqual(netView(sparseSource, "landscape"))
    // Preset origin keeps the existing isolated full-look projection (follow
    // materializes there by design) — the sparse path must not.
    const presetOut = buildGuideConfirmValues(baseline, baseline.landscapeRaw, draft, "landscape", "preset")
    expect((presetOut.landscape as unknown as Record<string, unknown>).networkLogoFollowTitle).toBe(false)
  })

  it("nullable flat follow from a legacy preset is retained live (portrait + landscape URL equivalence)", () => {
    const live = {
      ...APPLE_VISUAL_DEFAULTS,
      defaultNetworkLogoFollowTitle: false,
      defaultNetworkLogoOffsetX: 40,
      defaultNetworkLogoOffsetY: -12,
      landscape: { ...APPLE_VISUAL_DEFAULTS.landscape },
    } as unknown as typeof APPLE_VISUAL_DEFAULTS
    const baseline = captureGuideBaseline(live as never, "u1", "portrait")
    const personalNull = {
      ...createGuideDraft(baseline),
      defaultNetworkLogoFollowTitle: null,
    } as unknown as typeof APPLE_VISUAL_DEFAULTS
    // Portrait: the null never overlays — live false survives, and the real
    // provider strip (`applyVisualPreset` drops null) agrees exactly.
    const out = buildGuideConfirmValues(baseline, baseline.landscapeRaw, personalNull, "portrait", "preset")
    expect(out.defaultNetworkLogoFollowTitle).toBe(false)
    const liveParams = new URL(netUrl(live, "poster"), "http://localhost").searchParams
    const outParams = new URL(netUrl(out, "poster"), "http://localhost").searchParams
    expect(outParams.get("netFollow")).toBe("0")
    expect(outParams.get("netFollow")).toBe(liveParams.get("netFollow"))
    expect(outParams.get("nox")).toBe(liveParams.get("nox"))
    expect(outParams.get("noy")).toBe(liveParams.get("noy"))
    // Landscape with the same personal null: flat retained, fixed portrait
    // absolutes never leak into the landscape relative layer.
    const landBaseline = captureGuideBaseline(live as never, "u1", "landscape")
    const landOut = buildGuideConfirmValues(landBaseline, landBaseline.landscapeRaw, personalNull, "landscape", "preset")
    expect(landOut.defaultNetworkLogoFollowTitle).toBe(false)
    const landLiveParams = new URL(netUrl(live, "landscape"), "http://localhost").searchParams
    const landOutParams = new URL(netUrl(landOut, "landscape"), "http://localhost").searchParams
    expect(landOutParams.get("netFollow")).toBe(landLiveParams.get("netFollow"))
    expect(landOutParams.get("nox")).toBe(landLiveParams.get("nox"))
    expect(landOutParams.get("noy")).toBe(landLiveParams.get("noy"))
  })

  it("bottom gate uses master + rating on both shapes (no genre/year lockout when off)", () => {
    for (const shape of ["portrait", "landscape"] as const) {
      const on = isGuideBottomActive({
        defaultGlobalBadges: true,
        defaultBadgeRating: true,
        defaultSeparateRatings: true,
        defaultSeparateRatingsStyle: "bottom-bar",
        shape,
      })
      expect(on).toBe(true)
      // Landscape normalizes bottom-bar via the shared helper (still bottom).
      expect(isGuideBottomActive({
        defaultGlobalBadges: true,
        defaultBadgeRating: true,
        defaultSeparateRatings: true,
        defaultSeparateRatingsStyle: "bottom-pills",
        shape,
      })).toBe(true)
      // Master off or rating off: bottom inactive, genre/year stay enabled.
      expect(isGuideBottomActive({
        defaultGlobalBadges: false,
        defaultBadgeRating: true,
        defaultSeparateRatings: true,
        defaultSeparateRatingsStyle: "bottom-bar",
        shape,
      })).toBe(false)
      expect(isGuideBottomActive({
        defaultGlobalBadges: true,
        defaultBadgeRating: false,
        defaultSeparateRatings: true,
        defaultSeparateRatingsStyle: "bottom-bar",
        shape,
      })).toBe(false)
      expect(isGuideBottomActive({
        defaultGlobalBadges: true,
        defaultBadgeRating: true,
        defaultSeparateRatings: true,
        defaultSeparateRatingsStyle: "column",
        shape,
      })).toBe(false)
      expect(isGuideBottomActive({
        defaultGlobalBadges: true,
        defaultBadgeRating: true,
        defaultSeparateRatings: false,
        defaultSeparateRatingsStyle: "bottom-bar",
        shape,
      })).toBe(false)
    }
  })
})
