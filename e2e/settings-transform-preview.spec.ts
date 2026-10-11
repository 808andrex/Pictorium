import { test, expect, type Page } from "@playwright/test"
import { putDefaultsWithRetry } from "./defaults-retry"

// Settings > Trasforma preview-only (Verticale/Orizzontale).
// Nessuno snapshot: solo trasporto reale (request preview demo) e aspect.
// Le API esterne sono servite dal mock server (playwright.config.ts).

const DEMO_PATH = "/api/poster/movie/19995"

function tryDemoUrl(raw: string): URL | null {
  if (!raw.includes(DEMO_PATH)) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.searchParams.get("preview") !== "1") return null
  // Geometry metadata (`debug=1&netgeo=1`, fetched via fetch() by
  // useNetworkGeometry) returns JSON, not the rendered poster image (loaded
  // via XHR blob, hence resourceType filtering would miss every genuine
  // preview — the debug/netgeo query exclusion is the precise semantic).
  // Counting it as a preview render breaks the no-image-refetch assertions.
  if (u.searchParams.get("netgeo") === "1" || u.searchParams.get("debug") === "1") return null
  return u
}

/** Geometry metadata fetch for the same demo path (JSON, never an image). */
function tryGeometryUrl(raw: string): URL | null {
  if (!raw.includes(DEMO_PATH)) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  return u.searchParams.get("netgeo") === "1" ? u : null
}

interface Seen {
  urls: string[]
  geometryUrls: string[]
}

/** Log di tutte le request preview demo (anche quelle già partite). */
function collectPreviewRequests(page: Page, seen: Seen) {
  page.on("request", (req) => {
    const raw = req.url()
    if (tryDemoUrl(raw)) {
      seen.urls.push(raw)
      return
    }
    if (tryGeometryUrl(raw)) seen.geometryUrls.push(raw)
  })
}

function findParams(urls: string[], from: number, pred: (u: URL) => boolean): URLSearchParams | null {
  for (const raw of urls.slice(from)) {
    const u = tryDemoUrl(raw)
    if (u && pred(u)) return u.searchParams
  }
  return null
}

/** Qualsiasi request (anche precedente) che soddisfa `pred`. */
async function waitPreview(seen: Seen, pred: (u: URL) => boolean = () => true) {
  let out: URLSearchParams | null = null
  await expect
    .poll(
      () => {
        out = findParams(seen.urls, 0, pred)
        return out ? "ok" : null
      },
      { timeout: 30_000 },
    )
    .not.toBeNull()
  return out as unknown as URLSearchParams
}

/**
 * Dopo `action`, attende una NUOVA request che soddisfa `pred`
 * (prova il live update; le request precedenti non contano).
 */
async function nextPreview(seen: Seen, action: () => Promise<unknown>, pred: (u: URL) => boolean = () => true) {
  const n = seen.urls.length
  await action()
  let out: URLSearchParams | null = null
  await expect
    .poll(
      () => {
        out = findParams(seen.urls, n, pred)
        return out ? "ok" : null
      },
      { timeout: 30_000 },
    )
    .not.toBeNull()
  return out as unknown as URLSearchParams
}

async function seed(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.clear()
      localStorage.setItem("pictorium_profile_id", "e2e-transform")
      localStorage.setItem("pictorium_profile_stateless", "1")
      localStorage.setItem("pictorium_onboarding_done", "true")
      localStorage.setItem("preferred_lang", "it")
      localStorage.setItem("tmdb_key", "")
    } catch {}
  })
}

/**
 * Default server deterministici (merge parziale, pattern di
 * button-interactions.spec.ts): isola dagli altri spec che persistono
 * tuning condiviso nella stessa data-dir. Landscape sostituito in toto
 * (merge shallow), con override diversi dai flat per provare il profilo.
 * networkLogo + follow espliciti: il fetch geometria (netgeo) è gated su di
 * essi e il PUT è merge-only — senza, un networkLogo spento lasciato da uno
 * spec precedente sopprime il fetch per tutto il test (0 request, mai un
 * semplice ritardo).
 */
