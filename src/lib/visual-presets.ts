import { z } from "zod"
import { BADGE_STYLES, RANKING_BADGE_STYLES, EXTRA_BADGE_STYLES, EXTRA_BADGE_FOLLOW_RANK, QUALITY_BADGE_STYLES, BADGE_FONTS, SEPARATE_RATINGS_STYLES, DEFAULT_AGE_BADGE_STYLE, isAgeBadgeStyle, DEFAULT_BADGE_FONT, isBadgeFont, DEFAULT_QUALITY_BADGE_STYLE, isQualityBadgeStyle, isExtraBadgeStyle, isExtraFollowRank, DEFAULT_QUALITY_BADGE_OFFSET_X_LANDSCAPE, DEFAULT_QUALITY_BADGE_OFFSET_Y_LANDSCAPE } from "./badge-styles"
import { KNOWN_VIDEO_FORMATS, isVideoFormat, type VideoFormat } from "./av-specs"
import { SASH_BUCKETS } from "./badge-priority"
import { DEFAULT_AGE_COUNTRY, normalizeCertificationCountry } from "./certification"
import type { LandscapeServerDefaults } from "./server-defaults"

const percent = z.number().finite().min(0).max(100)
const scale = z.number().finite().min(10).max(200)
const offset = z.number().finite().min(-2000).max(2000)
const logoScale = scale.nullable()
const landscapeSchema = z.object({
  logoScale: logoScale.optional(), logoOffsetX: offset.nullable().optional(), logoOffsetY: offset.nullable().optional(),
  gradientHeight: percent.optional(), blurEnabled: z.boolean().optional(), blurIntensity: percent.optional(),
  blurFade: percent.optional(), blurDarkness: percent.optional(), tintStrength: percent.optional(), topShade: percent.optional(),
  topBadgeScale: scale.optional(), topBadgeOffsetX: offset.optional(), topBadgeOffsetY: offset.optional(),
  extraBadgeScale: scale.nullable().optional(),
  extraBadgeOffsetX: offset.nullable().optional(),
  extraBadgeOffsetY: offset.nullable().optional(),
  genreBadgeScale: scale.optional(), genreBadgeOffsetX: offset.optional(), genreBadgeOffsetY: offset.optional(),
  qualityBadgeScale: scale.optional(), qualityBadgeOffsetX: offset.optional(), qualityBadgeOffsetY: offset.optional(),
  separateBadgeScale: scale.optional(),
  separateBadgeOffsetX: offset.optional(),
  separateBadgeOffsetY: offset.optional(),
  // Stile separati per formato: opzionale (assente = segui il flat condiviso).
  separateRatingsStyle: z.enum(SEPARATE_RATINGS_STYLES).optional(),
  networkLogoScale: scale.optional(), networkLogoOffsetX: offset.optional(), networkLogoOffsetY: offset.optional(),
  networkLogoFollowTitle: z.boolean().nullable().optional(),
  // Profilo visuale completo per formato (stesse semantiche di
  // `LandscapeServerDefaults`, mai nuove): assente = eredita i flat.
  // Solo chiavi con corrispondenza flat<->profilo, piu le landscape-only
  // gia supportate dal renderer (extraBadgeStyle/badgeFont/wide).
  globalBadges: z.boolean().optional(), rankingBadges: z.boolean().optional(),
  badgeGenre: z.boolean().optional(), badgeYear: z.boolean().optional(),
  badgeRating: z.boolean().optional(), badgeQuality: z.boolean().optional(),
  customRatings: z.boolean().optional(), separateRatings: z.boolean().optional(),
  badgeStyle: z.enum(BADGE_STYLES).optional(),
  rankingBadgeStyle: z.enum(RANKING_BADGE_STYLES).optional(),
  extraBadgeStyle: z.union([z.enum(EXTRA_BADGE_STYLES), z.literal(EXTRA_BADGE_FOLLOW_RANK)]).nullable().optional(),
  badgeFont: z.enum(BADGE_FONTS).nullable().optional(),
  qualityBadgeStyle: z.enum(QUALITY_BADGE_STYLES).nullable().optional(),
  videoFormats: z.array(z.enum(["dv", "hdr", "hdr10plus", "atmos", "imax"])).max(5).nullable().optional(),
  sashOrder: z.array(z.enum(SASH_BUCKETS)).max(SASH_BUCKETS.length).optional(),
  networkLogo: z.boolean().optional(), networkLogoPosition: z.enum(["auto", "top"]).optional(),
  preRelease: z.boolean().optional(),
  ribbonEnabled: z.boolean().optional(), ribbonSide: z.enum(["left", "right"]).optional(),
}).strict()

