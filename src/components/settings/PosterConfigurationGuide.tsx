"use client"

import type { DefaultsPreviewDemoMedia } from "@/lib/poster-url"
import { PresetsPanel } from "@/components/settings/PresetsPanel"
import type { GuideShape } from "@/lib/poster-guide"

export interface GuideActions {
  apply: () => boolean
  applyAndAdvanced: () => boolean
  isDirty: () => boolean
}

/**
 * Refocused compatibility alias (five-tab settings): the guided stepper
 * (style/layout/info steps, draft/apply/apply-and-advanced/completed
 * vocabulary) is obsolete and removed. This module now renders the pure
 * Preset gallery. Kept only so existing imports keep resolving; new code
 * imports PresetsPanel directly.
 */
export function PosterConfigurationGuide({
  shape,
  demoMedia,
}: {
  shape: GuideShape
  demoMedia: DefaultsPreviewDemoMedia | null
  onDemoMediaChange?: (m: DefaultsPreviewDemoMedia | null) => void
  onClose?: () => void
  onOpenAdvanced?: () => void
  onDirtyChange?: (dirty: boolean) => void
  actionsRef?: { current: GuideActions | null }
  collapsed?: boolean
  onCollapsedChange?: (v: boolean) => void
}) {
  return <PresetsPanel shape={shape} demoMedia={demoMedia} active />
}
