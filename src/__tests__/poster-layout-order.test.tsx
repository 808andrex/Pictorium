/**
 * Task17 UIORDER (+ P6 Card exposure + T1 unified per-title ranking
 * presentation): ONE exclusive Nastro/Numero/Badge/Fresh/Card group in
 * BadgeControls (no separate layout card, no scope dropdown) and the
 * settings ranked-only rule (no scope selector: Fresh/Card render only for
 * titles with a valid displayed rank, the rest fall back to Standard).
 * - BadgeControls (per-title badge tab): the unified presentation group
 *   (both rank styles and Fresh/Card skins, ranked-only hints, controlled
 *   callbacks) is the single exclusive choice, single instance; no
 *   poster-layout-card anywhere; stored scope kept (Standard hides hints).
 * - BadgeDefaultsSection (settings, portrait AND landscape): preset block,
 *   then layout card, then the remaining controls; scoped setters/inheritance
 *   intact (portrait=flat, landscape=profile override; portrait edits snapshot
 *   pre-edit into the profile, resets restore independent shape defaults).
 *   The layout card offers the style choices (Fresh + Card skins) with a
 *   ranked-only hint and NO scope selector: Fresh/Card render only for titles
 *   with a valid displayed rank, the rest fall back to Standard.
 * Real-DOM order assertions (compareDocumentPosition / firstElementChild),
 * never string matching. No renderer/output behavior is touched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, screen, within } from "@testing-library/react"
import { createElement } from "react"
import { BadgeControls } from "@/components/BadgeControls"
import { BadgeDefaultsSection } from "@/components/settings/BadgeDefaultsSection"
import { usePosterEditor, type PosterEditorCtx } from "@/lib/contexts/PosterEditorContext"
import { renderWithCtx } from "@/__tests__/test-utils"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))

function probe() {
  let ctx: PosterEditorCtx | null = null
  function Probe() {
    ctx = usePosterEditor()
    return null
  }
  return { Probe, ctx: () => ctx as unknown as PosterEditorCtx }
}

const SELECTED = {
  id: 11,
  media_type: "movie",
  title: "Probe",
  poster_path: "/p.jpg",
} as const

/** Bitmask-safe "a precedes b in the live DOM" check. */
function precedes(a: Node, b: Node): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })))
  vi.useFakeTimers()
})

describe("per-title unified presentation (BadgeControls)", () => {
  function renderEditor() {
    const { Probe, ctx } = probe()
    renderWithCtx(
      createElement("div", null, createElement(BadgeControls), createElement(Probe)),
      { selected: SELECTED as never, metaInfo: { genres: [], voteAverage: 0 } as never },
    )
    return { ctx }
  }

  function presentationGroup(): HTMLElement {
    return within(screen.getByTestId("ranking-presentation")).getByRole("radiogroup", { name: "ui.rankFamily" })
  }

  it("no separate layout card; single exclusive 5-choice presentation group", () => {
    renderEditor()
    // The old separate layout card is gone (single instance used to assert).
    expect(screen.queryByTestId("poster-layout-card")).toBeNull()
    expect(screen.queryByRole("radiogroup", { name: "ui.posterLayout" })).toBeNull()
    const groups = screen.getAllByTestId("ranking-presentation")
    expect(groups).toHaveLength(1)
    expect(within(presentationGroup()).getAllByRole("radio")).toHaveLength(5)
    expect(
      within(presentationGroup()).getAllByRole("radio").filter((o) => o.getAttribute("aria-checked") === "true"),
    ).toHaveLength(1)
  })

  it("presentation group lives in the classifica card between the top badge and the extra style", () => {
    renderEditor()
    const group = screen.getByTestId("ranking-presentation")
    // Historic first-card header (visibility & badge position) comes before.
    expect(precedes(screen.getByText("ui.badgeSectionPoster"), group)).toBe(true)
    // Custom-badge/classifica card header comes before the group…
    expect(precedes(screen.getByText("ui.customBadge"), group)).toBe(true)
    // …and the extra style block comes after (single exclusive rank+layout).
    expect(precedes(group, screen.getByText("ui.extraBadgeStyle"))).toBe(true)
  })

  it("choices stay enabled with working callbacks; hints are Fresh/Card-only and stored scope is kept", () => {
    const { ctx } = renderEditor()
    const layoutRadios = within(presentationGroup()).getAllByRole("radio")
    for (const radio of layoutRadios) expect(radio).toBeEnabled()
    // Standard: no scope control, no ranked-only hint (stored preference untouched).
    expect(screen.queryByTestId("fresh-scope-selector")).toBeNull()
    expect(screen.queryByTestId("fresh-scope-select")).toBeNull()
    expect(screen.queryByText("ui.posterFreshScopeHint")).toBeNull()
    expect(screen.queryByText("ui.posterLayoutScopeHint")).toBeNull()
    fireEvent.click(within(presentationGroup()).getByRole("radio", { name: "ui.posterLayoutGroupedFresh" }))
    expect(ctx().posterLayout).toBe("fresh")
    expect(ctx().posterFreshScope).toBe("ranked")
    expect(screen.getByText("ui.posterFreshScopeHint")).toBeTruthy()
    // Back to a classic: hints hide again, stored scope is kept.
    fireEvent.click(
      within(presentationGroup()).getByRole("radio", { name: "ui.ribbon" }),
    )
    expect(ctx().posterLayout).toBe("standard")
    expect(screen.queryByTestId("fresh-scope-selector")).toBeNull()
    expect(screen.queryByText("ui.posterFreshScopeHint")).toBeNull()
    expect(ctx().posterFreshScope).toBe("ranked")
    // Card shares the same ranked-only rule with generic wording: visible
    // skins, hint, still no scope dropdown.
    fireEvent.click(
      within(presentationGroup()).getByRole("radio", { name: "ui.posterLayoutGroupedCard" }),
    )
    expect(ctx().posterLayout).toBe("provider-glass")
    expect(screen.getByTestId("poster-layout-skins")).toBeInTheDocument()
    expect(screen.getByText("ui.posterLayoutScopeHint")).toBeTruthy()
    expect(screen.queryByTestId("fresh-scope-selector")).toBeNull()
    expect(ctx().posterFreshScope).toBe("ranked")
  })
})