/** Only visual defaults: credentials, providers, catalogs and region never enter a preset. */
export const visualPresetValuesSchema = z.object({
  defaultGlobalBadges: z.boolean(), defaultRankingBadges: z.boolean(),
  defaultBadgeGenre: z.boolean(), defaultBadgeYear: z.boolean(), defaultBadgeRating: z.boolean(), defaultBadgeQuality: z.boolean(),
  defaultCustomRatings: z.boolean(), defaultSeparateRatings: z.boolean(),
  defaultRatingSources: z.array(z.string().max(20)).max(20),
  defaultSashOrder: z.array(z.enum(SASH_BUCKETS)).max(SASH_BUCKETS.length),
  defaultBadgeStyle: z.enum(BADGE_STYLES), defaultRankingBadgeStyle: z.enum(RANKING_BADGE_STYLES),
  // Preset salvati prima del selettore font: assente = "inter" (resa storica).
  defaultBadgeFont: z.enum(BADGE_FONTS).default("inter"),
  defaultQualityBadgeStyle: z.enum(QUALITY_BADGE_STYLES),
  defaultVideoFormats: z.array(z.enum(["dv", "hdr", "hdr10plus", "atmos", "imax"])).max(5),
  defaultLogoScale: logoScale, defaultLogoOffsetX: offset.nullable(), defaultLogoOffsetY: offset.nullable(),
  defaultBlurEnabled: z.boolean(), defaultBlurIntensity: percent, defaultBlurFade: percent, defaultBlurDarkness: percent,
  defaultTintStrength: percent, defaultTopShade: percent, defaultGradientHeight: percent,
  defaultTopBadgeScale: scale, defaultTopBadgeOffsetX: offset, defaultTopBadgeOffsetY: offset,
  // Tuning EXTRA superiore: opzionale+nullable (preset legacy senza campo
  // restano validi; null/assente = fallback legacy classifica).
  defaultExtraBadgeScale: scale.nullable().optional(),
  defaultExtraBadgeOffsetX: offset.nullable().optional(),
  defaultExtraBadgeOffsetY: offset.nullable().optional(),
  defaultGenreBadgeScale: scale, defaultGenreBadgeOffsetX: offset, defaultGenreBadgeOffsetY: offset,
  defaultQualityBadgeScale: scale, defaultQualityBadgeOffsetX: offset, defaultQualityBadgeOffsetY: offset,
  // Scala separati aggiunta dopo: default(130) per i preset salvati senza campo
  // (legacy); un 100 salvato esplicito si preserva (niente migrazione).
  defaultSeparateBadgeScale: scale.default(130),
  // Offset separati: default 0 per i preset salvati senza campo
  // (byte-identici ai legacy).
  defaultSeparateBadgeOffsetX: offset.default(0),
  defaultSeparateBadgeOffsetY: offset.default(0),
  // Stile separati aggiunto dopo: default("column") per non invalidare i preset salvati.
  defaultSeparateRatingsStyle: z.enum(SEPARATE_RATINGS_STYLES).default("column"),
  defaultNetworkLogoScale: scale, defaultNetworkLogoOffsetX: offset, defaultNetworkLogoOffsetY: offset,
  defaultNetworkLogo: z.boolean(), defaultNetworkLogoPosition: z.enum(["auto", "top"]), defaultPreRelease: z.boolean(),
  // Follow aggiunto dopo: opzionale per non invalidare preset salvati
  // (legacy senza campo) né forzare lo stato editor; null/assente = eredita.
  defaultNetworkLogoFollowTitle: z.boolean().nullable().optional(),
  defaultRibbonEnabled: z.boolean(), defaultRibbonSide: z.enum(["left", "right"]),
  defaultPosterShape: z.enum(["poster", "landscape"]), defaultLogoAlign: z.enum(["left", "center"]).nullable(),
  defaultPortraitFitEnabled: z.boolean(), defaultLandscapeFitEnabled: z.boolean(),
  landscape: landscapeSchema,
}).strict()

export type VisualPresetValues = z.infer<typeof visualPresetValuesSchema>
/** Orientation list an entry belongs to. Legacy entries without shape read as portrait. */
export const visualPresetShapeSchema = z.enum(["portrait", "landscape"])
export type VisualPresetShape = z.infer<typeof visualPresetShapeSchema>
export const visualPresetInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
  shape: visualPresetShapeSchema.default("portrait"),
  values: visualPresetValuesSchema,
}).strict()
export const visualPresetSchema = visualPresetInputSchema.extend({ id: z.string().uuid() })
export const visualPresetDeleteSchema = z.object({
  id: z.string().uuid(),
  shape: visualPresetShapeSchema.default("portrait"),
}).strict()
export type VisualPreset = z.infer<typeof visualPresetSchema>
/** Quota applies PER shape: 20 portrait + 20 landscape, same name allowed across shapes. */
export const MAX_VISUAL_PRESETS = 20

/**
 * Removed-feature compat (Fresh numeral font, dropped: the rank numeral
 * always renders the historic Inter now). Snapshots saved while the selector
 * existed may still carry `freshNumeralFont` (landscape profile) or
 * `defaultFreshNumeralFont` (flats). The preset schemas above are `.strict()`,
 * so one obsolete key would reject the whole stored preset — strip them
 * before validation (the non-strict mapping/token schemas shed the same keys
 * automatically). Pure; never read — no resolver consumes these keys.
 */
export function stripRemovedFreshFontKeys<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value
  if (Array.isArray(value)) return value.map(stripRemovedFreshFontKeys) as T
  const rec = value as Record<string, unknown>
  let out = rec
  if ("freshNumeralFont" in out || "defaultFreshNumeralFont" in out) {
    out = { ...out }
    delete out.freshNumeralFont
    delete out.defaultFreshNumeralFont
  }
  const land = out.landscape
  if (land !== null && typeof land === "object" && !Array.isArray(land) && "freshNumeralFont" in land) {
    out = { ...out, landscape: stripRemovedFreshFontKeys(land) }
  }
  const values = (out as Record<string, unknown>).values
  if (values !== null && typeof values === "object") {
    const stripped = stripRemovedFreshFontKeys(values)
    if (stripped !== values) out = { ...out, values: stripped }
  }
  return out as T
}

