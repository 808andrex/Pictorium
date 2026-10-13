/**
 * Effective-accent picker (client, header transport): BadgeControls shows the
 * hex ACTUALLY painted (server `X-Pictorium-Accent` response header of the
 * exact rendered preview image, published by the existing XHR blob load — no
 * dedicated JSON fetch) — never the legacy base — while canonical identity
 * (`accentColor`/`autoAccentColor`, `isManualAccent`, `ac=`, mapping) is
 * untouched by display state. Manual stays exact and always available.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest"
import { act, fireEvent, render, screen, waitFor, renderHook } from "@testing-library/react"
import { createElement, useState } from "react"
import { BadgeControls } from "@/components/BadgeControls"
import { PictoriumProvider } from "@/lib/context"
import { PosterEditorProvider } from "@/lib/contexts/PosterEditorContext"
import { ThemeProvider } from "@/lib/contexts/ThemeContext"
import { MOCK_CTX } from "@/__tests__/test-utils"
import { isManualAccent } from "@/lib/accent-color"
import { buildPreviewUrl } from "@/lib/poster-url"
import { usePosterSave } from "@/lib/usePosterSave"
import type { Mapping } from "@/lib/types"
import {
  __resetEffectiveAccentDisplayForTests,
  publishEffectiveAccentDisplay,
  type EffectiveAccentDisplayStatus,
} from "@/lib/effective-accent-display"
import type { EffectiveAccentMeta } from "@/lib/effective-accent"
import enDict from "@/lib/translations/en.json"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))

const EN = enDict as Record<string, string>
/** Real interpolation against the English dictionary (proves labeled hexes). */
function tEn(key: string, params?: Record<string, string | number>): string {
  let v = EN[key] ?? key
  if (params) {
    for (const [k, val] of Object.entries(params)) v = v.replaceAll(`{${k}}`, String(val))
  }
  return v
}

const SELECTED = {
  id: 1,
  media_type: "movie" as const,
  title: "T",
  name: "T",
  poster_path: "/p.jpg",
}

const PREVIEW_URL =
  "https://pictorium.test/api/poster/movie/1?rv=e6889605bb&preview=1&bs=colored&rs=default&shape=poster&ts=80&bd=30&be=1"

/** Canonical legacy base (what useRootColors sampled) — NOT the answer. */
const BASE = "#425e66"
const GENRE_HEX = "#1f7a8c"
const RANK_HEX = "#f2c14e"

const READY_META: EffectiveAccentMeta = {
  genreHex: GENRE_HEX,
  rankHex: RANK_HEX,
  genrePaints: true,
  topPaints: true,
  topType: "extra",
  provGenre: "extracted",
  provRank: "extracted",
}

function hslL(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2
}

/**
 * Windows native-picker luminance (HSL L on the 0..240 user scale — NOT
 * 0..100 percent). Correction note: the prior stage report mislabeled the
 * percent value as Windows (e.g. `#4e8087` → L42); the actual Windows value
 * is round(0.4176 * 240) ≈ 100, and `#1f7a8c` → round(0.3353 * 240) ≈ 80.
 */
function windowsLum(hex: string): number {
  return Math.round(hslL(hex) * 240)
}

function seed(obj: Record<string, unknown>) {
  localStorage.setItem("badgeDefaults", JSON.stringify(obj))
}

/**
 * Simulate the XHR header arrival: the preview image for `preview` completed
 * with THESE bytes + THIS validated header (or no header → unknown). No
 * fetch involved — this is the primary transport proof at DOM level.
 */
function publishHeader(
  preview: string,
  status: EffectiveAccentDisplayStatus,
  meta: EffectiveAccentMeta | null,
  generation = 1,
) {
  act(() => {
    publishEffectiveAccentDisplay({ status, meta, previewUrl: preview, generation })
  })
}

interface HarnessOpts {
  accent?: string | null
  auto?: string | null
  preview?: string
  onAccent?: (v: string | null) => void
}

