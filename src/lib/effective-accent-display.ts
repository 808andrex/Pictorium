/**
 * Effective-accent display record (client, display-only).
 *
 * Primary transport: the poster image response itself carries compact
 * validated metadata in the `X-Pictorium-Accent` header. `usePosterPreview`
 * (the existing XHR blob load — no new fetch, no second render) parses that
 * header on every successful load and publishes the record here, tied to the
 * EXACT preview URL + producer generation of the SAME image. `BadgeControls`
 * reads it via `useEffectiveAccent` (a pure `useSyncExternalStore`
 * selector — zero JSON-hook traffic in the normal flow).
 *
 * - A new load (URL/shape change, rank-source/catalog/retry nonce refetch)
 *   publishes `loading` FIRST: stale values can never claim the new preview.
 *   The old object URL may stay on screen (crossfade), but the picker shows
 *   the new generation as loading until ITS bytes + header land.
 * - Failure/timeout/non-200/absent-or-malformed header publishes `unknown`.
 * - The producer runs while the editor is open (before the badge tab mounts)
 *   and keeps the last successful record while its preview URL is displayed,
 *   so opening the native picker minutes later still shows the painted hex.
 * - Generation guard: a superseded XHR whose `onload` fires late (e.g. after
 *   `abort()`) must not publish — latest image + metadata pair always wins.
 * - Display/canonical split (normative): this record MUST NEVER feed
 *   `isManualAccent`, `ac=` emission, mapping persistence, or globals.
 */
import type { EffectiveAccentMeta } from "./effective-accent"

export type EffectiveAccentDisplayStatus = "ready" | "loading" | "unknown"

export interface EffectiveAccentDisplayRecord {
  readonly status: EffectiveAccentDisplayStatus
  /** Sanitized server metadata, or null while loading/unknown. */
  readonly meta: EffectiveAccentMeta | null
  /** Exact preview URL that produced this record ("" = no load yet). */
  readonly previewUrl: string
  /** Monotonic producer generation: the latest published pair wins. */
  readonly generation: number
}

const INITIAL: EffectiveAccentDisplayRecord = {
  status: "unknown",
  meta: null,
  previewUrl: "",
  generation: 0,
}

let current: EffectiveAccentDisplayRecord = INITIAL
const listeners = new Set<() => void>()

export function getEffectiveAccentDisplay(): EffectiveAccentDisplayRecord {
  return current
}

export function subscribeEffectiveAccentDisplay(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Publish a display record. Callers own the generation guard: records from a
 * superseded generation must never reach here (see `usePosterPreview`).
 */
export function publishEffectiveAccentDisplay(next: EffectiveAccentDisplayRecord): void {
  current = next
  for (const listener of listeners) listener()
}

/** Only for tests: reset to the initial unknown record. */
export function __resetEffectiveAccentDisplayForTests(): void {
  current = INITIAL
}
