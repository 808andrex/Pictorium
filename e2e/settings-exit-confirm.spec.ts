import { test, expect, type Page } from "@playwright/test"

// Exit-confirm modal acceptance (unit-covered in
// src/__tests__/components/settings-exit-confirm.test.tsx; this spec pins the
// real-browser behavior and is intentionally save-free: no PUT is issued on
// any path below). RUN DEFERRED to the final pre-push batch (see AGENTS.md
// Verification Strategy): do not run per-edit.

async function openSettings(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("pictorium_profile_id", "e2e-settings-exit-confirm")
    localStorage.setItem("pictorium_profile_stateless", "1")
    localStorage.setItem("pictorium_onboarding_done", "true")
    localStorage.setItem("preferred_lang", "it")
    localStorage.setItem("tmdb_key", "mock-tmdb-key-0000000000")
  })
  await page.goto("/")
  await expect(page.getByPlaceholder(/cerca/i)).toBeVisible()
  await page
    .getByRole("button", { name: /Configura tutti i poster|Impostazioni/i })
    .filter({ visible: true })
    .click({ timeout: 15_000 })
  const dialog = page.getByRole("dialog", { name: /Configura tutti i poster/i }).filter({ visible: true })
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  return dialog
}

async function makeDirty(page: Page, dialogName: RegExp) {
  const dialog = page.getByRole("dialog", { name: dialogName }).filter({ visible: true })
  await dialog.getByRole("tab", { name: "Trasforma", exact: true }).click()
  const scale = dialog.locator('input[type="range"]').first()
  await expect(scale).toBeVisible({ timeout: 15_000 })
  await scale.fill("42")
  // Draft staged: the single global Save is enabled, no PUT happened yet.
  await expect(dialog.getByTestId("settings-save")).toBeEnabled()
  return dialog
}

test.describe("settings exit-confirm centered modal", () => {
  test("dirty X opens a centered blocking overlay; backdrop is blocked, Escape continues, discard closes", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await openSettings(page)
    const dialog = await makeDirty(page, /Configura tutti i poster/i)
    await dialog.getByRole("button", { name: "Chiudi" }).click()

    const modal = page.getByTestId("settings-dirty-dialog")
    await expect(modal).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId("settings-dirty-save")).toContainText("Salva e chiudi")
    await expect(page.getByTestId("settings-dirty-continue")).toContainText("Continua a modificare")
    await expect(page.getByTestId("settings-dirty-discard")).toContainText("Esci senza salvare")

    // Centered card: its center sits near the viewport center.
    const card = await modal.boundingBox()
    const vp = page.viewportSize()
    expect(card).not.toBeNull()
    expect(vp).not.toBeNull()
    const cx = card!.x + card!.width / 2
    const cy = card!.y + card!.height / 2
    expect(Math.abs(cx - vp!.width / 2)).toBeLessThan(vp!.width * 0.2)
    expect(Math.abs(cy - vp!.height / 2)).toBeLessThan(vp!.height * 0.25)

    // Backdrop click (top-left corner, outside the centered card) is blocked:
    // the modal stays open and the draft is intact.
    await page.mouse.click(12, 12)
    await expect(modal).toBeVisible()
    await expect(page.getByTestId("settings-save")).toBeEnabled()

    // Escape resolves to continue-editing: modal gone, settings still open.
    await page.keyboard.press("Escape")
    await expect(modal).toBeHidden()
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId("settings-save")).toBeEnabled()

    // Discard exits without saving: the settings dialog closes.
    await dialog.getByRole("button", { name: "Chiudi" }).click()
    await expect(modal).toBeVisible()
    await page.getByTestId("settings-dirty-discard").click()
    await expect(dialog).toBeHidden({ timeout: 10_000 })
  })

  test("mobile back opens the same centered modal", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openSettings(page)
    const panel = page.locator(".settings-panel:visible").first()
    await expect(panel).toBeVisible()
    // Dirty the draft through the mobile category selector + a slider.
    await panel.locator("#mobile-settings-category").selectOption("transform")
    const scale = panel.locator('input[type="range"]').first()
    await expect(scale).toBeVisible({ timeout: 15_000 })
    await scale.fill("42")
    await panel.getByRole("button", { name: "Indietro" }).click()

    const modal = page.getByTestId("settings-dirty-dialog")
    await expect(modal).toBeVisible({ timeout: 10_000 })
    const card = await modal.boundingBox()
    const vp = page.viewportSize()
    expect(card).not.toBeNull()
    expect(vp).not.toBeNull()
    const cx = card!.x + card!.width / 2
    expect(Math.abs(cx - vp!.width / 2)).toBeLessThan(vp!.width * 0.2)
    // Continue keeps the panel open with the draft intact.
    await page.getByTestId("settings-dirty-continue").click()
    await expect(modal).toBeHidden()
    await expect(panel).toBeVisible()
  })
})
