/**
 * TVDB portrait textness contract (correction cycle3).
 *
 * Real bug: `useTvdbArtworks` mapped EVERY TVDB tile to `iso_639_1: null`
 * regardless of `includesText`, so `usePosterSave.selectPoster`
 * (`iso !== null` = with-text, clears the auto logo) and `saveConfig`
 * (`isClean = iso === null`) treated with-text/unknown TVDB portraits as
 * clean and overlaid an auto logo on baked-in text. The separate display
 * meta never protected the actual select/save path.
 *
 * Contract (same as TMDB, no new save schema):
 * - ONLY `includesText === false` maps to `iso_639_1: null` (clean).
 * - With-text/unknown maps to an honest non-null flag: the raw 3-letter
 *   code passes through untouched (never an invented 2-letter mapping),
 *   unknown/neutral degrades to the "xx" sentinel. The raw code stays on
 *   the parallel display meta either way.
 * - Saved TVDB custom URLs reopen through the stored `Mapping.language`
 *   (exact-host `artworks.thetvdb.com` only); legacy-ambiguous (null) and
 *   generic custom URLs keep the historical null. No spontaneous rewrites.
 *
 * These tests drive the REAL `useTvdbArtworks` hook, the REAL
 * `usePosterSave` hook, and the REAL provider (`PictoriumRoot`) — never a
 * mocked select/save callback.
 */
import { useEffect, type ReactNode } from "react"
import { render, renderHook, act, waitFor } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PictoriumProvider, PictoriumRoot, useP } from "@/lib/context"
import type { PictoriumCtx } from "@/lib/context"
import { PosterEditorProvider } from "@/lib/contexts/PosterEditorContext"
import { ThemeProvider } from "@/lib/contexts/ThemeContext"
import { MOCK_CTX } from "@/__tests__/test-utils"
import type { SearchResult, TMDBImage, Mapping } from "@/lib/types"
import { useTvdbArtworks, __resetTvdbArtworksClientCache } from "@/lib/useTvdbArtworks"
import { usePosterSave } from "@/lib/usePosterSave"

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), message: vi.fn() }),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))

const uuidState = vi.hoisted(() => ({ value: null as string | null }))
vi.mock("@/lib/user-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/user-token")>()
  return { ...actual, currentPathUuid: () => uuidState.value }
})

// ---------- shared TVDB gallery rig (hook-level) ----------

const IMG = (p: string) => `https://artworks.thetvdb.com${p}`
const TVDB_TEXTLESS = IMG("/banners/v4/poster/textless.jpg")
const TVDB_WITH_TEXT = IMG("/banners/v4/poster/withtext.jpg")
const TVDB_UNKNOWN = IMG("/banners/v4/poster/unknown.jpg")

function galleryPayload() {
  return {
    posters: [
      { url: TVDB_TEXTLESS, thumbnail: null, language: "eng", width: 680, height: 1000, includesText: false, score: 7, source: "tvdb", type: 2 },
      { url: TVDB_WITH_TEXT, thumbnail: null, language: "eng", width: 680, height: 1000, includesText: true, score: 6, source: "tvdb", type: 2 },
      { url: TVDB_UNKNOWN, thumbnail: null, language: null, width: 680, height: 1000, score: 3, source: "tvdb", type: 2 },
    ],
    backdrops: [],
    logos: [],
    source: "tvdb",
  }
}

const okRes = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload })
const errRes = (status: number, payload: unknown) => ({ ok: false, status, json: async () => payload })

function mockTvdbFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(((url: unknown) => {
    if (String(url).includes("/api/tvdb/")) return Promise.resolve(okRes(galleryPayload()))
    return Promise.resolve(errRes(404, {}))
  }) as unknown as typeof fetch)
}

const SEL_HOOK = { id: 7, media_type: "movie", title: "Hook", poster_path: "/t.jpg" } as unknown as SearchResult
let hookSel: SearchResult | null = null
function DynWrapper({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <PosterEditorProvider>
        <PictoriumProvider value={{ ...MOCK_CTX, selected: hookSel }}>{children}</PictoriumProvider>
      </PosterEditorProvider>
    </ThemeProvider>
  )
}