/**
 * Normalize a preset snapshot's extra tuning to its own classifica values
 * (per axis, flat + nested landscape profile with flat fallback): a legacy
 * preset without explicit extra renders with its own rank tuning, so the
 * normalized form is what apply writes and what highlight compares. Modern
 * explicit extra always wins (never overwritten). Key order follows the
 * schema sequences, so normalized snapshots stringify identically on both
 * sides of a highlight compare. Pure.
 */
/**
 * Snapshot shape accepted by normalizePresetExtraTuning (full preset values,
 * portrait projections and bare landscape profiles all satisfy it).
 */
export interface ExtraNormalizableSnapshot {
  defaultTopBadgeScale?: number | null
  defaultTopBadgeOffsetX?: number | null
  defaultTopBadgeOffsetY?: number | null
  defaultExtraBadgeScale?: number | null
  defaultExtraBadgeOffsetX?: number | null
  defaultExtraBadgeOffsetY?: number | null
  topBadgeScale?: number | null
  topBadgeOffsetX?: number | null
  topBadgeOffsetY?: number | null
  extraBadgeScale?: number | null
  extraBadgeOffsetX?: number | null
  extraBadgeOffsetY?: number | null
  landscape?: {
    topBadgeScale?: number | null
    topBadgeOffsetX?: number | null
    topBadgeOffsetY?: number | null
    extraBadgeScale?: number | null
    extraBadgeOffsetX?: number | null
    extraBadgeOffsetY?: number | null
  } | null
  [k: string]: unknown
}

export function normalizePresetExtraTuning<T extends ExtraNormalizableSnapshot>(snapshot: T): T {
  const flat = { ...(snapshot as Record<string, unknown>) }
  // Original flat extra (pre-fill): the landscape fallback must see the
  // snapshot's own values, not the filled ones below.
  const origFlatExS = flat.defaultExtraBadgeScale
  const origFlatExX = flat.defaultExtraBadgeOffsetX
  const origFlatExY = flat.defaultExtraBadgeOffsetY
  // Flat defaults level.
  if (flat.defaultExtraBadgeScale == null && flat.defaultTopBadgeScale != null)
    flat.defaultExtraBadgeScale = flat.defaultTopBadgeScale
  if (flat.defaultExtraBadgeOffsetX == null && flat.defaultTopBadgeOffsetX != null)
    flat.defaultExtraBadgeOffsetX = flat.defaultTopBadgeOffsetX
  if (flat.defaultExtraBadgeOffsetY == null && flat.defaultTopBadgeOffsetY != null)
    flat.defaultExtraBadgeOffsetY = flat.defaultTopBadgeOffsetY
  // Bare profile level (resolveEffectiveLandscape outputs the profile
  // itself, not wrapped): same fill from its own rank tuning.
  if (flat.extraBadgeScale == null && flat.topBadgeScale != null)
    flat.extraBadgeScale = flat.topBadgeScale
  if (flat.extraBadgeOffsetX == null && flat.topBadgeOffsetX != null)
    flat.extraBadgeOffsetX = flat.topBadgeOffsetX
  if (flat.extraBadgeOffsetY == null && flat.topBadgeOffsetY != null)
    flat.extraBadgeOffsetY = flat.topBadgeOffsetY
  // Nested landscape profile, only when it carries its own rank look
  // (otherwise it keeps inheriting and stays sparse): missing axes resolve
  // exactly like the server (profile extra > flat extra > profile rank >
  // flat rank), so filling is pixel-identical either way.
  const land = flat.landscape
  if (land != null && typeof land === "object") {
    const l = { ...(land as Record<string, unknown>) }
    const landHasRank = l.topBadgeScale !== undefined || l.topBadgeOffsetX !== undefined || l.topBadgeOffsetY !== undefined
    if (landHasRank) {
      if (l.extraBadgeScale == null)
        l.extraBadgeScale = origFlatExS ?? l.topBadgeScale ?? flat.defaultTopBadgeScale
      if (l.extraBadgeOffsetX == null)
        l.extraBadgeOffsetX = origFlatExX ?? l.topBadgeOffsetX ?? flat.defaultTopBadgeOffsetX
      if (l.extraBadgeOffsetY == null)
        l.extraBadgeOffsetY = origFlatExY ?? l.topBadgeOffsetY ?? flat.defaultTopBadgeOffsetY
    }
    flat.landscape = l
  }
  // Canonical key order (schema sequences): filled keys must not trail after
  // raw literals, or identical looks stringify differently. Bare profiles
  // follow the landscape sequence instead.
  const bareProfile = !("defaultTopBadgeScale" in flat) && !("defaultExtraBadgeScale" in flat)
    && ("topBadgeScale" in flat || "extraBadgeScale" in flat)
  const topOrder = bareProfile
    ? Object.keys(landscapeSchema.shape)
    : Object.keys(visualPresetValuesSchema.shape)
  const ordered: Record<string, unknown> = {}
  for (const k of topOrder) {
    if (k in flat) ordered[k] = flat[k]
  }
  for (const k of Object.keys(flat)) {
    if (!(k in ordered)) ordered[k] = flat[k]
  }
  const orderedLand = ordered.landscape
  if (orderedLand != null && typeof orderedLand === "object") {
    const l = orderedLand as Record<string, unknown>
    const landOrdered: Record<string, unknown> = {}
    for (const k of Object.keys(landscapeSchema.shape)) {
      if (k in l) landOrdered[k] = l[k]
    }
    for (const k of Object.keys(l)) {
      if (!(k in landOrdered)) landOrdered[k] = l[k]
    }
    ordered.landscape = landOrdered
  }
  return ordered as T
}

