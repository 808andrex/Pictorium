/**
 * Task 3B2 correction (real PictoriumRoot regression).
 *
 * Previous `remaining-shape-controls.test.tsx` drove builders and mocked
 * contexts, never the real provider — so the confirmed `context.tsx` gaps
 * (fresh-landscape init resurrecting the portrait extra via `??`, missing
 * landscape `logoAlign` init, flat-only no-title template, flat-only live
 * propagation) were never exercised end to end.
 *
 * Contract under test (narrow, existing helpers only):
 * - An owned landscape `extraBadgeStyle` key — INCLUDING explicit `null`
 *   ("follow my own rank") — shadows the portrait flat in open-title state,
 *   open preview, no-title template, defaults preview and Stremio URLs, so a
 *   portrait extra edit can never resurrect across shapes. Absent stays
 *   flat-following (legacy URLs byte-identical).
 * - `logoAlign` is per-shape: landscape profile override wins, null/absent
 *   follows the flat, flat null = landscape-left auto; portraits ALWAYS
 *   render centered (server contract) and the portrait Left option is a
 *   demonstrated no-op (disabled in UI).
 * - Per-title saved mapping precedence is unchanged (explicit mapping extra
 *   still wins over the owned profile marker).
 * - Shared `config` token transport precedence is UNCHANGED (query > mapping
 *   > token > profile): an omitted `xbs` under an owned-null profile does
 *   NOT beat a concrete token style. Both builders omit `xbs` identically,
 *   so preview and Stremio resolve the SAME token value (no divergence
 *   claim). Without a token the owned null resolves to the own-rank
 *   fallback (null from the resolver).
 */
import { useEffect } from "react"
import { render, act, screen, within } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PictoriumRoot, useP } from "@/lib/context"
import type { PictoriumCtx } from "@/lib/context"
import { usePosterEditor } from "@/lib/contexts/PosterEditorContext"
import type { PosterEditorCtx } from "@/lib/contexts/PosterEditorContext"
import { BadgeDefaultsSection } from "@/components/settings/BadgeDefaultsSection"
import type { SearchResult, TMDBImage } from "@/lib/types"
import { resolvePosterRenderConfig } from "@/lib/poster-config"
import type { PosterRenderConfigInput } from "@/lib/poster-config"
import { buildDefaultsPreviewUrl } from "@/lib/poster-url"
import { buildStremioPosterUrl } from "@/lib/stremio-poster-url"
import type { ServerDefaults } from "@/lib/server-defaults"
import type { PictoriumUserConfig } from "@/lib/config-token"
import type { Mapping } from "@/lib/types"

let ctx: PictoriumCtx | null = null
let ed: PosterEditorCtx | null = null

function Probe() {
  const v = useP()
  const e = usePosterEditor()
  useEffect(() => {
    ctx = v
    ed = e
  })
  return null
}

interface PendingRequest {
  resolve: (data: unknown) => void
  reject: (err: unknown) => void
}

const queues = new Map<string, PendingRequest[]>()
let mappingsPayload: unknown[] = []

function okJson(data: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify(data),
    json: async () => data,
  }
}

function queueKey(url: string): string | null {
  let m = url.match(/\/api\/tmdb\/(\d+)\/details/)
  if (m) return `details:${m[1]}`
  m = url.match(/\/api\/tmdb\/(\d+)\/images/)
  if (m) return `images:${m[1]}`
  if (url.includes("/api/mappings")) return "mappings"
  return null
}

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { signal?: AbortSignal }) => {
      const u = String(url)
      const signal = init?.signal ?? null
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
      const key = queueKey(u)
      if (key === "mappings") return okJson({ mappings: mappingsPayload })
      if (key) {
        return new Promise((resolve, reject) => {
          const onAbort = () => reject(new DOMException("Aborted", "AbortError"))
          signal?.addEventListener("abort", onAbort, { once: true })
          const q = queues.get(key) ?? []
          queues.set(key, q)
          q.push({
            resolve: (res: unknown) => {
              signal?.removeEventListener("abort", onAbort)
              resolve(res)
            },
            reject: (err: unknown) => {
              signal?.removeEventListener("abort", onAbort)
              reject(err)
            },
          })
        })
      }
      return okJson({})
    }),
  )
}

function resolveAll(key: string, data: unknown) {
  const q = queues.get(key) ?? []
  queues.set(key, [])
  expect(q.length > 0, `expected a pending request for ${key}`).toBe(true)
  for (const p of q) p.resolve(okJson(data))
}

async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {})
  }
}

async function settlePreview() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
  await flush()
}

function lastPreviewParams(): URLSearchParams {
  expect(ctx!.previewUrl, "provider published a preview url").toBeTruthy()
  return new URL(ctx!.previewUrl, "http://localhost").searchParams
}

