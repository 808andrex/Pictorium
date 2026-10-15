/**
 * Hebrew/Arabic RTL regression: document lang/dir follows the selected
 * language (initialized and reset on switch), the install dialog keeps the
 * correct base direction on translated labels, and machine-readable URL
 * templates stay LTR.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
// Opt out of the global @/lib/i18n mock: this file asserts the real setLang
// document side effects, which the mock replaces with vi.fn().
vi.unmock("@/lib/i18n")

import { fireEvent, screen } from "@testing-library/react"
import { InstallModal } from "@/components/InstallModal"
import { renderWithCtx } from "@/__tests__/test-utils"
import {
  baseLangCode,
  documentDirectionFor,
  getLang,
  isRtlLang,
  setLang,
  DOCUMENT_LANG_PREPAINT_SCRIPT,
} from "@/lib/i18n"
import heDict from "@/lib/translations/he.json"
import itDict from "@/lib/translations/it.json"

const he = heDict as Record<string, string>
const itStr = itDict as Record<string, string>

const TMDB = "https://pictorium.test/api/poster/{type}/{tmdb_id}?lang=he&rv=1"
const IMDB = "https://pictorium.test/api/poster/{type}/{imdb_id}?lang=he&rv=1"
const AUTO = "https://pictorium.test/api/poster/{type}/{tmdb_id|imdb_id}?lang=he&rv=1"
const NUVIO_TMDB = "https://pictorium.test/api/poster/{type}/{tmdb_id}?lang=he&rv=1&shape={shape}"
const NUVIO_IMDB = "https://pictorium.test/api/poster/{type}/{imdb_id}?lang=he&rv=1&shape={shape}"
const NUVIO_AUTO = "https://pictorium.test/api/poster/{type}/{tmdb_id|imdb_id}?lang=he&rv=1&shape={shape}"

function hebrewT(key: string): string {
  return he[key] ?? key
}

function italianT(key: string): string {
  return itStr[key] ?? key
}

function renderHebrewModal() {
  renderWithCtx(
    <InstallModal
      isOpen={true}
      onClose={vi.fn()}
      manifestUrl="https://pictorium.test/manifest.json"
      posterUrlPattern={TMDB}
      posterUrlPatternImdb={IMDB}
      posterUrlPatternAuto={AUTO}
      posterUrlPatternNuvio={NUVIO_TMDB}
      posterUrlPatternNuvioImdb={NUVIO_IMDB}
      posterUrlPatternNuvioAuto={NUVIO_AUTO}
    />,
    { t: hebrewT },
  )
}

function activeTemplateInput(): HTMLInputElement {
  const activePanel = document.querySelector('[role="tabpanel"]:not([hidden])')
  return activePanel?.querySelector("input[type='text']") as HTMLInputElement
}

describe("RTL document direction", () => {
  beforeEach(() => {
    setLang("it")
  })

  it("derives rtl from Hebrew and Arabic, ltr from every other language", () => {
    expect(documentDirectionFor("he")).toBe("rtl")
    expect(documentDirectionFor("ar")).toBe("rtl")
    for (const lang of ["it", "en", "pl", "fr", "de", "es", "es-419", "ja", "ko", "pt", "cs", "ro", "tr", "nl", "sv", "vi"]) {
      expect(documentDirectionFor(lang)).toBe("ltr")
    }
    // Unknown/empty languages fall back to LTR, never to a stale RTL.
    expect(documentDirectionFor("")).toBe("ltr")
    expect(documentDirectionFor("xx")).toBe("ltr")
  })

  it("normalizes case and region subtags before detecting direction", () => {
    expect(baseLangCode("HE")).toBe("he")
    expect(baseLangCode("he-IL")).toBe("he")
    expect(baseLangCode("AR-sa")).toBe("ar")
    expect(isRtlLang("HE")).toBe(true)
    expect(isRtlLang("he-IL")).toBe(true)
    expect(isRtlLang("ar-SA")).toBe(true)
    // es-419/es-MX stay LTR: numeric/region subtags never flip direction.
    expect(isRtlLang("es-419")).toBe(false)
    expect(isRtlLang("es-MX")).toBe(false)
  })

  it("setLang commits lang and dir together for Hebrew", () => {
    setLang("he")
    expect(getLang()).toBe("he")
    expect(document.documentElement.lang).toBe("he")
    expect(document.documentElement.dir).toBe("rtl")
  })

  it("setLang commits lang and dir together for Arabic", () => {
    setLang("ar")
    expect(getLang()).toBe("ar")
    expect(document.documentElement.lang).toBe("ar")
    expect(document.documentElement.dir).toBe("rtl")
  })

  it("setLang resets direction back to LTR when leaving RTL", () => {
    setLang("he")
    expect(document.documentElement.dir).toBe("rtl")
    setLang("it")
    expect(document.documentElement.lang).toBe("it")
    expect(document.documentElement.dir).toBe("ltr")
    setLang("ar")
    expect(document.documentElement.dir).toBe("rtl")
    setLang("en")
    expect(document.documentElement.lang).toBe("en")
    expect(document.documentElement.dir).toBe("ltr")
  })

  it("setLang normalizes the direction of cased language codes", () => {
    setLang("HE")
    expect(document.documentElement.dir).toBe("rtl")
    setLang("IT")
    expect(document.documentElement.dir).toBe("ltr")
  })
})

describe("pre-paint language script", () => {
  const LANG_KEY = "preferred_lang"

  function runPrepaintScript(storedLang: string | null) {
    try {
      if (storedLang === null) window.localStorage.removeItem(LANG_KEY)
      else window.localStorage.setItem(LANG_KEY, storedLang)
    } catch {
      // jsdom without storage: the script itself tolerates this.
    }
    document.documentElement.removeAttribute("lang")
    document.documentElement.setAttribute("dir", "ltr")
    // Execute the exact string the layout inlines in <head>.
    new Function(DOCUMENT_LANG_PREPAINT_SCRIPT)()
  }

  afterEach(() => {
    try {
      window.localStorage.removeItem(LANG_KEY)
    } catch {}
    document.documentElement.setAttribute("lang", "it")
    document.documentElement.setAttribute("dir", "ltr")
  })

  it("applies Hebrew with RTL before paint, matching setLang", () => {
    runPrepaintScript("he")
    expect(document.documentElement.getAttribute("lang")).toBe("he")
    expect(document.documentElement.getAttribute("dir")).toBe("rtl")
    expect(document.documentElement.getAttribute("dir")).toBe(documentDirectionFor("he"))
  })

  it("applies Arabic with RTL and normalizes cased codes", () => {
    runPrepaintScript("AR")
    expect(document.documentElement.getAttribute("dir")).toBe("rtl")
    runPrepaintScript("he-IL")
    expect(document.documentElement.getAttribute("lang")).toBe("he-IL")
    expect(document.documentElement.getAttribute("dir")).toBe("rtl")
  })

  it("falls back to LTR without touching lang when nothing is stored", () => {
    runPrepaintScript(null)
    expect(document.documentElement.getAttribute("dir")).toBe("ltr")
    expect(document.documentElement.hasAttribute("lang")).toBe(false)
  })

  it("resets to LTR for Latin languages, mirroring setLang", () => {
    runPrepaintScript("it")
    expect(document.documentElement.getAttribute("lang")).toBe("it")
    expect(document.documentElement.getAttribute("dir")).toBe("ltr")
  })
})

describe("InstallModal Hebrew RTL semantics", () => {
  beforeEach(() => {
    setLang("it")
  })

  it("renders the reported 'what to include' label with RTL base direction", () => {
    setLang("he")
    renderHebrewModal()
    const heading = document.getElementById("install-mode-heading")!
    // Exact reported string, never manually reversed or re-punctuated.
    expect(heading.textContent).toBe(he["ui.installWhatInclude"])
    expect(heading.textContent).toBe("מה לכלול?")
    expect(heading.getAttribute("dir")).toBe("auto")
  })

  it("keeps dialog title and subtitle on their own base direction", () => {
    setLang("he")
    renderHebrewModal()
    const title = document.getElementById("install-hub-title")!
    expect(title.textContent).toBe(he["ui.installHubTitle"])
    expect(title.getAttribute("dir")).toBe("auto")
  })

  it("isolates mixed Latin/Hebrew AIO copy in bdi runs and keeps the URL template LTR", () => {
    setLang("he")
    renderHebrewModal()
    fireEvent.click(screen.getByRole("tab", { name: /aio/i }))
    const panel = document.getElementById("install-panel-aio")!
    const desc = panel.querySelector("p")!
    // The translation itself is untouched: bdi splitting is lossless.
    expect(desc.textContent).toBe(he["ui.installAioDesc"])
    expect(desc.textContent).toBe("יש להדביק את הקישור הזה ב-AIOMetadata תחת Art Providers ← Poster URL Pattern.")
    expect(desc.getAttribute("dir")).toBe("auto")
    // Isolation semantics (not textContent contiguity): each Latin run is a
    // directionally self-determined isolate, so neutrals/spaces around them
    // cannot attach to the Hebrew runs and reorder the brands.
    const runs = [...desc.querySelectorAll("bdi")].map((el) => el.textContent)
    expect(runs).toContain("AIOMetadata")
    expect(runs).toContain("Art Providers ← Poster URL Pattern")
    const input = activeTemplateInput()
    expect(input.value).toBe(AUTO)
    expect(input.getAttribute("dir")).toBe("ltr")
  })

  it("isolates the Nuvio Latin runs and keeps the URL template LTR with placeholders intact", () => {
    setLang("he")
    renderHebrewModal()
    fireEvent.click(screen.getByRole("tab", { name: /nuvio/i }))
    const panel = document.getElementById("install-panel-nuvio")!
    const desc = panel.querySelector("p")!
    expect(desc.textContent).toBe(he["ui.installNuvioDesc"])
    const runs = [...desc.querySelectorAll("bdi")].map((el) => el.textContent)
    expect(runs).toContain("Poster URL")
    expect(runs).toContain("Nuvio")
    const input = activeTemplateInput()
    expect(input.value).toBe(NUVIO_AUTO)
    expect(input.value).toContain("{shape}")
    expect(input.getAttribute("dir")).toBe("ltr")
  })

  it("switching back to Italian restores LTR UI without touching translations", () => {
    setLang("he")
    expect(document.documentElement.dir).toBe("rtl")
    setLang("it")
    expect(document.documentElement.dir).toBe("ltr")
    renderWithCtx(
      <InstallModal
        isOpen={true}
        onClose={vi.fn()}
        manifestUrl="https://pictorium.test/manifest.json"
        posterUrlPattern={TMDB}
        posterUrlPatternAuto={AUTO}
      />,
      { t: italianT },
    )
    const heading = document.getElementById("install-mode-heading")!
    expect(heading.textContent).toBe(itStr["ui.installWhatInclude"])
    expect(heading.textContent).toBe("Cosa vuoi includere?")
    // dir="auto" resolves to LTR for Italian text; the attribute itself is
    // direction-neutral and stays put across switches.
    expect(heading.getAttribute("dir")).toBe("auto")
    fireEvent.click(screen.getByRole("tab", { name: /aio/i }))
    expect(activeTemplateInput().getAttribute("dir")).toBe("ltr")
  })
})
