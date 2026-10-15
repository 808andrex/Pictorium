import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
// The global test setup mocks @/lib/i18n with a fixed Italian dictionary:
// opt out to exercise the real dictionaries (pattern used by
// translations-parity and es419-lang.test.ts, which import JSON directly).
// Real dictionaries come from the server facade (eager registration).
vi.unmock("@/lib/i18n")
import { createT, isDictionaryLoaded } from "@/lib/i18n-server"
import { loadLanguage } from "@/lib/i18n-loader"
import ptDict from "@/lib/translations/pt.json"
import {
  UI_LANG_META,
  SUPPORTED_UI_LANGS,
  contentLanguageForUiLang,
  defaultRegionForLang,
  getRegionDef,
  isSupportedUiLang,
} from "@/lib/regions"
import { UI_LANGUAGES, LANG_FLAGS, LANG_NAMES } from "@/lib/utils"
import {
  __clearTMDBCache,
  getDetails,
  getImages,
  searchMulti,
  toImageLanguages,
  toProviderLanguage,
} from "@/lib/tmdb"
import { logoBestLogoFallbackReason, selectBestLogo, selectLogoTier } from "@/lib/logo-selection"
import type { TMDBImage } from "@/lib/types"
import { applyLocalBackup, collectLocalBackup, type MinimalStorage } from "@/lib/backup-local"
import { mappingSchema, validatePosterQuery } from "@/lib/validation"
import { buildStremioPosterSearchParams } from "@/lib/stremio-poster-params"

/**
 * pt-br language feature (Brazilian Portuguese UI choice):
 * legacy `pt` keeps Portugal semantics, `pt-br` resolves provider details
 * to pt-BR independently of the chart country while images/logos use the
 * pt base. The UI dictionary is aliased (pt-br reuses pt, never English).
 */
function logo(iso: string | null, path: string): TMDBImage {
  return { file_path: path, iso_639_1: iso } as TMDBImage
}

async function requestedUrls(fn: () => Promise<unknown>): Promise<string[]> {
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}) as Response)
  __clearTMDBCache()
  try {
    await fn()
  } catch {
    // Parse errors are irrelevant here: only the request URL is asserted.
  }
  const urls = spy.mock.calls.map((call) => String(call[0]))
  spy.mockRestore()
  return urls
}

function memStorage(seed: Record<string, string> = {}): MinimalStorage & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    dump: () => Object.fromEntries(map),
  }
}

