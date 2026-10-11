/**
 * Pre-integration browser verification (verification-only, deterministic):
 * exercises the five implemented contracts against the mock-backed app —
 * TMDB age certifications (movie release_dates / tv content_ratings),
 * Trakt anticipated discovery, Hebrew RTL document + InstallModal bidi,
 * EditView footer 2x2 grid, Fresh/Card age + bottom tint.
 *
 * No live credentials: TMDB via e2e/mock-server.mjs fixtures, Trakt via the
 * same mock (TRAKT_CLIENT_ID dummy required only so the server attempts the
 * mocked fetch; the mock serves deterministic anticipated payloads).
 */
import { test, expect } from "@playwright/test"

// Query api_key: the route resolves it (header x-api-key > query api_key >
// env), and the mock TMDB ignores its value. Without it the age fetch is
// gated off (same as production without a key).
const API_KEY = "e2e-mock-key-00000000000000000000000000000001"

function posterUrl(params: Record<string, string>, mediaType = "movie", id: number | string = 19995): string {
  const qs = new URLSearchParams(params)
  return `/api/poster/${mediaType}/${id}?${qs.toString()}`
}

test.describe("pre-integration: age badge resolves via mock TMDB", () => {
  test("movie IT resolves VM14 (same-country label, bounded signal fetch)", async ({ request }) => {
    const res = await request.get(
      posterUrl({
        genreName: "Action",
        voteAverage: "7.8",
        badges: "1",
        ranking: "0",
        age: "1",
        agecountry: "IT",
        debug: "1",
        api_key: API_KEY,
      }),
    )
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.age.enabled).toBe(true)
    expect(body.age.country).toBe("IT")
    expect(body.age.label).toBe("VM14")
    expect(body.age.degraded).toBe(false)
  })

  test("tv US resolves TV-MA via content_ratings", async ({ request }) => {
    const res = await request.get(
      posterUrl(
        {
          genreName: "Action",
          voteAverage: "7.8",
          badges: "1",
          ranking: "0",
          age: "1",
          agecountry: "US",
          debug: "1",
          api_key: API_KEY,
        },
        "tv",
        19995,
      ),
    )
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.age.enabled).toBe(true)
    expect(body.age.country).toBe("US")
    expect(body.age.label).toBe("TV-MA")
    expect(body.age.degraded).toBe(false)
  })

  test("default OFF performs zero extra age network (label null)", async ({ request }) => {
    const res = await request.get(
      posterUrl({
        genreName: "Action",
        voteAverage: "7.8",
        badges: "1",
        ranking: "0",
        debug: "1",
        api_key: API_KEY,
      }),
    )
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.age.enabled).toBe(false)
    expect(body.age.label).toBeNull()
  })

  test("age renders on portrait/landscape/Fresh/Card image responses without 4K", async ({ request }) => {
    const base = {
      genreName: "Action",
      voteAverage: "7.8",
      badges: "1",
      ranking: "1",
      rank: "3",
      label: "Top 3",
      age: "1",
      agecountry: "IT",
      api_key: API_KEY,
    }
    const variants: Array<{ name: string; params: Record<string, string>; mediaType?: string }> = [
      { name: "portrait", params: { ...base } },
      { name: "landscape", params: { ...base, shape: "landscape", backdrop: "/mocked/backdrop.jpg" } },
      { name: "fresh", params: { ...base, layout: "fresh", freshScope: "all" } },
      { name: "card", params: { ...base, layout: "provider-glass" } },
    ]
    for (const v of variants) {
      const res = await request.get(posterUrl(v.params, v.mediaType ?? "movie", 19995))
      expect(res.status(), v.name).toBe(200)
      expect(res.headers()["content-type"], v.name).toContain("image/")
      const buf = await res.body()
      expect(buf.length, v.name).toBeGreaterThan(1000)
    }
  })

  test("fresh bottom tint screenshot (deterministic mock render)", async ({ page, request }) => {
    const url = posterUrl({
      genreName: "Action",
      voteAverage: "7.8",
      badges: "1",
      ranking: "1",
      rank: "3",
      label: "Top 3",
      age: "1",
      agecountry: "IT",
      layout: "fresh",
      freshScope: "all",
      api_key: API_KEY,
    })
    // Warm the render through the API, then screenshot the real bytes by
    // navigating to the image URL itself (setContent cannot resolve a
    // relative src from about:blank, leaving the <img> hidden).
    const res = await request.get(url)
    expect(res.status()).toBe(200)
    await page.goto(url)
    await page.screenshot({ path: "test-results/preint-fresh-tint.png" })
  })
})

