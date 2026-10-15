/**
 * Pre-digital (Coming Soon) live reactivity.
 *
 * Regression: toggling the pre-digital default OFF updated the staged/saved
 * URL builders (explicit `pre=0`) but the open-title editor preview kept the
 * Coming Soon band until a browser refresh — unlike every sibling badge
 * toggle, which propagates live. Root cause: the default→live propagation
 * whitelist in `src/lib/context.tsx` (snapshot + per-key dispatch) covered
 * ribbon/badges/ranking/… but never `preRelease`, so the per-title live flag
 * (which feeds the editor `pre=` param) never followed the default.
 *
 * - Provider part (PictoriumRoot, real context): fresh unmapped title open,
 *   outer default toggle → per-title flag + outgoing `previewUrl` flip
 *   pre=1↔pre=0 in the same render cycle (debounce only), no reload, both
 *   directions, portrait flat + landscape `land ?? flat` precedence.
 * - Staged part (real settings session): the five-tab Settings draft
 *   (useSettingsSession + PosterEditorValueOverride) — toggle → staged
 *   DefaultsPosterPreview XHR URL flips with no save and no PUT.
 */
import { useEffect } from "react"
import { render, act, fireEvent, screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PictoriumRoot, useP } from "@/lib/context"
import type { PictoriumCtx } from "@/lib/context"
import { usePosterEditor, PosterEditorValueOverride } from "@/lib/contexts/PosterEditorContext"
import type { PosterEditorCtx } from "@/lib/contexts/PosterEditorContext"
import { useSettingsSession } from "@/components/settings/useSettingsSession"
import { BadgeDefaultsSection } from "@/components/settings/BadgeDefaultsSection"
import { DefaultsPosterPreview } from "@/components/settings/DefaultsPosterPreview"
import { renderWithCtx } from "@/__tests__/test-utils"
import type { SearchResult, TMDBImage } from "@/lib/types"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ITEM_9001: SearchResult = { id: 9001, media_type: "movie", title: "Fresh Land", poster_path: null }

function img(path: string, lang: string | null): TMDBImage {
  return { file_path: path, iso_639_1: lang, vote_average: 0, width: 500, height: 750 }
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
    title: "Fresh Land",
    name: null,
    imdb_id: null,
    wikidata_id: null,
    networks: [],
    production_companies: [],
    original_language: "it",
    aggregatedRatings: null,
  }
}

const IMAGES_9001 = {
  posters: [img("/fresh-it.jpg", "it")],
  logos: [img("/fresh-logo.png", "it")],
  backdrops: [img("/fresh-bd.jpg", null)],
}

// ---------------------------------------------------------------------------
// Part 1: provider default→live propagation (PictoriumRoot, deferred network)
// ---------------------------------------------------------------------------

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

const calls: string[] = []
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
      calls.push(u)
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

function lastPreviewParams(): URLSearchParams {
  expect(ctx!.previewUrl, "provider published a preview url").toBeTruthy()
  return new URL(ctx!.previewUrl, "http://localhost").searchParams
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

async function openFresh9001() {
  await act(async () => {
    ctx!.setTmdbKey("test-key")
  })
  await act(async () => {
    ctx!.navigateToPoster(ITEM_9001)
  })
  await flush(2)
  await act(async () => {
    resolveAll("details:9001", detailsFixture())
    resolveAll("images:9001", IMAGES_9001)
  })
  await flush()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  await flush()
}

/** Default change → propagation (no deps array) → 200ms preview debounce. */
async function settlePreview() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400)
  })
  await flush()
}

// ---------------------------------------------------------------------------
// Part 2: staged settings session (FakeXHR transport capture)
// ---------------------------------------------------------------------------

class FakeXHR {
  static opened: string[] = []
  onload: (() => void) | null = null
  responseType = ""
  timeout = 0
  status = 0
  response: unknown = null
  open(_method: string, url: string) {
    FakeXHR.opened.push(String(url))
  }
  send() {}
  abort() {}
  setRequestHeader() {}
}

function lastStagedPreviewParams(): URLSearchParams {
  expect(FakeXHR.opened.length, "staged preview requested a poster").toBeGreaterThan(0)
  return new URL(FakeXHR.opened[FakeXHR.opened.length - 1], "http://localhost").searchParams
}

function StagedHarness({ shape }: { shape: "portrait" | "landscape" }) {
  const session = useSettingsSession()
  return (
    <PosterEditorValueOverride value={session.value}>
      <BadgeDefaultsSection
        active
        shape={shape}
        mode="information"
        presetsEnabled={false}
      />
      <DefaultsPosterPreview previewShape={shape} />
    </PosterEditorValueOverride>
  )
}