export function captureVisualPreset(source: VisualPresetValues): VisualPresetValues {
  return visualPresetValuesSchema.parse(Object.fromEntries(
    Object.keys(visualPresetValuesSchema.shape).map((key) => [
      key,
      // Nested landscape passes through raw: pick only schema-known keys so
      // profile overrides outside the preset contract never crash capture.
      // Drop explicit `undefined` too: fromEntries would otherwise mint own
      // undefined keys that zod preserves through parse (invisible to JSON
      // but fatal to Object.assign/spread overlays, which copy undefined over
      // real values). Absent always means "inherit".
      key === "landscape" && source.landscape && typeof source.landscape === "object"
        ? Object.fromEntries(
            Object.entries(source.landscape as Record<string, unknown>).filter(
              ([k, v]) => v !== undefined && k in landscapeSchema.shape,
            ),
          )
        : source[key as keyof VisualPresetValues],
    ]),
  ))
}

/**
 * Canonical flat `defaultX` -> landscape profile `x` key map (same content as
 * the Badge tab `PRESET_TO_LAND`: rating sources, logo align, fit flags and
 * delivery shape stay global and are intentionally absent).
 */
export const PRESET_FLAT_TO_LANDSCAPE: Record<string, keyof LandscapeServerDefaults> = {
  defaultGlobalBadges: "globalBadges",
  defaultRankingBadges: "rankingBadges",
  defaultBadgeGenre: "badgeGenre",
  defaultBadgeYear: "badgeYear",
  defaultBadgeRating: "badgeRating",
  defaultBadgeQuality: "badgeQuality",
  defaultCustomRatings: "customRatings",
  defaultSeparateRatings: "separateRatings",
  defaultSeparateRatingsStyle: "separateRatingsStyle",
  defaultBadgeStyle: "badgeStyle",
  defaultRankingBadgeStyle: "rankingBadgeStyle",
  defaultBadgeFont: "badgeFont",
  defaultQualityBadgeStyle: "qualityBadgeStyle",
  defaultVideoFormats: "videoFormats",
  defaultSashOrder: "sashOrder",
  defaultNetworkLogo: "networkLogo",
  defaultNetworkLogoPosition: "networkLogoPosition",
  defaultNetworkLogoFollowTitle: "networkLogoFollowTitle",
  defaultPreRelease: "preRelease",
  defaultRibbonEnabled: "ribbonEnabled",
  defaultRibbonSide: "ribbonSide",
  defaultLogoScale: "logoScale",
  defaultLogoOffsetX: "logoOffsetX",
  defaultLogoOffsetY: "logoOffsetY",
  defaultBlurEnabled: "blurEnabled",
  defaultBlurIntensity: "blurIntensity",
  defaultBlurFade: "blurFade",
  defaultBlurDarkness: "blurDarkness",
  defaultTintStrength: "tintStrength",
  defaultTopShade: "topShade",
  defaultGradientHeight: "gradientHeight",
  defaultTopBadgeScale: "topBadgeScale",
  defaultTopBadgeOffsetX: "topBadgeOffsetX",
  defaultTopBadgeOffsetY: "topBadgeOffsetY",
  defaultExtraBadgeScale: "extraBadgeScale",
  defaultExtraBadgeOffsetX: "extraBadgeOffsetX",
  defaultExtraBadgeOffsetY: "extraBadgeOffsetY",
  defaultGenreBadgeScale: "genreBadgeScale",
  defaultGenreBadgeOffsetX: "genreBadgeOffsetX",
  defaultGenreBadgeOffsetY: "genreBadgeOffsetY",
  defaultQualityBadgeScale: "qualityBadgeScale",
  defaultQualityBadgeOffsetX: "qualityBadgeOffsetX",
  defaultQualityBadgeOffsetY: "qualityBadgeOffsetY",
  defaultSeparateBadgeScale: "separateBadgeScale",
  defaultSeparateBadgeOffsetX: "separateBadgeOffsetX",
  defaultSeparateBadgeOffsetY: "separateBadgeOffsetY",
  defaultNetworkLogoScale: "networkLogoScale",
  defaultNetworkLogoOffsetX: "networkLogoOffsetX",
  defaultNetworkLogoOffsetY: "networkLogoOffsetY",
}

/**
 * Portrait projection: mapped flat keys ONLY (allowlist, not all flats).
 * Excluded and why:
 * - `landscape`: the other orientation profile — portrait never writes it
 *   (frozen separately by `applyPortraitIsolated`).
 * - `defaultPosterShape`: delivery format, never follows a preset (Badge tab precedent).
 * - `defaultRatingSources`: vote sources shared by server design, no profile key.
 * - `defaultLogoAlign`, `defaultPortraitFitEnabled`, `defaultLandscapeFitEnabled`:
 *   global toggles affecting both formats, no per-shape counterpart.
 * (Credentials/providers/catalogs/region/date-format were never in presets.)
 */
export function portraitPresetPatch(values: VisualPresetValues): Partial<VisualPresetValues> {
  const source = values as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const flatKey of Object.keys(PRESET_FLAT_TO_LANDSCAPE)) {
    const v = source[flatKey]
    if (v !== undefined) out[flatKey] = v
  }
  return out as Partial<VisualPresetValues>
}

/**
 * Landscape apply patch: profile ONLY, zero flat/global side effects.
 * Flat-derived keys resolve first, the snapshot's own nested landscape wins
 * (same precedence as the Badge tab snapshot apply). Absent keys stay absent
 * (inherit flats at render via `effectiveDefaultsForShape`).
 */