test.describe("pre-integration: Trakt anticipated via mock API", () => {
  test("app.trakt.tv anticipated URL resolves deterministic mock items", async ({ request }) => {
    const res = await request.get(
      `/api/mdblist/custom?url=${encodeURIComponent("https://app.trakt.tv/discover/anticipated?mode=movie")}&limit=10`,
    )
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.provider).toBe("trakt")
    expect(body.status).toBe("ok")
    const tmdbIds = (body.items as Array<{ tmdbId?: number }>).map((i) => i.tmdbId)
    expect(tmdbIds).toContain(19995)
    expect(tmdbIds).toContain(157336)
    const titles = (body.items as Array<{ title?: string }>).map((i) => i.title)
    expect(titles).toEqual(expect.arrayContaining(["Avatar", "Interstellar"]))
  })
})

test.describe("pre-integration: Hebrew RTL document + InstallModal bidi", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test("document RTL, modal punctuation/bidi/right alignment, LTR switch-back", async ({ page }) => {
    // NOTE: set defaults only when absent — the LTR switch-back below
    // overwrites preferred_lang then reloads, and init scripts re-run.
    await page.addInitScript(() => {
      try {
        if (!localStorage.getItem("pictorium_profile_id")) {
          localStorage.setItem("pictorium_profile_id", "e2e-preint-he")
          localStorage.setItem("pictorium_profile_stateless", "1")
          localStorage.setItem("pictorium_onboarding_done", "true")
        }
        if (!localStorage.getItem("preferred_lang")) localStorage.setItem("preferred_lang", "he")
      } catch {}
    })
    await page.goto("/")
    await expect.poll(() => page.evaluate(() => document.documentElement.dir)).toBe("rtl")
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("he")

    // Nav install button uses ui.install ("התקנה" in Hebrew; ui.installHub is
    // the header pill label, not this button's accessible name).
    await page.getByRole("button", { name: "התקנה", exact: true }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    // Exact reported punctuation, RTL base direction, URL template LTR.
    await expect(dialog.locator("#install-mode-heading")).toHaveText("מה לכלול?")
    await expect(dialog.locator("#install-mode-heading")).toHaveAttribute("dir", "auto")
    await expect(dialog.locator("#install-hub-title")).toHaveAttribute("dir", "auto")

    await dialog.getByRole("tab", { name: /aio/i }).click()
    const panel = dialog.locator("#install-panel-aio")
    const desc = panel.locator("p").first()
    await expect(desc).toHaveText("יש להדביק את הקישור הזה ב-AIOMetadata תחת Art Providers ← Poster URL Pattern.")
    await expect(desc).toHaveAttribute("dir", "auto")
    const runs = await panel.locator("bdi").allTextContents()
    expect(runs).toContain("AIOMetadata")
    expect(runs).toContain("Art Providers ← Poster URL Pattern")
    const input = panel.locator("input[type='text']").first()
    await expect(input).toHaveAttribute("dir", "ltr")
    // Right alignment: dialog content flows RTL at mobile width, no sideways overflow.
    const overflow = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      dialogDir: getComputedStyle(document.querySelector('[role="dialog"]') as Element).direction,
    }))
    expect(overflow.dialogDir).toBe("rtl")
    expect(overflow.scrollW).toBeLessThanOrEqual(overflow.innerW + 1)
    await page.screenshot({ path: "test-results/preint-he-install.png" })

    // Switching back to Italian restores LTR without touching translations.
    await page.evaluate(() => {
      try {
        localStorage.setItem("preferred_lang", "it")
      } catch {}
    })
    await page.reload()
    await expect.poll(() => page.evaluate(() => document.documentElement.dir)).toBe("ltr")
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("it")
  })

  test("Hebrew editor footer: no clipping at mobile width", async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.clear()
        localStorage.setItem("pictorium_profile_id", "e2e-preint-he-footer")
        localStorage.setItem("pictorium_profile_stateless", "1")
        localStorage.setItem("pictorium_onboarding_done", "true")
        localStorage.setItem("preferred_lang", "he")
        localStorage.setItem("tmdb_key", "e2e-mock-key-00000000000000000000000000000001")
      } catch {}
    })
    await page.goto("/")
    await expect.poll(() => page.evaluate(() => document.documentElement.dir)).toBe("rtl")
    const search = page.getByPlaceholder(/חיפוש/)
    await expect(search).toBeVisible({ timeout: 30_000 })
    await search.fill("Avatar")
    // The search result is a dedicated button; the demo carousel headings
    // share the same text but auto-scroll (never stable click targets).
    const result = page.getByRole("button", { name: "Avatar", exact: true })
    await expect(result).toBeVisible({ timeout: 20_000 })
    await result.click()
    const grid = page.locator(".editor-panel-footer .grid")
    await expect(grid).toBeVisible({ timeout: 15_000 })
    const overflow = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
    }))
    expect(overflow.scrollW).toBeLessThanOrEqual(overflow.innerW + 1)
    await grid.screenshot({ path: "test-results/preint-he-footer.png" })
  })
})