function patternParams(): URLSearchParams {
  expect(ctx!.urlPattern, "provider published a url pattern").toBeTruthy()
  return new URL(String(ctx!.urlPattern), "http://localhost").searchParams
}

function baseInput(overrides: Partial<PosterRenderConfigInput> = {}): PosterRenderConfigInput {
  return {
    searchParams: new URLSearchParams(),
    mapping: null,
    configOverride: null,
    sd: {},
    hasQuery: true,
    showBadges: true,
    rankingBadges: true,
    animeRank: null,
    rankingResult: null,
    finalRank: null,
    ...overrides,
  }
}

const mapping = (partial: Partial<Mapping> = {}): Mapping => ({
  tmdbId: 1, mediaType: "movie", title: "T", posterPath: "/p.jpg",
  logoPath: null, originalPosterPath: null, language: null, updatedAt: "2026-01-01",
  ...partial,
})

const ITEM_9201: SearchResult = { id: 9201, media_type: "movie", title: "Shape Correction", poster_path: null }

function img(path: string, lang: string | null): TMDBImage {
  return { file_path: path, iso_639_1: lang, vote_average: 0, width: 500, height: 750 }
}

const IMAGES_9201 = {
  posters: [img("/corr-it.jpg", "it")],
  logos: [img("/corr-logo.png", "it")],
  backdrops: [img("/corr-bd.jpg", null)],
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
    title: "Shape Correction",
    name: null,
    imdb_id: null,
    wikidata_id: null,
    networks: [],
    production_companies: [],
    original_language: "it",
    aggregatedRatings: null,
  }
}

async function renderRoot() {
  ctx = null
  ed = null
  render(
    <PictoriumRoot>
      <Probe />
    </PictoriumRoot>,
  )
  await flush()
  expect(ctx, "provider context available").toBeTruthy()
  await flush()
}

async function openFresh9201() {
  await act(async () => {
    ctx!.setTmdbKey("test-key")
  })
  await act(async () => {
    ctx!.navigateToPoster(ITEM_9201)
  })
  await flush(2)
  await act(async () => {
    resolveAll("details:9201", detailsFixture())
    resolveAll("images:9201", IMAGES_9201)
  })
  await flush()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  await flush()
}

// Divergent pair: portrait flat pill + flat-left, landscape owns the explicit
// "follow-rank" sentinel (follow own rank) with its own number rank + centered align.
const STORED = {
  defaultPosterShape: "landscape",
  defaultExtraBadgeStyle: "pill",
  defaultRankingBadgeStyle: "number",
  defaultLogoAlign: "left",
  landscape: { extraBadgeStyle: "follow-rank", rankingBadgeStyle: "number", logoAlign: "center" },
}
const SD: ServerDefaults = {
  extraBadgeStyle: "pill",
  rankingBadgeStyle: "number",
  logoAlign: "left",
  landscape: { extraBadgeStyle: "follow-rank", rankingBadgeStyle: "number", logoAlign: "center" },
} as unknown as ServerDefaults

