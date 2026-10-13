import {
  APPLE_PRESET_LABEL,
  APPLE_VISUAL_DEFAULTS,
  BETTER_POSTER_PRESET_LABEL,
  BETTER_POSTER_VISUAL_DEFAULTS,
  FRESH_PRESET_LABEL,
  FRESH_VISUAL_DEFAULTS,
  RPDB_PRESET_LABEL,
  RPDB_VISUAL_DEFAULTS,
} from "./default-visual-presets"
import { quickLookDesired, type QuickLookId } from "./quick-visual-presets"
import type { VisualPresetValues } from "./visual-presets"

/**
 * The seven canonical ready looks (single source for the global Preset-tab
 * gallery AND the per-title quick chooser — never duplicated JSON).
 *
 * - Apple / BetterPoster / RPDB / Fresh: the shared snapshot constants (same
 *   source the global gallery thumbnails/apply/highlight resolve).
 * - Essential / Ratings / Full: `quickLookDesired` (badge patch + canonical
 *   transform reset — the same resolved source logic as the global gallery,
 *   never live previous values).
 *
 * `desired(portrait)` returns the snapshot to project for the edited shape;
 * callers apply it through their existing isolated path (global staged
 * session vs per-title staged draft). `fresh` is true only for the Fresh
 * look (owns `fresh` + `ranked`); the other six own Standard.
 */
export interface ReadyPresetEntry {
  id: string
  label: string
  labelKey: string
  descKey: string
  fresh: boolean
  desired: (portrait: boolean) => VisualPresetValues
}

const QUICK_LABELS: Record<QuickLookId, { label: string; labelKey: string; descKey: string }> = {
  essential: { label: "Essential", labelKey: "ui.configPresetEssential", descKey: "ui.configPresetEssentialDesc" },
  ratings: { label: "Ratings", labelKey: "ui.configPresetRatings", descKey: "ui.configPresetRatingsDesc" },
  full: { label: "Full", labelKey: "ui.configPresetFull", descKey: "ui.configPresetFullDesc" },
}

function quickEntry(id: QuickLookId): ReadyPresetEntry {
  const meta = QUICK_LABELS[id]
  return {
    id,
    label: meta.label,
    labelKey: meta.labelKey,
    descKey: meta.descKey,
    fresh: false,
    desired: (portrait: boolean) => quickLookDesired(id, portrait),
  }
}

export const READY_PRESET_ENTRIES: ReadonlyArray<ReadyPresetEntry> = [
  {
    id: "apple",
    label: APPLE_PRESET_LABEL,
    labelKey: "ui.configPresetApple",
    descKey: "ui.configPresetAppleDesc",
    fresh: false,
    desired: () => APPLE_VISUAL_DEFAULTS,
  },
  {
    id: "better-poster",
    label: BETTER_POSTER_PRESET_LABEL,
    labelKey: "ui.configPresetBetterPoster",
    descKey: "ui.configPresetBetterPosterDesc",
    fresh: false,
    desired: () => BETTER_POSTER_VISUAL_DEFAULTS,
  },
  {
    id: "rpdb",
    label: RPDB_PRESET_LABEL,
    labelKey: "ui.configPresetRpdb",
    descKey: "ui.configPresetRpdbDesc",
    fresh: false,
    desired: () => RPDB_VISUAL_DEFAULTS,
  },
  quickEntry("essential"),
  quickEntry("ratings"),
  quickEntry("full"),
  {
    id: "fresh",
    label: FRESH_PRESET_LABEL,
    labelKey: "ui.configPresetFresh",
    descKey: "ui.configPresetFreshDesc",
    fresh: true,
    desired: () => FRESH_VISUAL_DEFAULTS,
  },
]