export function landscapeProfilePatch(values: VisualPresetValues): Partial<LandscapeServerDefaults> {
  const patch: Record<string, unknown> = {}
  const flatFixed = isFlatFixedLayer(values as unknown as Record<string, unknown>)
  for (const [flatKey, landKey] of Object.entries(PRESET_FLAT_TO_LANDSCAPE)) {
    if (flatFixed && NO_FLAT_DERIVED_LANDSCAPE_KEYS.has(landKey)) continue
    const v = (values as Record<string, unknown>)[flatKey]
    if (v !== undefined) patch[landKey] = v
  }
  if (values.landscape) {
    for (const [k, v] of Object.entries(values.landscape)) {
      if (v !== undefined) patch[k] = v
    }
  }
  return patch as Partial<LandscapeServerDefaults>
}

/** Reverse lookup for effective resolution (profile key -> flat key). */
const LANDSCAPE_TO_FLAT: Record<string, string> = Object.fromEntries(
  Object.entries(PRESET_FLAT_TO_LANDSCAPE).map(([flatKey, landKey]) => [landKey, flatKey]),
)

/**
 * Profile keys where explicit `null` means "inherit the flat" on BOTH sides
 * (server spread keeps null, every consumer normalizes: `pick(land.x ??
 * undefined, flat)` in poster-url.ts, `??` chains in poster-config.ts and
 * client `land ?? flat`). Logo scale/offsets are NOT in here: their null is
 * an explicit auto/zero contract that wins `pick`. The standalone extra
 * style is NOT in here either (task 3B2): its profile `null` is the explicit
 * shape-local "follow my own rank" marker (ribbon/numeral ranks stay
 * reachable only through it — no stored subset value can pin them), so it
 * wins over the flat instead of falling through. Keep in sync with the
 * poster-url normalization list.
 */
const NULL_INHERIT_LANDSCAPE_KEYS = new Set(["badgeFont", "qualityBadgeStyle", "videoFormats"])

/**
 * Network fixed coords never derive from the flat into the landscape
 * profile WHEN the flat layer is fixed (follow===false): absolute coords are
 * per-shape, and a flat copy would later read as an explicit fixed landscape
 * layer (portrait values rendered on LAND). In ON mode the legacy
 * derive/freeze is preserved byte-identically (relative offsets keep
 * inheriting at render via `??` chains). The toggle keeps its flat
 * derivation (harmless: coords gate the fixed layer). Explicit profile
 * values always pass through untouched.
 */
const NO_FLAT_DERIVED_LANDSCAPE_KEYS = new Set(["networkLogoOffsetX", "networkLogoOffsetY"])

/** True when the flat network layer is fixed (absolute portrait coords). */
function isFlatFixedLayer(values: Record<string, unknown>): boolean {
  return values["defaultNetworkLogoFollowTitle"] === false
}

function presetValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (typeof a === "object") return JSON.stringify(a) === JSON.stringify(b)
  return false
}

/**
 * Effective landscape profile: every supported key resolved as
 * profile-override ?? flat (same precedence as `useShapeBadgeDefaults` and
 * server `effectiveDefaultsForShape`, plus the established null-inheritance:
 * explicit `null` on NULL_INHERIT_LANDSCAPE_KEYS falls through to the flat,
 * logo nulls and the standalone extra-style `null` (task 3B2 follow-own-rank
 * marker) stay explicit per their shape-local contract). Landscape-only keys
 * pass through raw. Absent stays absent (still inherits at render). Used for
 * landscape saves and highlight. Never emits `null` for inherit-null keys,
 * so save bodies stay strict-clean.
 */
export function resolveEffectiveLandscape(values: VisualPresetValues): VisualPresetValues["landscape"] {
  const land = ((values.landscape ?? {}) as Record<string, unknown>)
  const source = values as unknown as Record<string, unknown>
  const flatFixed = isFlatFixedLayer(source)
  const out: Record<string, unknown> = {}
  for (const landKey of Object.keys(landscapeSchema.shape)) {
    const raw = land[landKey]
    const rawIsInheritNull = raw === null && (NULL_INHERIT_LANDSCAPE_KEYS.has(landKey) || landKey === "extraBadgeStyle")
    if (raw !== undefined && !rawIsInheritNull) {
      out[landKey] = raw
      continue
    }
    if (flatFixed && NO_FLAT_DERIVED_LANDSCAPE_KEYS.has(landKey)) continue
    const flatKey = LANDSCAPE_TO_FLAT[landKey]
    if (flatKey !== undefined) {
      const v = source[flatKey]
      if (v === undefined) continue
      if (v === null && NULL_INHERIT_LANDSCAPE_KEYS.has(landKey)) continue
      if (landKey === "extraBadgeStyle") {
        // Flat legacy (null/absent/garbage) materializes the explicit
        // follow-rank sentinel (pixel-identical own-rank, leak-proof);
        // concrete flats and stored sentinels copy verbatim.
        if (v === null || v === undefined) {
          out[landKey] = EXTRA_BADGE_FOLLOW_RANK
        } else if (isExtraFollowRank(v) || isExtraBadgeStyle(typeof v === "string" ? v : null)) {
          out[landKey] = v
        } else {
          out[landKey] = EXTRA_BADGE_FOLLOW_RANK
        }
        continue
      }
      if (v !== undefined && !(v === null && NULL_INHERIT_LANDSCAPE_KEYS.has(landKey))) out[landKey] = v
    }
  }
  return out as VisualPresetValues["landscape"]
}