// ---------- real usePosterSave deps ----------

const SAVE_SEL = { id: 7, media_type: "movie", title: "T", poster_path: "/t.jpg" } as unknown as SearchResult

function tile(filePath: string, iso: string | null): TMDBImage {
  return { file_path: filePath, iso_639_1: iso, vote_average: 0, width: 500, height: 750 }
}

function baseSaveDeps(over: Record<string, unknown> = {}) {
  return {
    selected: SAVE_SEL,
    previewPoster: null,
    selectedLogo: null,
    setSelectedLogo: () => {},
    setPreviewPoster: () => {},
    setPreviewId: () => {},
    posters: [tile("/c1.jpg", null), tile("/e1.jpg", "en")],
    metaInfo: { genres: [{ id: 18, name: "Drama" }], voteAverage: 8.2 },
    trendRank: null,
    mdblistAnimeList: [],
    mappingsMap: new Map<string, Mapping>(),
    loadMappings: async () => {},
    logoScale: 100,
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
    customRatings: false,
    ratingSources: [],
    separateRatings: false,
    separateRatingsStyle: "column",
    customBadge: null,
    badgeStyle: "shadow",
    rankingBadgeStyle: "default",
    extraBadgeStyle: null,
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
    landscapeBlur: { gradientHeight: 20, blurIntensity: 20, blurFade: 70, blurDarkness: 30, tintStrength: 20, topShade: 50, blurEnabled: true },
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
    extraBadgeScale: null,
    extraBadgeOffsetX: null,
    extraBadgeOffsetY: null,
    genreBadgeScale: 100,
    qualityBadgeScale: 100,
    separateBadgeScale: 100,
    separateBadgeOffsetX: 0,
    separateBadgeOffsetY: 0,
    networkLogoScale: 100,
    genreBadgeOffsetX: 0,
    genreBadgeOffsetY: 0,
    qualityBadgeOffsetX: 0,
    qualityBadgeOffsetY: 0,
    networkLogoOffsetX: 0,
    networkLogoOffsetY: 0,
    rotationPosters: [],
    autoRotateClean: false,
    defaultAutoRotateClean: true,
    excludedPosters: [],
    accentColor: null,
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
    networkLogo: false,
    networkLogoPosition: "auto",
    networkLogoFollowTitle: false,
    ribbonEnabled: false,
    lang: "it",
    posterShape: "poster",
    posterLayout: "standard",
    posterFreshScope: "ranked",
    ...over,
  } as never
}

function stubSaveFetch(posted: { url: string; body: Record<string, unknown> }[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: unknown) => {
    const body = (init as { body?: string })?.body
    posted.push({ url: String(url), body: body ? JSON.parse(body) : {} })
    return { ok: true, status: 200, headers: new Headers(), text: async () => "", json: async () => ({}) }
  }))
}

// ---------- real provider rig (reopen) ----------

let pctx: PictoriumCtx | null = null
function Probe() {
  const v = useP()
  useEffect(() => { pctx = v })
  return null
}

interface PendingRequest {
  resolve: (data: unknown) => void
  reject: (err: unknown) => void
}
const queues = new Map<string, PendingRequest[]>()
let mappingsPayload: unknown[] = []
const postedBodies: { url: string; method: string; body: Record<string, unknown> }[] = []

function okJson(data: unknown) {
  return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(data), json: async () => data }
}

function queueKey(url: string): string | null {
  let m = url.match(/\/api\/tmdb\/(\d+)\/details/)
  if (m) return `details:${m[1]}`
  m = url.match(/\/api\/tmdb\/(\d+)\/images/)
  if (m) return `images:${m[1]}`
  return null
}

function installProviderFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { method?: string; body?: string; signal?: AbortSignal }) => {
    const u = String(url)
    const signal = init?.signal ?? null
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
    if (u.includes("/api/mappings")) {
      if (String(init?.method ?? "GET").toUpperCase() !== "GET") {
        postedBodies.push({ url: u, method: String(init?.method ?? "?"), body: init?.body ? JSON.parse(init.body) : {} })
        return okJson({})
      }
      return okJson({ mappings: mappingsPayload })
    }
    const key = queueKey(u)
    if (key) {
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(new DOMException("Aborted", "AbortError"))
        signal?.addEventListener("abort", onAbort, { once: true })
        const q = queues.get(key) ?? []
        queues.set(key, q)
        q.push({
          resolve: (res: unknown) => { signal?.removeEventListener("abort", onAbort); resolve(res) },
          reject: (err: unknown) => { signal?.removeEventListener("abort", onAbort); reject(err) },
        })
      })
    }
    return okJson({})
  }))
}

function resolveAll(key: string, data: unknown) {
  const q = queues.get(key) ?? []
  queues.set(key, [])
  expect(q.length > 0, `expected a pending request for ${key}`).toBe(true)
  for (const p of q) p.resolve(okJson(data))
}

async function flush(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {})
  }
}

const ITEM = { id: 101, media_type: "movie", title: "Alpha", name: "Alpha", poster_path: "/t.jpg" } as unknown as SearchResult

function pimg(path: string, lang: string | null): TMDBImage {
  return { file_path: path, iso_639_1: lang, vote_average: 0, width: 500, height: 750 }
}

const IMAGES = {
  posters: [pimg("/clean-a.jpg", null), pimg("/it-a.jpg", "it")],
  logos: [pimg("/logo-a.png", "it")],
  backdrops: [pimg("/bd-a.jpg", null)],
}

function detailsFixture() {
  return {
    genres: [{ id: 18, name: "Drama" }],
    voteAverage: 8.2,
    voteCount: 120,
    status: null,
    type: null,
    release_date: "2024-03-01",
    first_air_date: null,
    last_air_date: null,
    next_episode_to_air: null,
    number_of_seasons: null,
    number_of_episodes: null,
    title: "Alpha",
    name: null,
    imdb_id: null,
    wikidata_id: null,
    networks: [],
    production_companies: [],
    original_language: "it",
    aggregatedRatings: { sources: { imdb: 8.2, tmdb: 8.2 }, average: 8.2, count: 2 },
  }
}

function tvdbMapping(over: Record<string, unknown> = {}): Mapping {
  return {
    tmdbId: 101,
    mediaType: "movie",
    title: "Alpha",
    posterPath: "/t.jpg",
    customPosterUrl: TVDB_WITH_TEXT,
    logoPath: null,
    originalPosterPath: "/t.jpg",
    language: "eng",
    updatedAt: new Date().toISOString(),
    ...over,
  } as unknown as Mapping
}

async function renderRoot() {
  pctx = null
  render(
    <PictoriumRoot>
      <Probe />
    </PictoriumRoot>,
  )
  await flush()
  expect(pctx, "provider context available").toBeTruthy()
  await flush()
}

async function openTitle() {
  await act(async () => { pctx!.setTmdbKey("test-key") })
  await act(async () => { pctx!.navigateToPoster(ITEM) })
  resolveAll("details:101", detailsFixture())
  resolveAll("images:101", IMAGES)
  await flush()
}

