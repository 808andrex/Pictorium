"use client"

/**
 * Effective-accent display sync (client, header transport).
 *
 * The poster renderer computes per-band adaptive badge fills on the fitted
 * canvas (see `poster-service.ts` + `effective-accent.ts`). The native editor
 * picker must show the hex ACTUALLY painted — never the legacy base, never an
 * OS-dialog value. Metadata arrives WITH the image bytes: every poster 200
 * carries the compact validated `X-Pictorium-Accent` header, parsed by the
 * existing XHR blob load in `usePosterPreview` (same response, zero extra
 * requests) and published to the display store (`effective-accent-display`).
 * This hook is a pure `useSyncExternalStore` selector over that record —
 * there is no dedicated JSON fetch in the normal flow (the `?accentmeta=1`
 * route branch stays as a read-only diagnostic only, never required).
 *
 * CANONICAL/DISPLAY SPLIT (normative): the values returned here MUST NEVER
 * feed `isManualAccent`, `ac=` emission (`poster-url.ts`), mapping persistence
 * (`usePosterSave.ts`), or AppShell/EditView globals. Canonical identity stays
 * `accentColor`/`autoAccentColor` (legacy base). Only explicit user edits
 * (picker/text input `onChange`) may write `accentColor`.
 */

import { useSyncExternalStore } from "react"
import {
  getEffectiveAccentDisplay,
  subscribeEffectiveAccentDisplay,
  type EffectiveAccentDisplayRecord,
  type EffectiveAccentDisplayStatus,
} from "./effective-accent-display"
import type { EffectiveAccentMeta } from "./effective-accent"

export type EffectiveAccentStatus = EffectiveAccentDisplayStatus

/**
 * Server snapshot (SSR/hydration): a stable unknown constant with no URL, no
 * metadata and generation zero — NEVER the mutable module `current` nor any
 * seeded client record (that would leak cross-request data into server HTML
 * and mismatch hydration). Client components marked `"use client"` still
 * render on the server during initial page generation, so the third
 * `useSyncExternalStore` argument is required (omitting it throws `Missing
 * getServerSnapshot` in `renderToString`).
 */
const SERVER_SNAPSHOT: EffectiveAccentDisplayRecord = {
  status: "unknown",
  meta: null,
  previewUrl: "",
  generation: 0,
}

function getEffectiveAccentServerSnapshot(): EffectiveAccentDisplayRecord {
  return SERVER_SNAPSHOT
}

export interface EffectiveAccentState {
  readonly status: EffectiveAccentStatus
  /** Sanitized server metadata, or null while loading/unknown. */
  readonly meta: EffectiveAccentMeta | null
}

/**
 * Display-only effective accent for the rendered preview.
 *
 * - `previewUrl` SHOULD be the same URL string loaded by the `<img>` XHR in
 *   `usePosterPreview`. A record tied to a different URL is stale by
 *   definition and resolves to `loading` (never shown as the new poster).
 *   Same-URL reloads (rank-source/catalog/retry nonce refetches, which reuse
 *   the identical URL for different server-side content) are covered by the
 *   producer: it publishes `loading` when the new load starts, so a mounted
 *   consumer flips to loading with no extra deps and no URL comparison.
 * - `enabled` gates DISPLAY to when the automatic picker section is actually
 *   mounted/shown (BadgeControls badge tab) and the title is in automatic
 *   mode. Disabled (manual titles, thumbnails) resolves to honest `unknown`
 *   and the consumer keeps showing `accentColor` verbatim — a late automatic
 *   record can never overwrite a manual selection because this hook only
 *   returns display data and never writes canonical state.
 */
export function useEffectiveAccent(previewUrl: string, enabled = true): EffectiveAccentState {
  const record = useSyncExternalStore(
    subscribeEffectiveAccentDisplay,
    getEffectiveAccentDisplay,
    getEffectiveAccentServerSnapshot,
  )
  if (!enabled || previewUrl.trim().length === 0) {
    return { status: "unknown", meta: null }
  }
  // URL identity gating: the old hex disappears with the URL change itself
  // (derived during render, no effect needed) — a stale record is never
  // displayed as the new poster, even for a consumer mounted after the
  // producer published (e.g. badge tab opened minutes after the load).
  if (record.previewUrl !== previewUrl) {
    return { status: "loading", meta: null }
  }
  return { status: record.status, meta: record.meta }
}

export interface AccentPickerDisplay {
  /** Bottom/genre effective hex actually painted (null when not painting). */
  readonly bottomHex: string | null
  /** Top/rank effective hex actually painted (null when not painting). */
  readonly topHex: string | null
  /** Bottom-gradient (blur tint) hex actually painted (null when not painting). */
  readonly gradientHex: string | null
  /**
   * Picker reference: bottom by locality (the picker lives in the Genre
   * card); the bottom-zone gradient next (same zone); top only when it is
   * the sole accent painter. Null → placeholder.
   */
  readonly pickerHex: string | null
}

/**
 * Pure picker-reference choice shared by the component and tests: bottom
 * wins by locality, then the bottom-zone gradient, then top as the fallback
 * — never a silent merged claim, never the detected-but-unused base.
 */
export function resolveAccentPickerDisplay(meta: EffectiveAccentMeta | null): AccentPickerDisplay {
  const bottomHex = meta?.genrePaints && meta.genreHex ? meta.genreHex : null
  const topHex = meta?.topPaints && meta.rankHex ? meta.rankHex : null
  const gradientHex = meta?.gradientPaints && meta.gradientHex ? meta.gradientHex : null
  return { bottomHex, topHex, gradientHex, pickerHex: bottomHex ?? gradientHex ?? topHex ?? null }
}
