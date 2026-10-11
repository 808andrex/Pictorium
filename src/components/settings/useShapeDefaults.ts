"use client"

import type { LandscapeServerDefaults } from "@/lib/server-defaults"
import { isExtraBadgeStyle, isExtraFollowRank } from "@/lib/badge-styles"
import { usePosterEditor } from "@/lib/contexts/PosterEditorContext"

export type BadgeShapeTarget = "portrait" | "landscape"

/**
 * Scoped badge-default bindings for the Badge tab edit target.
 * Portrait reads/writes the shared flats; landscape reads
 * `land[key] ?? flat` and writes the landscape profile. Absent keys follow
 * the portrait EFFECTIVE value at rest (legacy appearance preserved), but a
 * portrait edit atomically snapshots the pre-edit value into the profile
 * (see `update` in useDefaults + the PUT backfill), so the follow never
 * leaks after an edit — strict per-shape independence. Explicit `null` on
 * null-inheriting keys (fonts, formats, follow toggle, age style, logo
 * align) keeps inheriting per the canonical contract; logo/extra-tuning
 * `null`s stay explicit (auto/zero). The standalone extra style is its own
 * case: legacy profile `null`/absent inherits the flat (old contract); only
 * the explicit "follow-rank" sentinel shadows the portrait flat (see
 * `scoped` below), so a portrait extra edit can never leak across shapes.
 * Data sources, endpoints, region, date format and API settings stay global
 * and are intentionally absent here (callers keep the root setters).
 */
export function useShapeBadgeDefaults(shape: BadgeShapeTarget | undefined) {
  const ed = usePosterEditor()
  const isLandscape = shape === "landscape"
  const land = ed.landscape
  function scoped<T>(
    landKey: keyof LandscapeServerDefaults,
    flatValue: T,
    setFlat: (v: T) => void,
  ): readonly [T, (v: T) => void] {
    if (!isLandscape) return [flatValue, setFlat] as const
    // Standalone extra style: only the explicit "follow-rank" sentinel
    // shadows the portrait flat (a `??` read would resurrect the portrait
    // style in the editor). Legacy profile null/absent/invalid keeps the
    // canonical `??` follow (inherit the flat).
    if (landKey === "extraBadgeStyle" && "extraBadgeStyle" in land) {
      const raw = (land as { extraBadgeStyle?: unknown }).extraBadgeStyle
      if (isExtraFollowRank(raw) || isExtraBadgeStyle(typeof raw === "string" ? raw : null)) {
        const owned = raw as T
        const setOwned = (v: T) => {
          ed.setLandscape({ [landKey]: v } as Partial<LandscapeServerDefaults>)
        }
        return [owned, setOwned] as const
      }
    }
    const value = (land[landKey] ?? flatValue) as T
    const set = (v: T) => {
      ed.setLandscape({ [landKey]: v } as Partial<LandscapeServerDefaults>)
    }
    return [value, set] as const
  }
  return { isLandscape, scoped }
}

/** Landscape visual keys owned by the Badge tab (reset scope, presets stay out of numerics). */
export const BADGE_VISUAL_LAND_KEYS = [
  "globalBadges",
  "rankingBadges",
  "badgeGenre",
  "badgeYear",
  "badgeRating",
  "badgeQuality",
  "customRatings",
  "separateRatings",
  "separateRatingsStyle",
  "badgeStyle",
  "rankingBadgeStyle",
  "extraBadgeStyle",
  "badgeFont",
  "qualityBadgeStyle",
  "videoFormats",
  "sashOrder",
  "networkLogo",
  "networkLogoPosition",
  "networkLogoFollowTitle",
  "preRelease",
  "ribbonSide",
  "ribbonEnabled",
  "logoAlign",
  "posterLayout",
  "posterFreshScope",
] as const satisfies readonly (keyof LandscapeServerDefaults)[]