describe("settings defaults order: presets, then layout, then rest", () => {
  function renderBadge(shape: "portrait" | "landscape") {
    const { Probe, ctx } = probe()
    renderWithCtx(
      createElement(
        "div",
        null,
        createElement(BadgeDefaultsSection, { active: true, shape }),
        createElement(Probe),
      ),
    )
    return { ctx }
  }

  function layoutGroup(): HTMLElement {
    const adv = screen.getByTestId("badge-advanced-toggle")
    if (adv.getAttribute("aria-expanded") !== "true") fireEvent.click(adv)
    const g = screen.getByTestId("badge-group-style-toggle")
    if (g.getAttribute("aria-expanded") !== "true") fireEvent.click(g)
    return screen.getByRole("radiogroup", { name: "ui.posterLayout" })
  }

  it.each(["portrait", "landscape"] as const)(
    "preset block, then single layout card, then genre style (%s)",
    (shape) => {
      renderBadge(shape)
      const presetTitle = screen.getByText("ui.configPresetTitle")
      const cards = screen.getAllByTestId("poster-layout-card")
      expect(cards).toHaveLength(1)
      const card = cards[0]
      // Layout card lives in the style group, right after the presets.
      expect(screen.getByTestId("badge-group-style")).toContainElement(card)
      expect(precedes(presetTitle, card)).toBe(true)
      // Remaining style controls (genre style, extra style) come after.
      expect(precedes(card, screen.getByText("ui.styleGenreBadge"))).toBe(true)
      expect(precedes(card, screen.getByText("ui.extraBadgeStyle"))).toBe(true)
    },
  )

  it("portrait writes the flat default; no scope selector, ranked-only hint for Fresh/Card", async () => {
    const { ctx } = renderBadge("portrait")
    await act(async () => {})
    const freshRadio = within(layoutGroup()).getByRole("radio", {
      name: "ui.posterLayoutFresh",
    })
    expect(freshRadio).toBeEnabled()
    expect(screen.queryByTestId("fresh-scope-selector")).toBeNull()
    fireEvent.click(freshRadio)
    expect(ctx().defaultPosterLayout).toBe("fresh")
    // 3B1: the inherited key freezes the pre-edit flat instead of following it.
    expect(ctx().landscape.posterLayout).toBe("standard")
    // Ranked-only: no scope dropdown for Fresh — the hint states the rule and
    // the stored scope stays ranked (no UI path to "all" exists in settings).
    expect(screen.queryByTestId("fresh-scope-selector")).toBeNull()
    expect(screen.queryByTestId("fresh-scope-select")).toBeNull()
    expect(screen.getByText("ui.posterFreshScopeHint")).toBeTruthy()
    expect(ctx().defaultPosterFreshScope).toBe("ranked")
    // Card skins reuse the same ranked-only rule with generic wording.
    fireEvent.click(
      within(layoutGroup()).getByRole("radio", { name: "ui.posterLayoutStremio" }),
    )
    expect(ctx().defaultPosterLayout).toBe("stremio")
    expect(screen.queryByTestId("fresh-scope-select")).toBeNull()
    expect(screen.getByText("ui.posterLayoutScopeHint")).toBeTruthy()
    expect(ctx().defaultPosterFreshScope).toBe("ranked")
  })

  it("landscape writes only the profile override; reset restores independent shape defaults", async () => {
    const { ctx } = renderBadge("landscape")
    await act(async () => {})
    const presetTitle = screen.getByText("ui.configPresetTitle")
    expect(precedes(presetTitle, screen.getByTestId("poster-layout-card"))).toBe(true)
    fireEvent.click(
      within(layoutGroup()).getByRole("radio", { name: "ui.posterLayoutFresh" }),
    )
    expect(ctx().landscape.posterLayout).toBe("fresh")
    expect(ctx().defaultPosterLayout).toBe("standard")
    // Ranked-only: no scope dropdown in landscape either — the profile scope
    // stays on the ranked default and the flat is intact.
    expect(screen.queryByTestId("fresh-scope-select")).toBeNull()
    expect(screen.getByText("ui.posterFreshScopeHint")).toBeTruthy()
    expect(ctx().landscape.posterFreshScope).toBe("ranked")
    expect(ctx().defaultPosterFreshScope).toBe("ranked")
    // The landscape-override reset clears the profile back to flat inheritance.
    const reset = screen.getByRole("button", {
      name: "ui.reset · ui.posterShapeLandscape",
    })
    fireEvent.click(reset)
    // 3B1: reset materializes the current portrait effective (independent),
    // never clear-to-follow.
    expect(ctx().landscape.posterLayout).toBe("standard")
    expect(ctx().landscape.posterFreshScope).toBe("ranked")
    expect(ctx().defaultPosterLayout).toBe("standard")
  })
})