/**
 * Portrait apply with effective-landscape preservation (single atomic patch
 * for a merge-`update`): FIRST freeze the current effective landscape into
 * the profile for keys the preset will change while the profile inherits
 * them — absent keys AND explicit `null` on null-inheriting keys (both mean
 * "follow the flat" on both sides); existing concrete overrides (including
 * explicit logo `null`, which is an auto/zero choice, not inheritance) are
 * untouched. THEN write the mapped portrait flats. Globals and delivery stay
 * byte-identical, so the other format's effective output cannot move.
 * Surgical: keys the preset leaves equal keep inheriting (sparsity).
 * NOTE: `current.landscape` may carry raw extras outside the preset contract
 * (e.g. server-supported `minQuality`); they pass through opaquely — callers
 * must merge the raw profile in (UI does), never a schema-stripped copy.
 */
export function applyPortraitIsolated(current: VisualPresetValues, preset: VisualPresetValues): VisualPresetValues {
  const cur = current as unknown as Record<string, unknown>
  const pre = preset as unknown as Record<string, unknown>
  const landscape = { ...((cur.landscape as Record<string, unknown> | undefined) ?? {}) }
  // Mai congelare coordinate assolute da un flat fixed (né verso un preset
  // fixed): creerebbero un fixed landscape finto con valori portrait.
  const skipCoords = isFlatFixedLayer(cur) || isFlatFixedLayer(pre)
  for (const [flatKey, landKey] of Object.entries(PRESET_FLAT_TO_LANDSCAPE)) {
    if (skipCoords && NO_FLAT_DERIVED_LANDSCAPE_KEYS.has(landKey)) continue
    const inherited = landscape[landKey] === undefined ||
      (landscape[landKey] === null && (SHAPE_NULL_INHERIT_KEYS.has(landKey as string) || landKey === "extraBadgeStyle"))
    if (inherited && pre[flatKey] !== undefined && cur[flatKey] !== undefined && !presetValuesEqual(pre[flatKey], cur[flatKey])) {
      // Inherit-key flats with no concrete value freeze the canonical
      // pre-edit effective (a raw `null` would keep following, not freeze).
      // The extra-style legacy fallback freezes the explicit "follow-rank"
      // sentinel (follow own rank); logoAlign freezes its landscape
      // auto ("left").
      const curV = cur[flatKey]
      if ((curV === null || curV === undefined) && (SHAPE_NULL_INHERIT_KEYS.has(landKey as string) || landKey === "extraBadgeStyle")) {
        const frozen = canonicalInheritFreeze(landKey as string, curV)
        if (frozen.freeze) landscape[landKey] = frozen.value
      } else {
        landscape[landKey] = curV
      }
    }
  }
  return { ...current, ...portraitPresetPatch(preset), landscape } as unknown as VisualPresetValues
}

/**
 * Landscape apply, symmetric counterpart: profile ONLY (current profile
 * extras — including raw keys outside the preset contract — preserved
 * underneath, snapshot wins on top), flats/globals/delivery byte-identical —
 * portrait effective output cannot move. Single atomic patch for a
 * merge-`update`. Callers must pass the raw profile in `current.landscape`
 * (see applyPortraitIsolated NOTE).
 */
export function applyLandscapeIsolated(current: VisualPresetValues, preset: VisualPresetValues): VisualPresetValues {
  const currentLand = { ...(((current.landscape ?? {}) as unknown) as Record<string, unknown>) }
  const patch = landscapeProfilePatch(preset) as unknown as Record<string, unknown>
  return { ...current, landscape: { ...currentLand, ...patch } } as unknown as VisualPresetValues
}

/**
 * Strict shape-independence foundation (task 3B1): the FULL flat→profile key
 * map for snapshotting. PRESET_FLAT_TO_LANDSCAPE above covers the preset
 * contract only; the age trio and the cover layout/scope pair live in the
 * server profile (`LandscapeServerDefaults`), the API schema and the scoped
 * UI bindings with the same follow semantics, so they snapshot identically.
 * Globals without a profile counterpart (rating sources, fit flags,
 * delivery shape, region, date format, endpoints) stay absent by design
 * (minQuality keeps its server profile key with no UI and no snapshot —
 * never claimed here).
 */
export const SHAPE_FLAT_TO_LANDSCAPE: Record<string, keyof LandscapeServerDefaults> = {
  ...PRESET_FLAT_TO_LANDSCAPE,
  defaultAgeBadge: "ageBadge",
  defaultAgeCountry: "ageCountry",
  defaultAgeBadgeStyle: "ageBadgeStyle",
  defaultPosterLayout: "posterLayout",
  defaultPosterFreshScope: "posterFreshScope",
  /** Standalone extra style (profile override, absent = legacy `rs` fallback). */
  defaultExtraBadgeStyle: "extraBadgeStyle",
  /**
   * Logo-block alignment (profile override; absent/null = follow the flat,
   * flat null = per-shape auto: portrait "center", landscape "left").
   */
  defaultLogoAlign: "logoAlign",
}

/**
 * Bare API/storage key (no `default` prefix) → profile key, derived from the
 * map above. The server PUT body and the stored payload use bare names
 * (`badgeStyle`, `ageBadge`, …) while the client state uses `default*`.
 */
export const SHAPE_BARE_TO_LANDSCAPE: Record<string, keyof LandscapeServerDefaults> = Object.fromEntries(
  Object.entries(SHAPE_FLAT_TO_LANDSCAPE).map(([flatKey, landKey]) => [
    flatKey.charAt(7).toLowerCase() + flatKey.slice(8),
    landKey,
  ]),
) as Record<string, keyof LandscapeServerDefaults>