describe("pt-br language feature", () => {
  beforeEach(() => {
    __clearTMDBCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("exposes exactly Portugal legacy pt + Brazil pt-br picker choices with correct flags", () => {
    // No pt-PT UI code is introduced.
    expect(SUPPORTED_UI_LANGS).not.toContain("pt-PT")
    expect(UI_LANG_META.find((l) => l.code === "pt-PT")).toBeUndefined()
    expect(UI_LANG_META.find((l) => l.code === "pt")).toMatchObject({
      flag: "🇵🇹",
      name: "Português (Portugal)",
    })
    expect(UI_LANG_META.find((l) => l.code === "pt-br")).toMatchObject({
      flag: "🇧🇷",
      name: "Português (Brasil)",
    })
    const pickerPt = UI_LANGUAGES.find((l) => l.code === "pt")
    expect(pickerPt).toMatchObject({ flag: "🇵🇹", name: "Português (Portugal)", sub: "PT" })
    const pickerBr = UI_LANGUAGES.find((l) => l.code === "pt-br")
    expect(pickerBr).toMatchObject({ flag: "🇧🇷", name: "Português (Brasil)", sub: "PT-BR" })
    expect(LANG_FLAGS["pt-br"]).toBe("🇧🇷")
    expect(LANG_NAMES["pt-br"]).toBe("Português (Brasil)")
    // Legacy display entries are untouched.
    expect(LANG_FLAGS["pt"]).toBe("🇵🇹")
    expect(LANG_NAMES["pt"]).toBe("Português")
  })

  it("validates pt-br (case-insensitively) while rejecting pt-PT", () => {
    expect(isSupportedUiLang("pt-br")).toBe(true)
    expect(isSupportedUiLang("PT-BR")).toBe(true)
    expect(isSupportedUiLang("pt")).toBe(true)
    expect(isSupportedUiLang("pt-PT")).toBe(false)
  })

  it("survives preference persistence, backup round-trip and mapping validation", () => {
    expect(collectLocalBackup(memStorage({ preferred_lang: "pt-br" }), null).lang).toBe("pt-br")
    expect(collectLocalBackup(memStorage({ preferred_lang: "PT-BR" }), null).lang).toBe("pt-br")
    const target = memStorage()
    const res = applyLocalBackup(target, null, { lang: "pt-br" })
    expect(res.skipped).toEqual([])
    expect(target.dump().preferred_lang).toBe("pt-br")
    // Mapping language is free-form: pt-br persists wherever other language
    // paths persist it (no allowlist to extend).
    const parsed = mappingSchema.safeParse({
      tmdbId: 550,
      mediaType: "movie",
      title: "Fight Club",
      posterPath: "/p.jpg",
      language: "pt-br",
    })
    expect(parsed.success).toBe(true)
    // Poster query validation accepts the code (bound 20 chars).
    expect(validatePosterQuery(new URLSearchParams("lang=pt-br"))).toBeNull()
  })

  it("resolves provider details to pt-BR independently of chart region", () => {
    for (const region of ["IT", "US", "BR", "PT", "GLOBAL", "MX", "ES"]) {
      expect(contentLanguageForUiLang("pt-br", region)).toBe("pt-BR")
    }
    expect(contentLanguageForUiLang("PT-BR", "IT")).toBe("pt-BR")
    expect(toProviderLanguage("pt-br")).toBe("pt-BR")
    expect(toProviderLanguage("PT-BR")).toBe("pt-BR")
    // Unrelated locales pass through untouched (legacy pt included).
    for (const untouched of ["pt", "pt-PT", "es", "es-419", "es-MX", "it-IT", "fr", "en-US"]) {
      if (untouched === "es-419") {
        expect(toProviderLanguage(untouched)).toBe("es-MX")
      } else {
        expect(toProviderLanguage(untouched)).toBe(untouched)
      }
    }
  })

  it("forwards pt-br details calls as pt-BR", async () => {
    const urls = await requestedUrls(() => getDetails("movie", 550, "pt-br", "k"))
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      expect(url).toContain("language=pt-BR")
      expect(url).not.toContain("pt-br")
    }
    const upper = await requestedUrls(() => getDetails("movie", 550, "PT-BR", "k"))
    expect(upper[0]).toContain("language=pt-BR")
  })

  it("requests images with the pt base, keeping en/null fallback", () => {
    expect(toImageLanguages("pt-br,en,null")).toBe("pt,en,null")
    expect(toImageLanguages("PT-BR,en,null")).toBe("pt,en,null")
    expect(toImageLanguages("pt,en,null")).toBe("pt,en,null")
    // Unrelated tokens stay byte-identical.
    for (const untouched of ["it,en,null", "en,null", "it-IT,en,null", "fr-FR,en,null", "es-419,en,null"]) {
      if (untouched === "es-419,en,null") {
        expect(toImageLanguages(untouched)).toBe("es,en,null")
      } else {
        expect(toImageLanguages(untouched)).toBe(untouched)
      }
    }
  })

  it("requests pt-br images over the wire with the pt base", async () => {
    const urls = await requestedUrls(() => getImages("movie", 550, "pt-br,en,null", "k"))
    expect(urls[0]).toContain("include_image_language=pt%2Cen%2Cnull")
    expect(urls[0]).not.toContain("pt-br")
  })

  it("matches logos on the pt tier for pt-br, preserving previous behavior otherwise", () => {
    const logos = [logo("pt", "/pt.png"), logo("en", "/en.png"), logo("fr", "/fr.png")]
    expect(selectBestLogo(logos, "pt-br")?.file_path).toBe("/pt.png")
    expect(selectBestLogo(logos, "PT-BR")?.file_path).toBe("/pt.png")
    expect(selectBestLogo(logos, "pt-BR")?.file_path).toBe("/pt.png")
    expect(selectLogoTier(logos, "pt-br", "en").map((l) => l.file_path)).toEqual(["/pt.png"])
    expect(logoBestLogoFallbackReason(logo("pt", "/pt.png"), "pt-br")).toBeNull()
    expect(logoBestLogoFallbackReason(logo("pt", "/pt.png"), "PT-BR")).toBeNull()
    // Legacy pt exact match is unchanged.
    expect(selectBestLogo(logos, "pt")?.file_path).toBe("/pt.png")
    expect(logoBestLogoFallbackReason(logo("pt", "/pt.png"), "pt")).toBeNull()
    // No pt tier: unchanged fallback to en, then original, then any.
    const noPt = [logo("en", "/en.png"), logo("fr", "/fr.png")]
    expect(selectBestLogo(noPt, "pt-br")?.file_path).toBe("/en.png")
    expect(selectLogoTier(noPt, "pt-br", "fr").map((l) => l.file_path)).toEqual(["/en.png"])
    expect(selectLogoTier([logo("fr", "/fr.png")], "pt-br", "fr").map((l) => l.file_path)).toEqual(["/fr.png"])
    expect(selectLogoTier([], "pt-br", "pt")).toEqual([])
  })

  it("resolves UI strings from the pt dictionary, never English-only fallback", async () => {
    expect(isDictionaryLoaded("pt-br")).toBe(true)
    const t = createT("pt-br")
    expect(t("badge.today")).toBe((ptDict as Record<string, string>)["badge.today"])
    // Loader alias: pt-br resolves through the pt chunk.
    const dict = await loadLanguage("pt-br")
    expect(dict["badge.today"]).toBe((ptDict as Record<string, string>)["badge.today"])
    // Legacy pt behavior is unchanged.
    expect(createT("pt")("badge.today")).toBe((ptDict as Record<string, string>)["badge.today"])
  })

  it("defaults a fresh pt-br user to BR while preserving explicit chart choices", () => {
    expect(defaultRegionForLang("pt-br")).toBe("BR")
    expect(defaultRegionForLang("PT-BR")).toBe("BR")
    expect(defaultRegionForLang("pt-br", "PT")).toBe("PT")
    expect(defaultRegionForLang("pt-br", "BR")).toBe("BR")
    expect(defaultRegionForLang("pt-br", "IT")).toBe("BR")
    expect(defaultRegionForLang("pt-br", "GLOBAL")).toBe("GLOBAL")
    // Historic "pt" behavior is unchanged.
    expect(defaultRegionForLang("pt")).toBe("PT")
    expect(defaultRegionForLang("pt", "BR")).toBe("BR")
    expect(defaultRegionForLang("pt", "IT")).toBe("PT")
  })

  it("preserves legacy pt provider behavior in every chart", () => {
    expect(contentLanguageForUiLang("pt", "PT")).toBe("pt-PT")
    expect(contentLanguageForUiLang("pt", "BR")).toBe("pt-BR")
    // Historic quirk (unchanged): a region code lowercases into the UI lang.
    expect(contentLanguageForUiLang("PT", "IT")).toBe("pt")
  })

  it("search language boundary: only pt-br resolves pt-BR, legacy region locale otherwise (helper + hook forwarding)", async () => {
    // Honest scope: helper + hook-forwarding regression, NOT a full context
    // integration (driving usePictorium end-to-end would need the async
    // lang/dictionary + defaults stores). The source-wiring guard at the end
    // pins the actual context.tsx expression, so this test fails if the
    // context wiring is re-broadened.
    // 1. Legacy boundary (original behavior, region locale only): the UI
    // language plays no role, so pt+US and fr+US search en-US.
    expect(getRegionDef("US").lang).toBe("en-US")
    expect(getRegionDef("BR").lang).toBe("pt-BR")
    expect(getRegionDef("GLOBAL").lang).toBe("en-US")
    // 2. pt-br override branch (the only case where context calls the
    // helper): pt-BR independently of the chart country.
    expect(contentLanguageForUiLang("pt-br", "US")).toBe("pt-BR")
    expect(contentLanguageForUiLang("pt-br", "GLOBAL")).toBe("pt-BR")
    expect(contentLanguageForUiLang("pt-br", "PT")).toBe("pt-BR")
    // Provider layer normalizes the raw UI code too (defense in depth).
    const wire = await requestedUrls(() => searchMulti("avatar", "pt-br", "k"))
    expect(wire.length).toBeGreaterThan(0)
    expect(wire[0]).toContain("language=pt-BR")
    // 3. Hook forwarding: each resolved language reaches /api/tmdb/search.
    const { act, renderHook } = await import("@testing-library/react")
    const httpMod = await import("@/lib/http")
    const { useSearch } = await import("@/lib/useSearch")
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() })
    const spy = vi.spyOn(httpMod, "http").mockResolvedValue({ results: [], total_results: 0, total_pages: 0 } as never)
    try {
      const { result } = renderHook(() => useSearch("k", "pt-BR"))
      await act(async () => { await result.current.doSearch("avatar") })
      expect(spy).toHaveBeenCalledTimes(1)
      const url = new URL(String(spy.mock.calls[0][0]), "https://x.test")
      expect(url.searchParams.get("language")).toBe("pt-BR")
      // Legacy wiring value for pt/fr + US chart: the region locale en-US.
      spy.mockClear()
      const { result: legacy } = renderHook(() => useSearch("k", "en-US"))
      await act(async () => { await legacy.current.doSearch("avatar") })
      expect(spy).toHaveBeenCalledTimes(1)
      const legacyUrl = new URL(String(spy.mock.calls[0][0]), "https://x.test")
      expect(legacyUrl.searchParams.get("language")).toBe("en-US")
    } finally {
      spy.mockRestore()
    }
    // 4. Source-wiring guard: context.tsx resolves pt-BR ONLY for pt-br and
    // keeps getRegionDef(...).lang for every other UI language.
    const ctxSrc = readFileSync(join(process.cwd(), "src", "lib", "context.tsx"), "utf8")
    expect(ctxSrc).toContain('toLowerCase() === "pt-br"')
    const ctxLines = ctxSrc.split("\n")
    const tmdbLangIdx = ctxLines.findIndex((l) => l.includes("const tmdbLang"))
    expect(tmdbLangIdx).toBeGreaterThan(-1)
    const tmdbLangWiring = ctxLines.slice(tmdbLangIdx, tmdbLangIdx + 6).join("\n")
    expect(tmdbLangWiring).toContain("pt-br")
    expect(tmdbLangWiring).toContain("getRegionDef")
    expect(ctxSrc).not.toContain("const tmdbLang = contentLanguageForUiLang(lang, editorCtx.defaultRegion)")
  })

  it("preserves the pt-br language in preview/Stremio URL builders", () => {
    const params = buildStremioPosterSearchParams({ lang: "pt-br" })
    expect(params.get("lang")).toBe("pt-br")
    const legacy = buildStremioPosterSearchParams({ lang: "pt" })
    expect(legacy.get("lang")).toBe("pt")
  })
})