/** Stateful harness: canonical writes flow back into context like production. */
function HarnessView({ accent = null, auto = BASE, preview = PREVIEW_URL, onAccent }: HarnessOpts) {
  const [accentColor, setAccentColorState] = useState<string | null>(accent)
  function setAccentColor(v: string | null) {
    onAccent?.(v)
    setAccentColorState(v)
  }
  const value = {
    ...MOCK_CTX,
    selected: SELECTED as never,
    metaInfo: { genres: [], voteAverage: 0, awards: [], nominations: [], studios: [], director: null, imdb_id: null },
    previewUrl: preview,
    accentColor,
    autoAccentColor: auto,
    setAccentColor,
    t: tEn as never,
    lang: "en",
  }
  return (
    <ThemeProvider>
      <PosterEditorProvider>
        <PictoriumProvider value={value}>
          <BadgeControls />
        </PictoriumProvider>
      </PosterEditorProvider>
    </ThemeProvider>
  )
}

function renderHarness(opts: HarnessOpts = {}) {
  return render(createElement(HarnessView, opts))
}

function nativePicker(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('input[type="color"]')
  expect(el).not.toBeNull()
  return el as HTMLInputElement
}

beforeEach(() => {
  localStorage.clear()
  seed({})
  __resetEffectiveAccentDisplayForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("automatic picker shows the actually-painted hex (never the base)", () => {
  it("ready distinct bands: native value = bottom hex, both zones labeled, canonical untouched", async () => {
    const writes: Array<string | null> = []
    const { container } = renderHarness({ onAccent: (v) => writes.push(v) })
    publishHeader(PREVIEW_URL, "ready", READY_META)
    await waitFor(() => expect(nativePicker(container).value).toBe(GENRE_HEX))
    // Display NEVER writes canonical: no setAccentColor call from the auto path.
    expect(writes).toEqual([])
    // Bottom zone stays labeled; top hex lives only in the picker (no text).
    expect(container.textContent).toContain(GENRE_HEX)
    expect(container.textContent).toContain(tEn("ui.accentAutoBottom", { hex: GENRE_HEX }))
    // User-approved removal: no top-zone readout in any state/label — the
    // picker carries the bottom reference, the top hex stays out of the text.
    expect(container.textContent).not.toContain(RANK_HEX)
    expect(container.textContent).not.toContain(
      tEn("ui.accentAutoTop", { zone: tEn("ui.titleInfoFamily"), hex: RANK_HEX }),
    )
    expect(container.textContent).not.toContain(
      tEn("ui.accentAutoTop", { zone: tEn("ui.rankFamily"), hex: RANK_HEX }),
    )
    expect(container.textContent).not.toContain(tEn("ui.accentAutoHint"))
    // Display value differs from the canonical base: the bug being fixed.
    expect(GENRE_HEX).not.toBe(BASE.toLowerCase())
    // Windows native dialog reads HSL L on 0..240 from the input value — the
    // effective hex carries real lightness (#1f7a8c → ≈80, not a placeholder).
    expect(windowsLum(GENRE_HEX)).toBe(80)
  })

  it("normal flow performs zero dedicated metadata requests (header transport)", async () => {
    const calls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        calls.push(String(url))
        // Anything else the providers may load stays harmless; only the
        // dedicated accent-metadata shape must never be requested.
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response
      }),
    )
    const { container } = renderHarness({})
    publishHeader(PREVIEW_URL, "ready", READY_META)
    await waitFor(() => expect(nativePicker(container).value).toBe(GENRE_HEX))
    expect(calls.filter((u) => u.includes("accentmeta=1"))).toEqual([])
  })

  it("tracks the latest published pair verbatim (no forced brightening)", async () => {
    const { container } = renderHarness({})
    publishHeader(PREVIEW_URL, "ready", READY_META, 1)
    await waitFor(() => expect(nativePicker(container).value).toBe(GENRE_HEX))
    // Same URL, newer generation, different server hex: shown exactly as sent.
    const second: EffectiveAccentMeta = {
      genreHex: "#e8c83c",
      rankHex: "#00c8dc",
      genrePaints: true,
      topPaints: true,
      topType: "extra",
      provGenre: "extracted",
      provRank: "extracted",
    }
    publishHeader(PREVIEW_URL, "ready", second, 2)
    await waitFor(() => expect(nativePicker(container).value).toBe("#e8c83c"))
    expect(container.textContent).toContain(tEn("ui.accentAutoBottom", { hex: "#e8c83c" }))
    // User-approved removal: the second top hex never renders as text either.
    expect(container.textContent).not.toContain("#00c8dc")
    expect(container.textContent).not.toContain(tEn("ui.accentAutoHint"))
  })

  it("top-only painter: picker shows the rank hex with the top label", async () => {
    const { container } = renderHarness({})
    publishHeader(PREVIEW_URL, "ready", {
      genreHex: null,
      rankHex: RANK_HEX,
      genrePaints: false,
      topPaints: true,
      topType: "rank",
      provGenre: "not-painted",
      provRank: "extracted",
    })
    await waitFor(() => expect(nativePicker(container).value).toBe(RANK_HEX))
    // User-approved removal: top-only paints into the picker with no visible
    // readout paragraph — the native value stays the actual rank hex and the
    // picker keeps the short manual-action label (never the removed hint).
    expect(container.textContent).not.toContain(RANK_HEX)
    expect(container.textContent).not.toContain(
      tEn("ui.accentAutoTop", { zone: tEn("ui.rankFamily"), hex: RANK_HEX }),
    )
    expect(container.textContent).not.toContain(
      tEn("ui.accentAutoTop", { zone: tEn("ui.titleInfoFamily"), hex: RANK_HEX }),
    )
    expect(container.textContent).not.toContain(tEn("ui.accentAutoHint"))
    expect(container.textContent).not.toContain(GENRE_HEX)
    expect(nativePicker(container).title).toBe(tEn("ui.chooseManualColor"))
  })

  it("near-anchor TheBoys hex stays legitimate (no forced brightening), Windows L ≈ 100", async () => {
    const { container } = renderHarness({})
    publishHeader(PREVIEW_URL, "ready", {
      genreHex: "#4e8087",
      rankHex: "#4e8087",
      genrePaints: true,
      topPaints: true,
      topType: "extra",
      provGenre: "extracted",
      provRank: "extracted",
    })
    await waitFor(() => expect(nativePicker(container).value).toBe("#4e8087"))
    // (78,128,135): L ≈ 0.418 ≈ legacy 5/12 anchor — legitimate, kept as-is
    // and displayed as the actual server hex (never brightened for contrast).
    expect(Math.abs(hslL("#4e8087") - 5 / 12)).toBeLessThan(0.005)
    // Windows user scale is 0..240 (not percent): round(0.4176 * 240) ≈ 100.
    expect(windowsLum("#4e8087")).toBe(100)
  })

  it("automatic display emits no ac= (real buildPreviewUrl) and persists no mapping accent", async () => {
    const { container } = renderHarness({})
    publishHeader(PREVIEW_URL, "ready", READY_META)
    await waitFor(() => expect(nativePicker(container).value).toBe(GENRE_HEX))
    // Canonical identity is still automatic: display hex ≠ canonical base.
    expect(isManualAccent(null, BASE)).toBe(false)
    const url = new URL(
      buildPreviewUrl(
        {
          selected: { id: 1, media_type: "movie", title: "T", poster_path: "/p.jpg" },
          previewPoster: { file_path: "/p.jpg", iso_639_1: "en", vote_average: 7, width: 500, height: 750 },
          selectedLogo: null,
          selectedBackdrop: null,
          logoScale: 75,
          logoScaleIsAuto: true,
          logoOffsetX: 0,
          logoOffsetY: 0,
          backdropScale: 100,
          backdropOffsetX: 0,
          backdropOffsetY: 0,
          metaInfo: { genres: [], voteAverage: 0 },
          trendRank: null,
          mdblistAnimeList: [],
          topEdgeColor: null,
          bottomEdgeColor: null,
          accentColor: null,
          autoAccentColor: BASE,
          lang: "en",
          tmdbKey: "k",
          region: "IT",
          dateFormat: "locale",
          userId: null,
        } as never,
        {
          globalBadges: true,
          rankingBadges: true,
          badgeStyle: "colored",
          rankingBadgeStyle: "default",
          extraBadgeStyle: null,
          badgeFont: "inter",
          qualityBadgeStyle: "standard",
          videoFormats: null,
          badgeGenre: true,
          badgeYear: true,
          badgeRating: true,
          badgeQuality: false,
          customRatings: false,
          ratingSources: [],
          separateRatings: false,
          separateRatingsStyle: "column",
          posterLayout: "standard",
          posterFreshScope: "ranked",
          customBadge: null,
          gradientHeight: 30,
          blurIntensity: 20,
          blurFade: 50,
          blurDarkness: 30,
          blurEnabled: true,
          tintStrength: 20,
          topShade: 80,
          networkLogo: false,
          networkLogoPosition: "auto",
          preRelease: false,
          ribbonSide: "left",
          ribbonEnabled: true,
          posterShape: "poster",
          logoAlign: "center",
          topBadgeScale: 100,
          topBadgeOffsetX: 0,
          topBadgeOffsetY: 0,
          genreBadgeScale: 100,
          qualityBadgeScale: 100,
          networkLogoScale: 100,
          genreBadgeOffsetX: 0,
          genreBadgeOffsetY: 0,
          qualityBadgeOffsetX: 0,
          qualityBadgeOffsetY: 0,
          networkLogoOffsetX: 0,
          networkLogoOffsetY: 0,
        } as never,
      ),
    )
    expect(url.searchParams.get("ac")).toBeNull()
  })

  it("fallback-genre legacy shade: shown honestly with zone label, never the adapting claim", async () => {
    const { container } = renderHarness({})
    publishHeader(PREVIEW_URL, "ready", {
      genreHex: "#8a6d3b",
      rankHex: null,
      genrePaints: true,
      topPaints: false,
      topType: null,
      provGenre: "fallback-genre",
      provRank: "not-painted",
    })
    await waitFor(() => expect(nativePicker(container).value).toBe("#8a6d3b"))
    expect(container.textContent).toContain(tEn("ui.accentAutoBottom", { hex: "#8a6d3b" }))
    // Legacy normalized shade: the adapting hint must not claim adaptation.
    expect(container.textContent).not.toContain(tEn("ui.accentAutoHint"))
  })

  it("non-painting style: honest empty state, never the base as actual", async () => {
    const { container } = renderHarness({})
    publishHeader(PREVIEW_URL, "ready", {
      genreHex: null,
      rankHex: null,
      genrePaints: false,
      topPaints: false,
      topType: null,
      provGenre: "not-painted",
      provRank: "not-painted",
    })
    await waitFor(() => expect(container.textContent).toContain(tEn("ui.accentAutoNone")))
    // Placeholder, disabled — the legacy base is nowhere claimed.
    expect(nativePicker(container).disabled).toBe(true)
    expect(nativePicker(container).value).toBe("#555555")
    expect(container.textContent).not.toContain(BASE)
  })
})

