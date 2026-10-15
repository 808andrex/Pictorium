import { useState } from "react"
import { describe, expect, it, vi, beforeEach } from "vitest"
import { fireEvent, screen } from "@testing-library/react"
import { CatalogManagerModal } from "@/components/CatalogManagerModal"
import { renderWithCtx } from "@/__tests__/test-utils"
import { PICTORIUM_CATALOGS } from "@/lib/catalog-definitions"

vi.mock("@/lib/contexts/TranslationContext", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/contexts/TranslationContext")>(),
  useT: () => ({ t: (key: string) => key }),
}))

beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {})
})

function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>open-manager</button>
      <CatalogManagerModal isOpen={open} onClose={() => setOpen(false)} />
    </>
  )
}

function openManager(overrides?: Parameters<typeof renderWithCtx>[1]) {
  const view = renderWithCtx(<Harness />, overrides)
  const trigger = screen.getByRole("button", { name: "open-manager" })
  trigger.focus()
  fireEvent.click(trigger)
  const dialog = screen.getByRole("dialog", { name: "ui.catMgrTitle" })
  return { view, trigger, dialog }
}

describe("CatalogManagerModal per-catalog format", () => {
  it("renders one format control per row defaulting to follow-global with the live effective choice", () => {
    const { view } = openManager()
    const selects = screen.getAllByRole("combobox")
    expect(selects).toHaveLength(PICTORIUM_CATALOGS.length)
    for (const select of selects) {
      expect(select).toHaveValue("global")
      expect(select).not.toBeDisabled()
    }
    // Live effective hint follows the global portrait default.
    expect(selects[0].textContent).toContain("ui.catalogShapeFollowGlobal")
    expect(selects[0].textContent).toContain("ui.posterShapePortrait")
    view.unmount()
  })

  it("persists explicit choices and removes the override on follow-global", () => {
    const setCatalogShape = vi.fn()
    const { view } = openManager({ setCatalogShape })
    const selects = screen.getAllByRole("combobox")
    fireEvent.change(selects[0], { target: { value: "landscape" } })
    expect(setCatalogShape).toHaveBeenCalledWith(PICTORIUM_CATALOGS[0].id, "landscape")
    fireEvent.change(selects[1], { target: { value: "poster" } })
    expect(setCatalogShape).toHaveBeenCalledWith(PICTORIUM_CATALOGS[1].id, "poster")
    view.unmount()

    // An owned override renders selected; picking global deletes it (null).
    const setCatalogShape2 = vi.fn()
    const h2 = openManager({
      catalogShapes: { [PICTORIUM_CATALOGS[0].id]: "poster" },
      setCatalogShape: setCatalogShape2,
    })
    expect(screen.getAllByRole("combobox")[0]).toHaveValue("poster")
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "global" } })
    expect(setCatalogShape2).toHaveBeenCalledWith(PICTORIUM_CATALOGS[0].id, null)
    h2.view.unmount()
  })

  it("keeps the format control usable on disabled rows and independent per custom split", () => {
    const setCatalogShape = vi.fn()
    const mixed = { id: "mix", name: "Mix", type: "mixed" as const, url: "https://mdblist.com/lists/u/mix" }
    const { view } = openManager({
      customCatalogs: [mixed],
      disabledCatalogIds: [PICTORIUM_CATALOGS[0].id],
      setCatalogShape,
    })
    const selects = screen.getAllByRole("combobox")
    expect(selects).toHaveLength(PICTORIUM_CATALOGS.length + 2)
    // Disabled catalog stays configurable (format is independent of visibility).
    expect(selects[0]).not.toBeDisabled()
    const movieSplit = `pictorium-custom-movie-mix`
    const seriesSplit = `pictorium-custom-series-mix`
    const idxMovie = selects.findIndex((s) => s.getAttribute("aria-label")?.startsWith("Mix — "))
    expect(idxMovie).toBeGreaterThanOrEqual(0)
    fireEvent.change(selects[idxMovie], { target: { value: "landscape" } })
    const calledIds = setCatalogShape.mock.calls.map((c) => c[0] as string)
    expect(calledIds[0] === movieSplit || calledIds[0] === seriesSplit).toBe(true)
    expect(setCatalogShape.mock.calls[0][1]).toBe("landscape")
    view.unmount()
  })

  it("does not disturb drag handling: select interaction leaves order actions intact", () => {
    const setCatalogOrder = vi.fn()
    const setCatalogShape = vi.fn()
    const { view } = openManager({ setCatalogOrder, setCatalogShape })
    const selects = screen.getAllByRole("combobox")
    fireEvent.change(selects[0], { target: { value: "landscape" } })
    expect(setCatalogShape).toHaveBeenCalledTimes(1)
    expect(setCatalogOrder).not.toHaveBeenCalled()
    view.unmount()
  })
})