beforeEach(() => {
  __resetTvdbArtworksClientCache()
  uuidState.value = null
  hookSel = null
  queues.clear()
  mappingsPayload = []
  postedBodies.length = 0
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("TVDB tile textness mapping (real hook)", () => {
  it("maps ONLY includesText===false to clean; with-text/unknown stay non-clean, meta preserved, nothing filtered", async () => {
    hookSel = SEL_HOOK
    mockTvdbFetch()
    const { result } = renderHook(() => useTvdbArtworks(true, "posters"), { wrapper: DynWrapper })
    await waitFor(() => expect(result.current.status).toBe("ready"))
    // Nothing filtered: every artwork stays user-selectable.
    expect(result.current.items.map((i) => i.file_path)).toEqual([TVDB_TEXTLESS, TVDB_WITH_TEXT, TVDB_UNKNOWN])
    // Honest clean flag on the tile itself (this is what select/save read).
    expect(result.current.items[0]?.iso_639_1).toBeNull()
    expect(result.current.items[1]?.iso_639_1).toBe("eng")
    expect(result.current.items[2]?.iso_639_1).toBe("xx")
    // Raw 3-letter display meta preserved independently of the clean flag.
    expect(result.current.meta[0]).toMatchObject({ language: "eng", includesText: false })
    expect(result.current.meta[1]).toMatchObject({ language: "eng", includesText: true })
    expect(result.current.meta[2]).toMatchObject({ language: null, includesText: undefined })
  })
})

describe("TVDB portrait select/save textness (real usePosterSave)", () => {
  it("selectPoster clears the auto logo for with-text/unknown but keeps it for genuinely textless", async () => {
    const setSelectedLogo = vi.fn()
    const deps = baseSaveDeps({
      previewPoster: tile("/clean-a.jpg", null),
      selectedLogo: tile("/logo-a.png", "it"),
      setSelectedLogo,
      setPreviewPoster: vi.fn(),
      setPreviewId: vi.fn(),
      setGradientHeight: vi.fn(),
      setBlurFade: vi.fn(),
    })
    const { result } = renderHook(() => usePosterSave(deps))
    // With-text: baked-in title, the auto logo must go (same TMDB contract).
    await act(async () => { await result.current.selectPoster(tile(TVDB_WITH_TEXT, "eng")) })
    expect(setSelectedLogo).toHaveBeenCalledTimes(1)
    expect(setSelectedLogo).toHaveBeenCalledWith(null)
    // Unknown textness ("xx" sentinel): same, never overlaid.
    await act(async () => { await result.current.selectPoster(tile(TVDB_UNKNOWN, "xx")) })
    expect(setSelectedLogo).toHaveBeenCalledTimes(2)
    // Genuinely textless: the auto logo survives the switch.
    setSelectedLogo.mockClear()
    await act(async () => { await result.current.selectPoster(tile(TVDB_TEXTLESS, null)) })
    expect(setSelectedLogo).not.toHaveBeenCalled()
    // Re-clicking the already-previewed with-text tile never resets.
    const sameDeps = baseSaveDeps({
      previewPoster: tile(TVDB_WITH_TEXT, "eng"),
      selectedLogo: tile("/logo-a.png", "it"),
      setSelectedLogo,
      setPreviewPoster: vi.fn(),
      setPreviewId: vi.fn(),
      setGradientHeight: vi.fn(),
      setBlurFade: vi.fn(),
    })
    const { result: same } = renderHook(() => usePosterSave(sameDeps))
    setSelectedLogo.mockClear()
    await act(async () => { await same.current.selectPoster(tile(TVDB_WITH_TEXT, "eng")) })
    expect(setSelectedLogo).not.toHaveBeenCalled()
  })

  it("saveConfig freezes the honest language + TVDB custom URL with the TMDB fallback; with-text never seeds clean rotation", async () => {
    const posted: { url: string; body: Record<string, unknown> }[] = []
    stubSaveFetch(posted)
    const { result } = renderHook(() => usePosterSave(baseSaveDeps()))
    await act(async () => { await result.current.saveConfig({ previewPoster: tile(TVDB_TEXTLESS, null), silent: true }) })
    await act(async () => { await result.current.saveConfig({ previewPoster: tile(TVDB_WITH_TEXT, "eng"), silent: true }) })
    await act(async () => { await result.current.saveConfig({ previewPoster: tile(TVDB_UNKNOWN, "xx"), silent: true }) })
    const bodies = posted.filter((p) => p.url.includes("/api/mappings")).map((p) => p.body)
    expect(bodies).toHaveLength(3)
    // Textless: clean, seeds the clean rotation from TMDB clean tiles.
    expect(bodies[0]?.language).toBeNull()
    expect(bodies[0]?.customPosterUrl).toBe(TVDB_TEXTLESS)
    expect(bodies[0]?.posterPath).toBe("/t.jpg")
    expect(bodies[0]?.cleanPosters).toEqual(["/c1.jpg"])
    // With-text: honestly non-clean, never seeds clean rotation.
    expect(bodies[1]?.language).toBe("eng")
    expect(bodies[1]?.customPosterUrl).toBe(TVDB_WITH_TEXT)
    expect(bodies[1]?.posterPath).toBe("/t.jpg")
    expect(bodies[1]?.cleanPosters).toBeUndefined()
    // Unknown: "xx" sentinel, honestly non-clean.
    expect(bodies[2]?.language).toBe("xx")
    expect(bodies[2]?.customPosterUrl).toBe(TVDB_UNKNOWN)
    expect(bodies[2]?.cleanPosters).toBeUndefined()
  })

  it("an explicit manual logo on a with-text TVDB base persists (same TMDB contract); logoDisabled is never auto-enabled", async () => {
    const posted: { url: string; body: Record<string, unknown> }[] = []
    stubSaveFetch(posted)
    const manual = tile("/logo-a.png", "it")
    const { result } = renderHook(() => usePosterSave(baseSaveDeps({
      previewPoster: tile(TVDB_WITH_TEXT, "eng"),
      selectedLogo: manual,
    })))
    await act(async () => { await result.current.saveConfig({ silent: true }) })
    const body = posted.find((p) => p.url.includes("/api/mappings"))?.body
    expect(body?.logoPath).toBe("/logo-a.png")
    expect(body?.language).toBe("eng")
    expect(body?.logoDisabled).toBeUndefined()

    posted.length = 0
    const { result: disabled } = renderHook(() => usePosterSave(baseSaveDeps({
      previewPoster: tile(TVDB_WITH_TEXT, "eng"),
      selectedLogo: null,
      logoDisabled: true,
    })))
    await act(async () => { await disabled.current.saveConfig({ silent: true }) })
    const body2 = posted.find((p) => p.url.includes("/api/mappings"))?.body
    expect(body2?.logoPath).toBeNull()
    expect(body2?.logoDisabled).toBe(true)
  })

  it("selectLogo restages a saved TVDB base with its stored textness; legacy null and generic custom stay null", async () => {
    const staged: TMDBImage[] = []
    const withText = new Map<string, Mapping>([["movie:7", tvdbMapping({}) as Mapping]])
    const { result } = renderHook(() => usePosterSave(baseSaveDeps({
      previewPoster: null,
      mappingsMap: withText,
      setPreviewPoster: (p: TMDBImage) => { staged.push(p) },
      setPreviewId: () => {},
      setLogoScale: () => {},
      setLogoOffsetX: () => {},
      setLogoOffsetY: () => {},
    })))
    await act(async () => { await result.current.selectLogo(tile("/logo-a.png", "it")) })
    expect(staged).toHaveLength(1)
    expect(staged[0]?.file_path).toBe(TVDB_WITH_TEXT)
    expect(staged[0]?.iso_639_1).toBe("eng")

    // Legacy-ambiguous TVDB save (null language): keeps the legacy null.
    staged.length = 0
    const legacy = new Map<string, Mapping>([["movie:7", tvdbMapping({ language: null }) as Mapping]])
    const { result: legacyHook } = renderHook(() => usePosterSave(baseSaveDeps({
      previewPoster: null,
      mappingsMap: legacy,
      setPreviewPoster: (p: TMDBImage) => { staged.push(p) },
      setPreviewId: () => {},
      setLogoScale: () => {},
      setLogoOffsetX: () => {},
      setLogoOffsetY: () => {},
    })))
    await act(async () => { await legacyHook.current.selectLogo(tile("/logo-a.png", "it")) })
    expect(staged[0]?.iso_639_1).toBeNull()

    // Generic custom URL: historical null, untouched by the TVDB rule.
    staged.length = 0
    const generic = new Map<string, Mapping>([["movie:7", tvdbMapping({ customPosterUrl: "https://i.imgur.com/x.jpg", language: null }) as Mapping]])
    const { result: genericHook } = renderHook(() => usePosterSave(baseSaveDeps({
      previewPoster: null,
      mappingsMap: generic,
      setPreviewPoster: (p: TMDBImage) => { staged.push(p) },
      setPreviewId: () => {},
      setLogoScale: () => {},
      setLogoOffsetX: () => {},
      setLogoOffsetY: () => {},
    })))
    await act(async () => { await genericHook.current.selectLogo(tile("/logo-a.png", "it")) })
    expect(staged[0]?.file_path).toBe("https://i.imgur.com/x.jpg")
    expect(staged[0]?.iso_639_1).toBeNull()
  })
})

describe("TVDB saved-base reopen (real provider)", () => {
  it("with-text TVDB base reopens honestly non-clean with NO auto logo; manual logo + save persists it", async () => {
    mappingsPayload = [tvdbMapping({ customPosterUrl: TVDB_WITH_TEXT, language: "eng" })]
    installProviderFetch()
    await renderRoot()
    for (let i = 0; i < 10 && pctx!.mappings.length === 0; i++) await flush(2)
    expect(pctx!.mappings.length).toBe(1)
    await openTitle()

    expect(pctx!.previewPoster?.file_path).toBe(TVDB_WITH_TEXT)
    expect(pctx!.previewPoster?.iso_639_1).toBe("eng")
    // No auto logo over baked-in text (the cycle3 bug overlaid one here).
    expect(pctx!.selectedLogo).toBeNull()

    // ...but the user can still apply a logo manually (same TMDB contract).
    await act(async () => { await pctx!.selectLogo(pimg("/logo-a.png", "it")) })
    expect(pctx!.selectedLogo?.file_path).toBe("/logo-a.png")
    await act(async () => { await pctx!.saveConfig() })
    const post = postedBodies.find((p) => p.url.includes("/api/mappings"))
    expect(post?.body.customPosterUrl).toBe(TVDB_WITH_TEXT)
    expect(post?.body.language).toBe("eng")
    expect(post?.body.posterPath).toBe("/t.jpg")
    expect(post?.body.logoPath).toBe("/logo-a.png")
    expect(post?.body.logoDisabled).toBeUndefined()
  })

  it("textless TVDB base reopens clean WITH the auto logo", async () => {
    mappingsPayload = [tvdbMapping({ customPosterUrl: TVDB_TEXTLESS, language: null })]
    installProviderFetch()
    await renderRoot()
    for (let i = 0; i < 10 && pctx!.mappings.length === 0; i++) await flush(2)
    await openTitle()

    expect(pctx!.previewPoster?.file_path).toBe(TVDB_TEXTLESS)
    expect(pctx!.previewPoster?.iso_639_1).toBeNull()
    expect(pctx!.selectedLogo?.file_path).toBe("/logo-a.png")
  })

  it("legacy generic custom base keeps the historical behavior (null + auto logo)", async () => {
    mappingsPayload = [tvdbMapping({ customPosterUrl: "https://i.imgur.com/x.jpg", language: null })]
    installProviderFetch()
    await renderRoot()
    for (let i = 0; i < 10 && pctx!.mappings.length === 0; i++) await flush(2)
    await openTitle()

    expect(pctx!.previewPoster?.file_path).toBe("https://i.imgur.com/x.jpg")
    expect(pctx!.previewPoster?.iso_639_1).toBeNull()
    expect(pctx!.selectedLogo?.file_path).toBe("/logo-a.png")
  })

  it("unknown-textness TVDB base reopens non-clean with NO auto logo", async () => {
    mappingsPayload = [tvdbMapping({ customPosterUrl: TVDB_UNKNOWN, language: "xx" })]
    installProviderFetch()
    await renderRoot()
    for (let i = 0; i < 10 && pctx!.mappings.length === 0; i++) await flush(2)
    await openTitle()

    expect(pctx!.previewPoster?.file_path).toBe(TVDB_UNKNOWN)
    expect(pctx!.previewPoster?.iso_639_1).toBe("xx")
    expect(pctx!.selectedLogo).toBeNull()
  })
})