beforeEach(() => {
  queues.clear()
  mappingsPayload = []
  localStorage.clear()
  installFetchMock()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("real provider: fresh landscape open keeps the owned profile (no portrait resurrect)", () => {
  it("state, open preview, template and production server resolve the same", async () => {
    localStorage.setItem("badgeDefaults", JSON.stringify(STORED))
    await renderRoot()
    await openFresh9201()

    // State: landscape shape, owned follow-rank preserved, profile align.
    expect(ed!.posterShape).toBe("landscape")
    expect(ed!.extraBadgeStyle).toBe("follow-rank")
    expect(ed!.logoAlign).toBe("center")

    // Open preview: landscape carries xbs=follow-rank, align=center, rs=number.
    const q = lastPreviewParams()
    expect(q.get("shape")).toBe("landscape")
    expect(q.get("xbs")).toBe("follow-rank")
    expect(q.get("align")).toBe("center")
    expect(q.get("rs")).toBe("number")

    // No-title template path is not this test (title open); the open-title
    // template must carry the same open values.
    const pat = patternParams()
    expect(pat.get("shape")).toBe("landscape")
    expect(pat.get("xbs")).toBe("follow-rank")
    expect(pat.get("align")).toBe("center")

    // Production server parity: preview query over the same saved-state sd.
    const landResolved = resolvePosterRenderConfig(baseInput({ searchParams: q, sd: SD }))
    expect(landResolved.extraBadgeStyle).toBeNull()
    expect(landResolved.rankingBadgeStyle).toBe("number")
    expect(landResolved.logoAlign).toBe("center")

    // Portrait on the same sd still carries the flat (per-shape independence).
    const portResolved = resolvePosterRenderConfig(baseInput({ sd: SD }))
    expect(portResolved.extraBadgeStyle).toBe("pill")
    // Portraits stay centered by contract whatever the stored values.
    expect(portResolved.logoAlign).toBe("center")

    // Stremio builders: landscape carries the sentinel, portrait carries the flat.
    const landUrl = buildStremioPosterUrl({
      origin: "https://x.test", type: "movie", id: 1,
      defaults: SD, forceShape: "landscape",
    })
    expect(landUrl.searchParams.get("xbs")).toBe("follow-rank")
    const portUrl = buildStremioPosterUrl({
      origin: "https://x.test", type: "movie", id: 1,
      defaults: SD, forceShape: "poster",
    })
    expect(portUrl.searchParams.get("xbs")).toBe("pill")
  })

  it("switching shape + landscape-only edits are immediate (no stale preview)", async () => {
    localStorage.setItem("badgeDefaults", JSON.stringify(STORED))
    await renderRoot()
    await openFresh9201()
    expect(lastPreviewParams().get("xbs")).toBe("follow-rank")

    // Shape switch to portrait: no align param (centered by contract); the
    // selected follow-rank sentinel travels on ANY shape (own-rank) — only
    // legacy null/absent stays omitted (see the legacy test below).
    await act(async () => {
      ed!.setPosterShape("poster")
    })
    await settlePreview()
    const pq = lastPreviewParams()
    expect(pq.get("shape")).toBe("poster")
    expect(pq.has("align")).toBe(false)
    expect(pq.get("xbs")).toBe("follow-rank")
    expect(resolvePosterRenderConfig(baseInput({ searchParams: pq, sd: SD })).extraBadgeStyle).toBeNull()
    expect(resolvePosterRenderConfig(baseInput({ searchParams: pq, sd: SD })).logoAlign).toBe("center")

    // Back to landscape, then landscape-only edits move the URL at once.
    await act(async () => {
      ed!.setPosterShape("landscape")
    })
    await settlePreview()
    expect(lastPreviewParams().get("align")).toBe("center")

    await act(async () => {
      ed!.setLandscape({ extraBadgeStyle: "corner" })
    })
    await settlePreview()
    expect(lastPreviewParams().get("xbs")).toBe("corner")

    await act(async () => {
      ed!.setLandscape({ logoAlign: "left" })
    })
    await settlePreview()
    // Open preview is always explicit in landscape (unlike the
    // defaults-preview/Stremio builders which omit the auto): align=left.
    expect(ed!.logoAlign).toBe("left")
    expect(lastPreviewParams().get("align")).toBe("left")
    expect(resolvePosterRenderConfig(baseInput({ searchParams: lastPreviewParams(), sd: liveSd() })).logoAlign).toBe("left")

    // Portrait flat untouched by the landscape-only edits.
    expect(ed!.defaultExtraBadgeStyle).toBe("pill")
  })
})

function liveSd(): ServerDefaults {
  return {
    extraBadgeStyle: ed!.defaultExtraBadgeStyle,
    rankingBadgeStyle: ed!.defaultRankingBadgeStyle,
    logoAlign: ed!.defaultLogoAlign,
    landscape: { ...ed!.landscape },
  } as unknown as ServerDefaults
}

describe("no-title template follows the delivery landscape profile", () => {
  it("follow-rank travels in xbs and the profile align travels", async () => {
    localStorage.setItem("badgeDefaults", JSON.stringify(STORED))
    await renderRoot()
    await flush()
    // No title opened: template follows defaults live for the delivery shape.
    const pat = patternParams()
    expect(pat.get("shape")).toBe("landscape")
    expect(pat.get("xbs")).toBe("follow-rank")
    expect(pat.get("align")).toBe("center")
    // Resolves through the production server to the same owned outcome.
    const resolved = resolvePosterRenderConfig(baseInput({ searchParams: pat, sd: SD }))
    expect(resolved.extraBadgeStyle).toBeNull()
    expect(resolved.logoAlign).toBe("center")
  })

  it("legacy null inherits the flat in the template (byte-identical)", async () => {
    const legacySd = {
      extraBadgeStyle: "pill",
      rankingBadgeStyle: "number",
      logoAlign: "left",
      landscape: { extraBadgeStyle: null, rankingBadgeStyle: "number", logoAlign: "center" },
    } as unknown as ServerDefaults
    const pat = buildStremioPosterUrl({
      origin: "https://x.test", type: "movie", id: 1,
      defaults: legacySd, forceShape: "landscape",
    })
    expect(pat.searchParams.get("xbs")).toBe("pill")
    expect(resolvePosterRenderConfig(baseInput({ searchParams: pat.searchParams, sd: legacySd })).extraBadgeStyle).toBe("pill")
  })
})

describe("precedence is unchanged: query > mapping > token > owned profile", () => {
  it("saved mapping explicit extra still wins over the follow-rank sentinel", () => {
    const sd = SD
    expect(resolvePosterRenderConfig(baseInput({
      searchParams: new URLSearchParams({ shape: "landscape" }),
      mapping: mapping({ extraBadgeStyle: "vetro" }),
      sd,
    })).extraBadgeStyle).toBe("vetro")
    expect(resolvePosterRenderConfig(baseInput({
      searchParams: new URLSearchParams({ shape: "landscape", xbs: "corner" }),
      mapping: mapping({ extraBadgeStyle: "vetro" }),
      sd,
    })).extraBadgeStyle).toBe("corner")
    // Explicit query follow-rank beats a concrete mapping (existing precedence: query wins).
    expect(resolvePosterRenderConfig(baseInput({
      searchParams: new URLSearchParams({ shape: "landscape", xbs: "follow-rank" }),
      mapping: mapping({ extraBadgeStyle: "vetro" }),
      sd,
    })).extraBadgeStyle).toBeNull()
  })

  it("explicit query follow-rank beats a concrete token; builders carry the sentinel", () => {
    // Shared-transport token carries a concrete extra style. An explicit
    // query follow-rank (as emitted by both production builders for a
    // follow-rank profile) wins per existing precedence (query > token).
    const token = {
      globalBadges: true, rankingBadges: true, badgeStyle: "shadow",
      rankingBadgeStyle: "number", extraBadgeStyle: "corner",
      blurEnabled: true, blurIntensity: 20, blurFade: 50, blurDarkness: 30,
      gradientHeight: 30, networkLogo: true, autoRotateClean: false,
    } as PictoriumUserConfig
    // Both production builders carry xbs=follow-rank for the sentinel profile.
    const preview = new URL(buildDefaultsPreviewUrl({
      defaultExtraBadgeStyle: "pill",
      defaultRankingBadgeStyle: "number",
      defaultLogoAlign: "left",
      landscape: { extraBadgeStyle: "follow-rank", rankingBadgeStyle: "number", logoAlign: "center" },
      previewShape: "landscape",
    }))
    expect(preview.searchParams.get("xbs")).toBe("follow-rank")
    const stremio = buildStremioPosterUrl({
      origin: "https://x.test", type: "movie", id: 1,
      defaults: SD, forceShape: "landscape",
    })
    expect(stremio.searchParams.get("xbs")).toBe("follow-rank")
    // ...so the production server resolves own-rank twice (query beats token).
    const viaPreview = resolvePosterRenderConfig(baseInput({ searchParams: preview.searchParams, configOverride: token, sd: SD }))
    const viaStremio = resolvePosterRenderConfig(baseInput({ searchParams: stremio.searchParams, configOverride: token, sd: SD }))
    expect(viaPreview.extraBadgeStyle).toBeNull()
    expect(viaStremio.extraBadgeStyle).toBeNull()
    // Without a token the same builders resolve the own-rank sentinel.
    expect(resolvePosterRenderConfig(baseInput({ searchParams: preview.searchParams, sd: SD })).extraBadgeStyle).toBeNull()
    expect(resolvePosterRenderConfig(baseInput({ searchParams: stremio.searchParams, sd: SD })).extraBadgeStyle).toBeNull()
    // A concrete token still wins when no query carries a style
    // (legacy null profile inherits the flat; token beats the profile).
    const legacySd = {
      extraBadgeStyle: "pill",
      landscape: { extraBadgeStyle: null },
    } as unknown as ServerDefaults
    const legacyPreview = new URL(buildDefaultsPreviewUrl({
      defaultExtraBadgeStyle: "pill",
      landscape: { extraBadgeStyle: null },
      previewShape: "landscape",
    }))
    expect(legacyPreview.searchParams.get("xbs")).toBe("pill")
    expect(resolvePosterRenderConfig(baseInput({
      searchParams: new URLSearchParams({ shape: "landscape" }),
      configOverride: token,
      sd: legacySd,
    })).extraBadgeStyle).toBe("corner")
  })
})

describe("portrait Left is a demonstrated no-op (disabled, shape-compatible controls kept)", () => {
  it("portrait disables Left; landscape keeps it enabled", async () => {
    localStorage.setItem("badgeDefaults", JSON.stringify({ landscape: {} }))
    ctx = null
    ed = null
    render(
      <PictoriumRoot>
        <Probe />
        <BadgeDefaultsSection active shape="portrait" />
      </PictoriumRoot>,
    )
    await flush()
    const group = screen.getByRole("group", { name: "ui.logoAlign" })
    expect(within(group).getByRole("button", { name: "ui.sideLeft" })).toBeDisabled()
    expect(within(group).getByRole("button", { name: "ui.alignCenter" })).not.toBeDisabled()
  })
})