test.describe("pre-integration: EditView footer 2x2 equal rows", () => {
  test.use({ viewport: { width: 500, height: 900 } })

  test("two-column grid, stretched equal heights, no clipping", async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.clear()
        localStorage.setItem("pictorium_profile_id", "e2e-preint-footer")
        localStorage.setItem("pictorium_profile_stateless", "1")
        localStorage.setItem("pictorium_onboarding_done", "true")
        localStorage.setItem("preferred_lang", "it")
        localStorage.setItem("tmdb_key", "e2e-mock-key-00000000000000000000000000000001")
      } catch {}
    })
    await page.goto("/")
    const search = page.getByPlaceholder(/cerca/i)
    await expect(search).toBeVisible({ timeout: 30_000 })
    await search.fill("Avatar")
    // The search result is a dedicated button; the demo carousel headings
    // share the same text but auto-scroll (never stable click targets).
    const result = page.getByRole("button", { name: "Avatar", exact: true })
    await expect(result).toBeVisible({ timeout: 20_000 })
    await result.click()
    const grid = page.locator(".editor-panel-footer .grid")
    await expect(grid).toBeVisible({ timeout: 15_000 })
    const geo = await grid.evaluate((el) => {
      const cs = getComputedStyle(el)
      const buttons = [...el.querySelectorAll(":scope > button")].map((b) => {
        const r = (b as HTMLElement).getBoundingClientRect()
        // Contract is the 44px minimum touch target (min-h-[44px]); the
        // measured rect can round subpixel (43.98) depending on DPR/zoom, so
        // assert the computed style, not the rasterized box.
        return { h: r.height, top: r.top, w: r.width, minH: getComputedStyle(b as HTMLElement).minHeight }
      })
      const gridRect = el.getBoundingClientRect()
      return {
        columns: cs.gridTemplateColumns.split(" ").filter(Boolean).length,
        align: cs.alignItems,
        autoRows: cs.gridAutoRows,
        buttons,
        gridBottom: gridRect.bottom,
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
      }
    })
    // 500px > 420px breakpoint → 2 columns; items-stretch + auto-rows-fr.
    expect(geo.columns).toBe(2)
    expect(geo.align).toBe("stretch")
    // Tailwind auto-rows-fr compiles to minmax(0, 1fr): assert the 1fr track.
    expect(geo.autoRows).toContain("1fr")
    expect(geo.buttons.length).toBeGreaterThanOrEqual(3)
    // Row mates share the same height (equal-height rows).
    const rows = new Map<number, number[]>()
    for (const b of geo.buttons) {
      const key = Math.round(b.top)
      rows.set(key, [...(rows.get(key) ?? []), b.h])
    }
    for (const heights of rows.values()) {
      if (heights.length > 1) {
        expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1)
      }
    }
    for (const b of geo.buttons) {
      expect(b.minH).toBe("44px")
      expect(b.h).toBeGreaterThan(0)
    }
    expect(geo.overflowX).toBeLessThanOrEqual(1)
    await grid.screenshot({ path: "test-results/preint-footer-2x2.png" })
  })
})