/**
 * Profile keys where explicit `null` means "inherit the flat" (same contract
 * as NULL_INHERIT_LANDSCAPE_KEYS above, plus the nullable follow toggle, the
 * nullable age style and the nullable logo alignment, which the render
 * chains normalize via `??` fallthrough: poster-url `land.x ?? undefined`,
 * poster-config `??` chains, route `earlyEffSd.x ?? sd.x`, network-follow
 * `??` merges). Logo scale/offsets, extra tuning `null`s AND the standalone
 * extra-style `null` are NOT in here: their null is an explicit shape-local
 * choice (auto/zero/own-rank/follow-own-rank) that wins — poster-config and
 * the preview builder read them off the raw profile with ownership checks,
 * so a profile `null` shadows the flat instead of falling through.
 * Snapshot rule: a profile `null` on these keys is INHERITING (missing), so
 * the independence boundary freezes the pre-edit effective value into it
 * (logoAlign freezes its landscape auto, "left"); logo/extra-tuning/
 * extra-style `null`s stay explicit and are never snapshotted over.
 */
export const SHAPE_NULL_INHERIT_KEYS: ReadonlySet<string> = new Set([
  ...NULL_INHERIT_LANDSCAPE_KEYS,
  "networkLogoFollowTitle",
  "ageBadgeStyle",
  "logoAlign",
])

/**
 * Canonical pre-edit effective value for an inherit-`null`/absent flat at the
 * independence boundary (task 3B1 recovery): what the renderer actually shows
 * before the edit, so freezing it is pixel-identical and later portrait edits
 * cannot leak. Mirrors the render chains exactly (validated value wins,
 * otherwise the hardcoded historic default the chains fall back to):
 * - badgeFont: valid font else "inter" (poster-config `isBadgeFont ? : inter`);
 * - qualityBadgeStyle: valid style else "standard" (same fail-closed chain);
 * - videoFormats: array (sanitized copy, like useDefaults hydration) else the
 *   full known list (route shows every available format when allowed is
 *   null/absent);
 * - networkLogoFollowTitle: boolean else true (resolver `?? true`);
 * - ageBadgeStyle: valid style else "standard" (resolveAgeBadgeRequest);
 * - extraBadgeStyle: valid style freezes verbatim; null/absent/garbage
 *   freezes the explicit shape-local `null` marker ("follow my own rank"):
 *   pixel-identical today (the flat is legacy too, so both shapes already
 *   render their own `rs`), and later portrait extra edits can no longer leak
 *   across. A profile `null` is explicit (never re-frozen), so the landscape
 *   keeps tracking its own rank — including ribbon/numeral styles with no
 *   subset counterpart — instead of the portrait style.
 * - logoAlign: valid side freezes verbatim; null/absent freezes the
 *   landscape auto ("left" — exactly what the pre-edit pixels show, since a
 *   null flat resolves per-shape).
 * Returns `{ freeze: false }` only for keys with no canonical render value
 * (non-visual or fully flat-driven keys).
 * Pure; client- and server-safe (av-specs imports JSON data only).
 */
export function canonicalInheritFreeze(
  landKey: string,
  flatValue: unknown,
): { freeze: boolean; value?: unknown } {
  switch (landKey) {
    case "badgeFont":
      return {
        freeze: true,
        value: isBadgeFont(typeof flatValue === "string" ? flatValue : null)
          ? flatValue
          : DEFAULT_BADGE_FONT,
      }
    case "qualityBadgeStyle":
      return {
        freeze: true,
        value: isQualityBadgeStyle(typeof flatValue === "string" ? flatValue : null)
          ? flatValue
          : DEFAULT_QUALITY_BADGE_STYLE,
      }
    case "videoFormats":
      return {
        freeze: true,
        value: Array.isArray(flatValue)
          ? (flatValue as unknown[]).filter((v): v is VideoFormat => isVideoFormat(typeof v === "string" ? v : null))
          : [...KNOWN_VIDEO_FORMATS],
      }
    case "networkLogoFollowTitle":
      return {
        freeze: true,
        value: typeof flatValue === "boolean" ? flatValue : true,
      }
    case "ageBadgeStyle":
      return {
        freeze: true,
        value: isAgeBadgeStyle(typeof flatValue === "string" ? flatValue : null)
          ? flatValue
          : DEFAULT_AGE_BADGE_STYLE,
      }
    case "extraBadgeStyle":
      if (isExtraBadgeStyle(typeof flatValue === "string" ? flatValue : null)) {
        return { freeze: true, value: flatValue }
      }
      if (isExtraFollowRank(flatValue)) {
        return { freeze: true, value: EXTRA_BADGE_FOLLOW_RANK }
      }
      return { freeze: true, value: EXTRA_BADGE_FOLLOW_RANK }
    case "logoAlign":
      return flatValue === "left" || flatValue === "center"
        ? { freeze: true, value: flatValue }
        : { freeze: true, value: "left" }
    default:
      return { freeze: false }
  }
}

/**
 * Whether a profile key already carries an explicit landscape value (never
 * re-snapshotted, never rebased after an edit). `undefined` — plus `null` on
 * the inherit keys above (which every render chain normalizes as "follow the
 * flat": poster-url `??`, poster-config `??`, route `??`, network-follow
 * merges) and invalid age values (which render as follow/fallback) — counts
 * as inheriting; everything else — including `false`/`0`/`[]` and the
 * explicit logo/extra `null`s (auto/zero/own-rank shape-local contracts that
 * shadow the flat) — wins over the flat.
 */
