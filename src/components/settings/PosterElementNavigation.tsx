"use client"

import { useT } from "@/lib/contexts/TranslationContext"
import type { DefaultsPreviewFamily } from "@/lib/poster-url"

/** Unified advanced workspace element (Phase 1 settings consolidation).
 *  Groups appearance/content + geometry together per poster element instead
 *  of the legacy Badge-vs-Transform split. UI-only: selecting an element
 *  never persists defaults, delivery shape, or storage — it only filters
 *  which existing detail cards + geometry groups are visible and which
 *  preview-only family sample is shown. */
export type PosterElementId =
  | "logo"
  | "ratings"
  | "genre"
  | "rank"
  | "info"
  | "quality"
  | "background"
  | "sources"

export const POSTER_ELEMENTS: ReadonlyArray<{
  id: PosterElementId
  labelKey: string
  previewFamily: DefaultsPreviewFamily
}> = [
  { id: "logo", labelKey: "ui.logoSection", previewFamily: "logo" },
  { id: "ratings", labelKey: "ui.ratingsFamily", previewFamily: "ratings" },
  { id: "genre", labelKey: "ui.titleInfoFamily", previewFamily: "genre" },
  { id: "rank", labelKey: "ui.rankFamily", previewFamily: "rank" },
  { id: "info", labelKey: "ui.sash_extra", previewFamily: "info" },
  { id: "quality", labelKey: "ui.badgeQuality", previewFamily: "quality" },
  { id: "background", labelKey: "ui.blurSection", previewFamily: "gradient" },
  { id: "sources", labelKey: "ui.ratingSources", previewFamily: "auto" },
]

/** Preview-only family sampled while an element is edited. Never persisted. */
export function previewFamilyForElement(id: PosterElementId): DefaultsPreviewFamily {
  return POSTER_ELEMENTS.find((el) => el.id === id)?.previewFamily ?? "auto"
}

/** Accessible element navigation (tablist): buttons only, no writes. */
export function PosterElementNavigation({
  value,
  onChange,
}: {
  value: PosterElementId
  onChange: (id: PosterElementId) => void
}) {
  const { t } = useT()
  // Roving tabindex + arrows/home/end (EditorPanel pattern): buttons only,
  // no writes. Focus follows the selected tab.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const idx = POSTER_ELEMENTS.findIndex((el) => el.id === value)
    let next = -1
    if (e.key === "ArrowRight") next = (idx + 1) % POSTER_ELEMENTS.length
    else if (e.key === "ArrowLeft") next = (idx - 1 + POSTER_ELEMENTS.length) % POSTER_ELEMENTS.length
    else if (e.key === "Home") next = 0
    else if (e.key === "End") next = POSTER_ELEMENTS.length - 1
    else return
    e.preventDefault()
    onChange(POSTER_ELEMENTS[next].id)
    const tabEls = Array.from(
      (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="tab"]'),
    )
    tabEls[next]?.focus()
  }
  return (
    <div
      role="tablist"
      aria-label={t("ui.posterElementNav")}
      data-testid="poster-element-nav"
      onKeyDown={handleKeyDown}
      className="flex gap-1 p-1 rounded-xl bg-black/40 border border-white/10 overflow-x-auto scrollbar-none"
    >
      {POSTER_ELEMENTS.map((el) => {
        const selected = value === el.id
        return (
          <button
            key={el.id}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-testid={`poster-element-${el.id}`}
            onClick={() => onChange(el.id)}
            className={`flex-1 py-1.5 px-2 rounded-lg text-[11px] font-semibold transition-all cursor-pointer whitespace-nowrap ${
              selected
                ? "bg-white/15 text-foreground shadow-sm"
                : "text-muted hover:bg-white/5 hover:text-zinc-200"
            }`}
          >
            {t(el.labelKey)}
          </button>
        )
      })}
    </div>
  )
}