async function renderStaged(shape: "portrait" | "landscape") {
  renderWithCtx(<StagedHarness shape={shape} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
}

function preReleaseSwitch(): HTMLElement {
  return screen.getByRole("switch", { name: "ui.preRelease" })
}

beforeEach(() => {
  calls.length = 0
  queues.clear()
  mappingsPayload = []
  FakeXHR.opened = []
  localStorage.clear()
  installFetchMock()
  vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("pre-digital live reactivity (provider default→live)", () => {
  it("portrait default toggle follows live OFF and back ON with no reload", async () => {
    localStorage.setItem("badgeDefaults", JSON.stringify({ defaultPreRelease: true }))
    await renderRoot()
    await openFresh9001()

    // Saved-ON baseline: the open title follows the default, preview explicit.
    expect(ed!.defaultPreRelease).toBe(true)
    expect(ed!.preRelease).toBe(true)
    expect(lastPreviewParams().get("pre")).toBe("1")

    // The reactivity defect: default OFF must move the live flag + preview
    // in the same cycle (other badge toggles do via the propagation effect).
    await act(async () => {
      ed!.setDefaultPreRelease(false)
    })
    await settlePreview()
    expect(ed!.defaultPreRelease).toBe(false)
    expect(ed!.preRelease).toBe(false)
    expect(lastPreviewParams().get("pre")).toBe("0")

    // …and back ON, same immediacy.
    await act(async () => {
      ed!.setDefaultPreRelease(true)
    })
    await settlePreview()
    expect(ed!.preRelease).toBe(true)
    expect(lastPreviewParams().get("pre")).toBe("1")
  })

  it("sibling ribbon toggle already propagates (compare pattern)", async () => {
    localStorage.setItem(
      "badgeDefaults",
      JSON.stringify({ defaultPreRelease: true, defaultRibbonEnabled: true }),
    )
    await renderRoot()
    await openFresh9001()
    expect(ed!.ribbonEnabled).toBe(true)

    await act(async () => {
      ed!.setDefaultRibbonEnabled(false)
    })
    await settlePreview()
    expect(ed!.ribbonEnabled).toBe(false)
    expect(lastPreviewParams().get("ribbon")).toBe("0")
  })

  it("landscape follows the effective profile (land ?? flat)", async () => {
    localStorage.setItem(
      "badgeDefaults",
      JSON.stringify({
        defaultPosterShape: "landscape",
        defaultPreRelease: false,
        landscape: { preRelease: true },
      }),
    )
    await renderRoot()
    await openFresh9001()

    // Open follows the owned profile, not the flat.
    expect(ed!.posterShape).toBe("landscape")
    expect(ed!.preRelease).toBe(true)
    expect(lastPreviewParams().get("pre")).toBe("1")

    // Flat ON under an owned profile: effective stays ON (no cross-shape leak).
    await act(async () => {
      ed!.setDefaultPreRelease(true)
    })
    await settlePreview()
    expect(ed!.preRelease).toBe(true)
    expect(lastPreviewParams().get("pre")).toBe("1")

    // Profile OFF: the open landscape title follows immediately.
    await act(async () => {
      ed!.setLandscape({ preRelease: false })
    })
    await settlePreview()
    expect(ed!.preRelease).toBe(false)
    expect(lastPreviewParams().get("pre")).toBe("0")

    // Absent-profile follow: flat OFF keeps OFF (flat now effective).
    await act(async () => {
      ed!.setDefaultPreRelease(false)
    })
    await settlePreview()
    expect(ed!.preRelease).toBe(false)
    expect(lastPreviewParams().get("pre")).toBe("0")
  })
})

describe("pre-digital staged reactivity (settings draft, no save)", () => {
  it("portrait staged toggle flips the draft preview with no PUT", async () => {
    localStorage.setItem("badgeDefaults", JSON.stringify({ defaultPreRelease: true }))
    await renderStaged("portrait")
    expect(lastStagedPreviewParams().get("pre")).toBe("1")

    // Dirty preview only: clear transports, then toggle — no save involved.
    FakeXHR.opened = []
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockClear()
    fireEvent.click(preReleaseSwitch())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(lastStagedPreviewParams().get("pre")).toBe("0")
    const puts = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/api/defaults") &&
        (init as { method?: string } | undefined)?.method === "PUT",
    )
    expect(puts).toHaveLength(0)

    fireEvent.click(preReleaseSwitch())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(lastStagedPreviewParams().get("pre")).toBe("1")
  })

  it("landscape staged toggle follows the profile override", async () => {
    localStorage.setItem(
      "badgeDefaults",
      JSON.stringify({ defaultPreRelease: false, landscape: { preRelease: true } }),
    )
    await renderStaged("landscape")
    expect(lastStagedPreviewParams().get("pre")).toBe("1")

    fireEvent.click(preReleaseSwitch())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(lastStagedPreviewParams().get("pre")).toBe("0")
  })
})
