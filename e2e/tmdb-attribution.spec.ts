import { test, expect, type Page } from "@playwright/test"

/**
 * Narrow, focused browser acceptance for the TMDB attribution footer
 * (HomeStatusStrip "Credits" region).
 *
 * Scope (real browser layout — no CSS/geometry mocking, no live credentials):
 *  - the exact notice is always visible (320px mobile included) and the local
 *    official logo is actually served and rendered;
 *  - the rendered logo keeps the intrinsic aspect ratio at 20px height;
 *  - no horizontal overflow at 320px and 1280px;
 *  - the Credits region stays inside the viewport and never overlaps the
 *    status controls, which remain operable (status link + changelog button).
 *
 * Deterministic: local mock server + isolated app from playwright.config.ts.
 * This is NOT the full visual regression gate: the `home-key-status` snapshot
 * is intentionally not touched.
 */

const NOTICE =
  "This product uses the TMDB API but is not endorsed or certified by TMDB."
const LOGO_SRC =
  "/attribution/tmdb/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg"
// Intrinsic viewBox of the official file is 185.04 x 133.4 — the same ratio as
// the integer width/height attributes on the <img> (18504 x 13340).
const INTRINSIC_W = 18504
const INTRINSIC_H = 13340
const RENDERED_HEIGHT = 20

const VIEWPORTS = [
  { name: "mobile-320", width: 320, height: 800 },
  { name: "desktop-1280", width: 1280, height: 900 },
] as const

async function openHome(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.clear()
      localStorage.setItem("pictorium_profile_id", "e2e-tmdb-attribution")
      localStorage.setItem("pictorium_profile_stateless", "1")
      localStorage.setItem("pictorium_onboarding_done", "true")
      localStorage.setItem("preferred_lang", "it")
      localStorage.setItem("tmdb_key", "")
    } catch {}
  })
  await page.goto("/")
  const strip = page.getByTestId("home-status")
  await expect(strip).toBeVisible({ timeout: 30_000 })
  // Center the footer: the fixed mobile bottom nav (md:hidden) must not occlude
  // the Credits region in the evidence screenshot or the control hit-tests.
  await strip.evaluate((el) => el.scrollIntoView({ block: "center" }))
  await page.waitForTimeout(150)
  return strip
}

for (const vp of VIEWPORTS) {
  test(`TMDB attribution footer — visible, undistorted, non-overlapping @ ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height })

    // Attach before navigation so the logo request is never missed.
    const logoResponse = page.waitForResponse(
      (r) => r.url().includes(LOGO_SRC),
      { timeout: 30_000 },
    )
    const strip = await openHome(page)

    // 1. Exact notice inside the accessible, never-hidden Credits region.
    const credits = page.getByRole("region", { name: "Credits" })
    await expect(credits).toBeVisible()
    const notice = credits.getByRole("link")
    await expect(notice).toBeVisible()
    await expect(notice).toHaveText(NOTICE)
    await expect(notice).toHaveAttribute("href", "https://www.themoviedb.org/")

    // 2. Local official logo served with 200 and rendered by the browser.
    const resp = await logoResponse
    expect(resp.status()).toBe(200)
    const logo = credits.getByRole("img", { name: "The Movie Database (TMDB)" })
    await expect(logo).toHaveAttribute("src", LOGO_SRC)
    await expect(logo).toBeVisible()
    const decoded = await logo.evaluate(async (el) => {
      const img = el as HTMLImageElement
      try {
        await img.decode()
        return true
      } catch {
        return false
      }
    })
    expect(decoded).toBe(true)

    // 3. Rendered aspect matches the intrinsic ratio at exactly 20px height.
    const logoBox = await logo.boundingBox()
    expect(logoBox).not.toBeNull()
    const expectedW = RENDERED_HEIGHT * (INTRINSIC_W / INTRINSIC_H)
    expect(Math.abs(logoBox!.height - RENDERED_HEIGHT)).toBeLessThanOrEqual(1)
    expect(Math.abs(logoBox!.width - expectedW)).toBeLessThanOrEqual(1)
    expect(
      Math.abs(logoBox!.width / logoBox!.height - INTRINSIC_W / INTRINSIC_H),
    ).toBeLessThan(0.02)

    // 4. No horizontal overflow. The app-shell sets overflow-x:hidden, which
    //    can mask document scrollWidth — the element rects below are the
    //    authoritative overflow check.
    const metrics = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      bodyScrollW: document.body.scrollWidth,
      innerW: window.innerWidth,
    }))
    expect(metrics.scrollW).toBeLessThanOrEqual(metrics.innerW + 1)
    expect(metrics.bodyScrollW).toBeLessThanOrEqual(metrics.innerW + 1)

    const stripBox = await strip.boundingBox()
    const creditsBox = await credits.boundingBox()
    const noticeBox = await notice.boundingBox()
    for (const box of [stripBox, creditsBox, noticeBox, logoBox]) {
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(-1)
      expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 1)
    }

    // 5. Credits region must not overlap the status controls.
    const leftBox = await strip.locator(".status-left").boundingBox()
    const rightBox = await strip.locator(".status-right").boundingBox()
    for (const ctrl of [leftBox, rightBox]) {
      if (!ctrl) continue
      const overlapX =
        creditsBox!.x < ctrl.x + ctrl.width && ctrl.x < creditsBox!.x + creditsBox!.width
      const overlapY =
        creditsBox!.y < ctrl.y + ctrl.height && ctrl.y < creditsBox!.y + creditsBox!.height
      expect(overlapX && overlapY, "Credits region overlaps status controls").toBe(false)
    }

    // 6. Status link + changelog button remain operable.
    const statusLink = strip.locator("a.status-live-badge")
    await expect(statusLink).toBeVisible()
    await expect(statusLink).toHaveAttribute("href", /\/status/)
    const changelogBtn = page.getByTestId("changelog-open")
    await expect(changelogBtn).toBeVisible()
    await changelogBtn.click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()

    // 7. Evidence: real footer screenshot + viewport/layout metrics.
    const shot = `test-results/tmdb-attribution-${vp.name}.png`
    await strip.screenshot({ path: shot })
    console.log(
      `[tmdb-attribution] ${JSON.stringify({
        viewport: vp.name,
        innerWidth: metrics.innerW,
        scrollWidth: metrics.scrollW,
        bodyScrollWidth: metrics.bodyScrollW,
        logoBox,
        creditsBox,
        noticeBox,
        stripBox,
        screenshot: shot,
      })}`,
    )
  })
}