describe("manual path stays exact and always available", () => {
  it("manual mode displays the exact manual hex", async () => {
    const { container } = renderHarness({ accent: "#ff0000" })
    // A late automatic header for the same image must not overwrite manual.
    publishHeader(PREVIEW_URL, "ready", READY_META, 7)
    await act(async () => {})
    expect(nativePicker(container).value).toBe("#ff0000")
    expect(nativePicker(container).disabled).toBe(false)
    // Reset restores canonical auto/null the existing way.
    fireEvent.click(screen.getByRole("button", { name: "Reset" }))
    // After reset the title returns to automatic (header record resumes).
  })

  it("unknown auto: chooser opens the native control with no canonical write until the user picks", async () => {
    const writes: Array<string | null> = []
    const { container } = renderHarness({ onAccent: (v) => writes.push(v) })
    // Legacy cache / stripped header: honest unknown, no retry storm.
    publishHeader(PREVIEW_URL, "unknown", null)
    await waitFor(() => expect(container.textContent).toContain(tEn("ui.accentAutoUnavailable")))
    expect(nativePicker(container).disabled).toBe(true)
    // Hex field stays editable in every state.
    const hexField = container.querySelector('input[type="text"]') as HTMLInputElement
    expect(hexField).not.toBeNull()
    // Opening the chooser enables the native picker but writes NOTHING.
    fireEvent.click(screen.getByRole("button", { name: tEn("ui.chooseManualColor") }))
    expect(nativePicker(container).disabled).toBe(false)
    expect(writes).toEqual([])
    // Only the explicit user change becomes manual (saved via ac= as before).
    fireEvent.change(nativePicker(container), { target: { value: "#123abc" } })
    expect(writes).toEqual(["#123abc"])
  })

  it("manual selection during pending auto survives the late auto record", async () => {
    const writes: Array<string | null> = []
    const { container } = renderHarness({ onAccent: (v) => writes.push(v) })
    // New generation still loading (URL/nonce refetch in flight).
    publishHeader(PREVIEW_URL, "loading", null)
    await waitFor(() => expect(container.textContent).toContain(tEn("ui.accentAutoDetecting")))
    // User picks manual while the auto load is still pending.
    fireEvent.click(screen.getByRole("button", { name: tEn("ui.chooseManualColor") }))
    fireEvent.change(nativePicker(container), { target: { value: "#123abc" } })
    expect(writes).toEqual(["#123abc"])
    expect(nativePicker(container).value).toBe("#123abc")
    // Late automatic record arrives: the manual choice is NOT overwritten.
    publishHeader(PREVIEW_URL, "ready", READY_META, 2)
    await act(async () => {})
    expect(nativePicker(container).value).toBe("#123abc")
    expect(writes).toEqual(["#123abc"])
  })

  it("loading auto: picker disabled with explicit placeholder (never base-as-actual)", async () => {
    const { container } = renderHarness({})
    publishHeader(PREVIEW_URL, "loading", null)
    await waitFor(() => expect(container.textContent).toContain(tEn("ui.accentAutoDetecting")))
    expect(nativePicker(container).disabled).toBe(true)
    expect(nativePicker(container).value).toBe("#555555")
  })

  it("stale record for another URL never claims the current preview", async () => {
    const { container } = renderHarness({ preview: `${PREVIEW_URL}&ts=20` })
    publishHeader(PREVIEW_URL, "ready", READY_META)
    await waitFor(() => expect(container.textContent).toContain(tEn("ui.accentAutoDetecting")))
    expect(nativePicker(container).disabled).toBe(true)
  })

  it("automatic display persists no mapping accentColor (real usePosterSave harness)", async () => {
    const posted: { url: string; body: Record<string, unknown> }[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: unknown) => {
      const body = (init as { body?: string })?.body
      posted.push({ url: String(url), body: body ? JSON.parse(body) : {} })
      return { ok: true, status: 200, text: async () => "", json: async () => ({}) }
    }))
    // Same canonical identity the picker shows above: automatic base, the
    // effective display hex (#1f7a8c) nowhere in canonical state.
    const deps = {
      selected: { id: 1, media_type: "movie", title: "T", poster_path: "/p.jpg" },
      previewPoster: { file_path: "/p.jpg", iso_639_1: null, vote_average: 0, width: 500, height: 750 },
      selectedLogo: null,
      setSelectedLogo: () => {},
      setPreviewPoster: () => {},
      setPreviewId: () => {},
      posters: [],
      metaInfo: { genres: [{ id: 1, name: "Dramma" }], voteAverage: 7.5 },
      trendRank: null,
      mdblistAnimeList: [],
      mappingsMap: new Map<string, Mapping>(),
      loadMappings: async () => {},
      logoScale: 75,
      logoOffsetX: 0,
      logoOffsetY: 0,
      selectedBackdrop: null,
      setSelectedBackdrop: () => {},
      backdropScale: 100,
      backdropOffsetX: 0,
      backdropOffsetY: 0,
      setBackdropScale: () => {},
      setBackdropOffsetX: () => {},
      setBackdropOffsetY: () => {},
      globalBadges: true,
      rankingBadges: true,
      badgeGenre: true,
      badgeYear: true,
      badgeRating: true,
      badgeQuality: true,
      customRatings: true,
      ratingSources: ["imdb", "tmdb"],
      separateRatings: false,
      separateRatingsStyle: "column",
      customBadge: null,
      badgeStyle: "shadow",
      rankingBadgeStyle: "pill",
      extraBadgeStyle: "corner",
      badgeFont: "inter",
      qualityBadgeStyle: "standard",
      videoFormats: null,
      defaultBadgeStyle: "shadow",
      defaultRankingBadgeStyle: "default",
      defaultExtraBadgeStyle: null,
      blurEnabled: true,
      blurIntensity: 20,
      blurFade: 50,
      blurDarkness: 30,
      landscapeBlur: {
        gradientHeight: 30, blurIntensity: 20, blurFade: 70,
        blurDarkness: 30, tintStrength: 20, topShade: 50, blurEnabled: true,
      },
      landscapeBlurDirty: false,
      setLandscapeBlur: () => {},
      defaultLogoScale: null,
      defaultLogoOffsetX: null,
      defaultLogoOffsetY: null,
      landscapeDefaults: null,
      tintStrength: 20,
      topShade: 50,
      gradientHeight: 30,
      setGradientHeight: () => {},
      setBlurFade: () => {},
      topBadgeScale: 100,
      topBadgeOffsetX: 0,
      topBadgeOffsetY: 0,
      genreBadgeScale: 100,
      qualityBadgeScale: 100,
      separateBadgeScale: 130,
      networkLogoScale: 100,
      genreBadgeOffsetX: 0,
      genreBadgeOffsetY: 0,
      qualityBadgeOffsetX: 0,
      qualityBadgeOffsetY: 0,
      networkLogoOffsetX: 0,
      networkLogoOffsetY: 0,
      rotationPosters: [],
      autoRotateClean: false,
      defaultAutoRotateClean: false,
      excludedPosters: [],
      accentColor: null,
      autoAccentColor: BASE,
      logoDisabled: false,
      setLogoDisabled: () => {},
      setLogoScale: () => {},
      setLogoOffsetX: () => {},
      setLogoOffsetY: () => {},
      rotationBackdrops: [],
      autoRotateBackdrop: false,
      defaultAutoRotateBackdrop: false,
      excludedBackdrops: [],
      backdrops: [],
      networkLogo: true,
      networkLogoPosition: "auto",
      networkLogoFollowTitle: true,
      ribbonEnabled: true,
      lang: "it",
      posterShape: "poster",
      posterLayout: "standard",
      posterFreshScope: "ranked",
    } as never
    const { result } = renderHook(() => usePosterSave(deps))
    let ok = false
    await act(async () => {
      ok = (await result.current.saveConfig({ silent: true })) === true
    })
    expect(ok).toBe(true)
    const mappings = posted.filter((p) => String(p.url).includes("/api/mappings"))
    expect(mappings).toHaveLength(1)
    // The effective display hex is display-only: nothing manual persisted.
    expect(mappings[0]!.body.accentColor).toBeUndefined()
  })
})