async function resetServerDefaults(page: Page) {
  await page.goto("/")
  await putDefaultsWithRetry(page, "reset defaults", {
    gradientHeight: 30,
    topBadgeScale: 100,
    qualityBadgeOffsetX: -10,
    qualityBadgeOffsetY: 15,
    networkLogo: true,
    networkLogoFollowTitle: true,
    landscape: {
      gradientHeight: 20,
      topBadgeScale: 120,
      qualityBadgeOffsetX: 7,
      qualityBadgeOffsetY: -7,
    },
  })
  await page.goto("/")
}

test.describe("Trasforma Verticale/Orizzontale preview-only", () => {
  test("desktop: tab Orizzontale → landscape live, slider → nuovi params, Verticale → flat", async ({ page }) => {
    await seed(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await resetServerDefaults(page)
    const seen: Seen = { urls: [], geometryUrls: [] }
    collectPreviewRequests(page, seen)

    // Apro Impostazioni (tab Badge): la preview parte subito dai default.
    await page.getByRole("button", { name: /Impostazioni/i }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    let p = await waitPreview(seen)
    expect(p.get("shape")).toBe("poster")
    expect(p.get("gradHeight")).toBe("30")

    // Passo a Trasforma (sotto-tab Verticale): stesso URL → nessun refetch
    // immagine. Il freeze geometria (debug=1&netgeo=1, JSON) parte invece
    // subito: va nel bucket geometria, mai in quello preview.
    const before = seen.urls.length
    const geoBefore = seen.geometryUrls.length
    await dialog.getByRole("tab", { name: "Trasforma", exact: true }).click()
    const panel = dialog.getByRole("tabpanel", { name: "Trasforma" })
    await expect(panel).toBeVisible()
    // The geometry fetch is gated on hydrated editor state (network follow):
    // under full-suite load the shared `defaults` bucket 429s delay hydration
    // past any fixed sleep, so poll for the fetch like every preview
    // assertion in this file. The no-image-refetch check below keeps (and its
    // window only grows while polling).
    await expect.poll(() => seen.geometryUrls.length, { timeout: 30_000 }).toBeGreaterThan(geoBefore)
    expect(seen.urls.length).toBe(before)
    // Regressione: la geometria network è metadata JSON sulla stessa preview
    // (stessi params + debug/netgeo), distinta dal render immagine.
    expect(seen.geometryUrls.length).toBeGreaterThan(geoBefore)
    const geo = new URL(seen.geometryUrls[seen.geometryUrls.length - 1])
    expect(geo.searchParams.get("preview")).toBe("1")
    expect(geo.searchParams.get("debug")).toBe("1")
    expect(geo.searchParams.get("netgeo")).toBe("1")
    expect(geo.searchParams.get("shape")).toBe("poster")
    expect(seen.urls.every((raw) => !new URL(raw).searchParams.has("netgeo"))).toBe(true)
    p = await waitPreview(seen)
    expect(p.get("shape")).toBe("poster")

    // Landscape via the single top selector (before the controls): profiled landscape request.
    const formatTarget = dialog.getByTestId("format-target-selector")
    await expect(formatTarget).toBeVisible()
    p = await nextPreview(seen, async () => {
      await formatTarget.getByText("Orizzontale", { exact: true }).click()
    })
    expect(p.get("shape")).toBe("landscape")
    expect(p.get("gradHeight")).toBe("20")
    expect(p.get("tscale")).toBe("120")
    expect(p.get("qox")).toBe("7")
    expect(p.get("qoy")).toBe("-7")
    // Aspect conforme all'URL.
    const previewBox = page.getByTestId("settings-preview")
    await expect(previewBox.locator(".aspect-video")).toBeVisible()

    // Slider live reali (tastiera): Altezza Orizzontale 20 → 25.
    const landSection = panel.getByText("Override sfumatura Orizzontale").locator("..")
    const height = landSection.getByLabel("Altezza", { exact: true })
    await expect(height).toHaveValue("20")
    await height.focus()
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight")
    p = await nextPreview(seen, async () => {}, (u) => u.searchParams.get("gradHeight") === "25")
    expect(p.get("shape")).toBe("landscape")
    expect(p.get("gradHeight")).toBe("25")

    // Scala badge superiore Orizzontale 120 → 125.
    const topCard = landSection.getByText("Classifica", { exact: true }).locator("xpath=../..")
    const scale = topCard.getByLabel("Scala", { exact: true })
    await expect(scale).toHaveValue("120")
    await scale.focus()
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight")
    p = await nextPreview(seen, async () => {}, (u) => u.searchParams.get("tscale") === "125")
    expect(p.get("tscale")).toBe("125")

    // Back to Portrait from the single selector: original flats, no mixing.
    p = await nextPreview(seen, async () => {
      await formatTarget.getByText("Verticale", { exact: true }).click()
    })
    expect(p.get("shape")).toBe("poster")
    expect(p.get("gradHeight")).toBe("30")
    expect(p.get("tscale")).toBe("100")
    expect(p.get("qox")).toBe("-10")
    await expect(previewBox.locator(".aspect-video")).toHaveCount(0)

    // Tab Badge: default esistente (portrait), nessun refetch spurio.
    const n = seen.urls.length
    await dialog.getByRole("tab", { name: "Badge", exact: true }).click()
    await page.waitForTimeout(1500)
    expect(seen.urls.length).toBe(n)
    p = await waitPreview(seen)
    expect(p.get("shape")).toBe("poster")
  })

  test("mobile: Orizzontale → landscape live + aspect, Verticale → flat", async ({ page }) => {
    await seed(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await resetServerDefaults(page)
    const seen: Seen = { urls: [], geometryUrls: [] }
    collectPreviewRequests(page, seen)

    await page.getByRole("button", { name: /Impostazioni/i }).click()
    // Su mobile la nav tab è un select visibile.
    const category = page.locator("select:visible").first()
    await expect(category).toBeVisible()
    let p = await waitPreview(seen)
    expect(p.get("shape")).toBe("poster")

    await category.selectOption("trasforma")
    const panel = page.getByRole("tabpanel", { name: "Trasforma" }).filter({ visible: true }).first()
    await expect(panel).toBeVisible()

    p = await nextPreview(seen, async () => {
      await page.locator(".settings-panel:visible").getByTestId("format-target-selector").getByText("Orizzontale", { exact: true }).click()
    })
    expect(p.get("shape")).toBe("landscape")
    expect(p.get("gradHeight")).toBe("20")
    expect(p.get("qox")).toBe("7")
    // Preview compatta sopra i controlli, conforme all'URL.
    const compact = page.locator(".settings-panel:visible").first()
    await expect(compact.locator(".aspect-video").first()).toBeVisible()

    const landSection = panel.getByText("Override sfumatura Orizzontale").locator("..")
    const height = landSection.getByLabel("Altezza", { exact: true })
    await expect(height).toHaveValue("20")
    await height.focus()
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight")
    p = await nextPreview(seen, async () => {}, (u) => u.searchParams.get("gradHeight") === "25")
    expect(p.get("shape")).toBe("landscape")
    expect(p.get("gradHeight")).toBe("25")

    p = await nextPreview(seen, async () => {
      await page.locator(".settings-panel:visible").getByTestId("format-target-selector").getByText("Verticale", { exact: true }).click()
    })
    expect(p.get("shape")).toBe("poster")
    expect(p.get("gradHeight")).toBe("30")
    // Regressione: il vincitore è un vero render preview (mai metadata
    // geometria) e nessuna URL geometria è mai finita nel bucket preview.
    expect(p.get("debug")).toBeNull()
    expect(p.get("netgeo")).toBeNull()
    expect(seen.urls.every((raw) => !new URL(raw).searchParams.has("netgeo"))).toBe(true)
    expect(seen.geometryUrls.every((raw) => new URL(raw).searchParams.get("netgeo") === "1")).toBe(true)
  })
})