export function isLandscapeKeyPresent(
  landscape: Record<string, unknown>,
  landKey: string,
): boolean {
  const v = landscape[landKey]
  // Inherit-`null`: still following the flat, so the boundary must freeze it
  // (a stored `null` here never renders on its own).
  if (v === null && SHAPE_NULL_INHERIT_KEYS.has(landKey)) return false
  // Standalone extra style: legacy `null`/absent inherits the flat (old
  // contract, byte-identical); only the explicit "follow-rank" sentinel and
  // concrete subset styles count as present (own-rank shadowing the flat).
  if (landKey === "extraBadgeStyle") return v !== undefined && v !== null
  // Absent, or invalid age values (which render as follow, fail-closed).
  // Any other `null` is an explicit shape-local choice (logo auto/zero):
  // never treated as missing, never snapshotted over.
  if (v === undefined || v === null) return v !== undefined
  if (landKey === "ageCountry") return normalizeCertificationCountry(v) != null
  if (landKey === "ageBadge") return typeof v === "boolean"
  if (landKey === "ageBadgeStyle") return isAgeBadgeStyle(typeof v === "string" ? v : null)
  return true
}

function cloneSnapshotValue(v: unknown): unknown {
  return Array.isArray(v) ? [...v] : v
}

/**
 * Freeze the effective pre-edit flat values into the profile for inherited
 * keys (appearance-preserving migration: the pixels don't move, later flat
 * edits can't leak). Only `flatKeys` are considered; present profile keys
 * (explicit values, never touched) are skipped; arrays are cloned so the
 * snapshot never aliases the live flat. Skips the network fixed offsets when
 * the flat layer itself is fixed (`follow === false`): absolute coords are
 * per-shape and a flat copy would render as a fake fixed landscape layer
 * (same guard as applyPortraitIsolated). Pure; client- and server-safe
 * (no fs imports — this module stays browser-safe).
 */
export function snapshotMissingLandscape(
  flats: Record<string, unknown>,
  landscape: Record<string, unknown>,
  flatKeys: readonly string[],
): Partial<LandscapeServerDefaults> {
  const adds: Record<string, unknown> = {}
  const flatFixed = flats.defaultNetworkLogoFollowTitle === false
  for (const flatKey of flatKeys) {
    const landKey = SHAPE_FLAT_TO_LANDSCAPE[flatKey]
    if (landKey === undefined) continue
    if (isLandscapeKeyPresent(landscape, landKey)) continue
    if (
      flatFixed &&
      (landKey === "networkLogoOffsetX" || landKey === "networkLogoOffsetY")
    ) {
      continue
    }
    const v = flats[flatKey]
    // The standalone extra style is not an inherit-null key (its profile
    // `null` is the explicit follow-own-rank marker, never missing), but a
    // legacy flat (null/absent — e.g. a first-ever direct API edit with no
    // stored flat to normalize) still renders something pre-edit (its own
    // rank), so it freezes the same canonical marker: pixel-identical now,
    // leak-proof later. Concrete flats copy verbatim below.
    if ((v === undefined || v === null) && (SHAPE_NULL_INHERIT_KEYS.has(landKey) || landKey === "extraBadgeStyle")) {
      // Inherit-key flats with no concrete value still render something
      // pre-edit (the canonical historic default the chains fall back to), so
      // freeze exactly that: pixel-identical now, leak-proof later.
      const frozen = canonicalInheritFreeze(landKey, v)
      if (!frozen.freeze) continue
      adds[landKey] = frozen.value
      continue
    }
    if (v === undefined) continue
    if (landKey === "ageCountry") {
      adds[landKey] = normalizeCertificationCountry(v) ?? DEFAULT_AGE_COUNTRY
      continue
    }
    adds[landKey] = cloneSnapshotValue(v)
  }
  return adds as Partial<LandscapeServerDefaults>
}

/**
 * Fully independent landscape profile from flat values (new users and full
 * resets): every mapped key explicit, never follow. Quality offsets use the
 * canonical landscape 0/0 (the horizontal profile never inherits the
 * vertical -10/+15 default); the age trio is forced to OFF/IT/standard so a
 * portrait ON can never re-arm a reset landscape; the extra-style legacy
 * fallback materializes as the explicit shape-local `null` marker (follow
 * own rank) and logoAlign as its landscape auto ("left") when the flat is
 * legacy — both pixel-identical to the follow they replace. All other keys
 * copy the given flats (cloned arrays), so a reset freezes the current
 * portrait look instead of tracking it. Callers pass factory flats (new
 * users) or the current pre-reset flats (reset).
 */
export function independentLandscapeDefaults(
  flats: Record<string, unknown>,
): LandscapeServerDefaults {
  const adds = snapshotMissingLandscape(flats, {}, Object.keys(SHAPE_FLAT_TO_LANDSCAPE))
  return {
    ...adds,
    qualityBadgeOffsetX: DEFAULT_QUALITY_BADGE_OFFSET_X_LANDSCAPE,
    qualityBadgeOffsetY: DEFAULT_QUALITY_BADGE_OFFSET_Y_LANDSCAPE,
    ageBadge: false,
    ageCountry: DEFAULT_AGE_COUNTRY,
    ageBadgeStyle: DEFAULT_AGE_BADGE_STYLE,
  } as LandscapeServerDefaults
}
