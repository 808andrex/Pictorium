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

describe("CatalogManagerModal central dialog", () => {
  it("renders a centered large dialog with labelled title, header and footer", () => {
    const { dialog } = openManager()
    expect(dialog).toHaveAttribute("aria-modal", "true")
    expect(dialog).toHaveAttribute("aria-labelledby", "catalog-manager-title")
    expect(screen.getByRole("heading", { name: "ui.catMgrTitle" })).toHaveAttribute("id", "catalog-manager-title")
    const panel = screen.getByTestId("catalog-manager-modal")
    expect(panel.className).toContain("!max-w-3xl")
    expect(panel.className).toContain("max-h-[90dvh]")
    // Header close + footer Done reachable, list body scrolls independently.
    expect(screen.getByRole("button", { name: "ui.close" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "ui.done" })).toBeInTheDocument()
    const body = panel.querySelector(".overflow-y-auto.flex-1")
    expect(body).not.toBeNull()
    // Every built-in catalog row rendered with priority index.
    expect(screen.getAllByText(/^#\d+$/)).toHaveLength(PICTORIUM_CATALOGS.length)
    // Last row reachable inside the scroll body (no geometry claim in jsdom).
    const last = screen.getByText(`#${PICTORIUM_CATALOGS.length}`)
    expect(body!.contains(last)).toBe(true)
  })

  it("Done, X, Escape and backdrop close and return focus; click inside does not close", () => {
    // Backdrop close.
    let h = openManager()
    expect(document.body.style.overflow).toBe("hidden")
    fireEvent.click(screen.getByRole("heading", { name: "ui.catMgrTitle" }))
    expect(screen.queryByRole("dialog")).toBeInTheDocument()
    fireEvent.click(h.dialog)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(document.body.style.overflow).toBe("")
    expect(h.trigger).toHaveFocus()
    h.view.unmount()

    // Escape close.
    h = openManager()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(h.trigger).toHaveFocus()
    h.view.unmount()

    // Done close.
    h = openManager()
    fireEvent.click(screen.getByRole("button", { name: "ui.done" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(h.trigger).toHaveFocus()
    h.view.unmount()

    // X close.
    h = openManager()
    fireEvent.click(screen.getByRole("button", { name: "ui.close" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(h.trigger).toHaveFocus()
    h.view.unmount()
  })

  it("traps Tab/Shift+Tab between first and last focusable", () => {
    openManager()
    const first = screen.getByRole("button", { name: "ui.close" })
    const last = screen.getByRole("button", { name: "ui.done" })
    expect(first).toHaveFocus()
    last.focus()
    fireEvent.keyDown(window, { key: "Tab" })
    expect(first).toHaveFocus()
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true })
    expect(last).toHaveFocus()
  })

  it("Escape cancels rename first and clears multiselect before closing", () => {
    const { view } = openManager()
    // Start rename on the first row.
    fireEvent.click(screen.getAllByTitle("ui.renameCatalog")[0])
    expect(screen.getByRole("textbox")).toBeInTheDocument()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByRole("dialog")).toBeInTheDocument()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    // Select all, then Escape clears the selection instead of closing.
    fireEvent.click(screen.getByRole("button", { name: "ui.selectAll" }))
    expect(screen.getByText("ui.selectedCount")).toBeInTheDocument()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByRole("dialog")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "ui.selectAll" })).toBeInTheDocument()
    view.unmount()
  })
})

describe("CatalogManagerModal preserved behaviors", () => {
  it("renames persist and rename-equal-to-default deletes the override", () => {
    const renameCatalog = vi.fn()
    const custom = { id: "c1", name: "My List", type: "movie" as const, url: "https://mdblist.com/lists/u/c1" }
    const { view } = openManager({ customCatalogs: [custom], renameCatalog })
    const renameButtons = screen.getAllByTitle("ui.renameCatalog")
    // Built-in row rename persists the trimmed name.
    fireEvent.click(renameButtons[0])
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  Top Movies  " } })
    fireEvent.click(screen.getByTitle("ui.saveName"))
    expect(renameCatalog).toHaveBeenCalledWith(PICTORIUM_CATALOGS[0].id, "Top Movies")
    // Custom row rename equal to the default deletes the override ("").
    fireEvent.click(renameButtons[PICTORIUM_CATALOGS.length])
    fireEvent.click(screen.getByTitle("ui.saveName"))
    expect(renameCatalog).toHaveBeenCalledWith("pictorium-custom-movie-c1", "")
    view.unmount()
  })

  it("single-row arrows, toggles, home and custom remove call the existing actions", () => {
    const moveCatalog = vi.fn()
    const toggleBuiltinCatalog = vi.fn()
    const toggleCatalogHome = vi.fn()
    const removeCustomCatalog = vi.fn()
    const custom = { id: "c1", name: "My List", type: "series" as const, url: "https://mdblist.com/lists/u/c1" }
    const { view } = openManager({ customCatalogs: [custom], moveCatalog, toggleBuiltinCatalog, toggleCatalogHome, removeCustomCatalog })
    fireEvent.click(screen.getAllByTitle("ui.moveDown")[0])
    expect(moveCatalog).toHaveBeenCalledWith(PICTORIUM_CATALOGS[0].id, "down")
    fireEvent.click(screen.getAllByTitle("ui.disableStremio")[0])
    expect(toggleBuiltinCatalog).toHaveBeenCalledWith(PICTORIUM_CATALOGS[0].id)
    fireEvent.click(screen.getAllByTitle("ui.homeVisible")[0])
    expect(toggleCatalogHome).toHaveBeenCalledWith(PICTORIUM_CATALOGS[0].id)
    fireEvent.click(screen.getByTitle("ui.deleteCatalog"))
    expect(removeCustomCatalog).toHaveBeenCalledWith("c1")
    view.unmount()
  })

  it("select-all plus batch moves reorder together and reset buttons restore defaults", () => {
    const setCatalogOrder = vi.fn()
    const resetCatalogOrder = vi.fn()
    const resetCatalogNames = vi.fn()
    const { view } = openManager({
      catalogOrder: [PICTORIUM_CATALOGS[1].id, PICTORIUM_CATALOGS[0].id],
      catalogRenames: { [PICTORIUM_CATALOGS[0].id]: "Custom name" },
      setCatalogOrder,
      resetCatalogOrder,
      resetCatalogNames,
    })
    fireEvent.click(screen.getByRole("button", { name: "ui.selectAll" }))
    fireEvent.click(screen.getByTitle("ui.moveTop"))
    expect(setCatalogOrder).toHaveBeenCalledTimes(1)
    expect(setCatalogOrder.mock.calls[0][0]).toHaveLength(PICTORIUM_CATALOGS.length)
    fireEvent.click(screen.getByText("ui.deselect"))
    expect(screen.getByRole("button", { name: "ui.selectAll" })).toBeInTheDocument()
    fireEvent.click(screen.getByText("ui.resetOrder"))
    expect(resetCatalogOrder).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText("ui.resetNames"))
    expect(resetCatalogNames).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it("drag and drop reorders through the existing order action", () => {
    const setCatalogOrder = vi.fn()
    const { view, dialog } = openManager({ setCatalogOrder })
    const rows = Array.from(dialog.querySelectorAll('[draggable="true"]'))
    expect(rows.length).toBe(PICTORIUM_CATALOGS.length)
    const data = { effectAllowed: "", dropEffect: "", setData: vi.fn() }
    fireEvent.dragStart(rows[0], { dataTransfer: data } as unknown as DataTransfer)
    fireEvent.dragOver(rows[1], { dataTransfer: data } as unknown as DataTransfer)
    fireEvent.drop(rows[1])
    expect(setCatalogOrder).toHaveBeenCalledTimes(1)
    const next = setCatalogOrder.mock.calls[0][0] as string[]
    expect(next[0]).toBe(PICTORIUM_CATALOGS[1].id)
    expect(next[1]).toBe(PICTORIUM_CATALOGS[0].id)
    view.unmount()
  })

  it("splits mixed customs into movie/series rows and ignores unknown order ids", () => {
    const mixed = { id: "mix", name: "Mix", type: "mixed" as const, url: "https://mdblist.com/lists/u/mix" }
    const { view } = openManager({
      customCatalogs: [mixed],
      catalogOrder: ["unknown-legacy-id", PICTORIUM_CATALOGS[0].id],
    })
    expect(screen.getAllByText(/^#\d+$/)).toHaveLength(PICTORIUM_CATALOGS.length + 2)
    expect(screen.getByText("Mix — ui.movie")).toBeInTheDocument()
    expect(screen.getByText("Mix — ui.tvSeries")).toBeInTheDocument()
    view.unmount()
  })
})
