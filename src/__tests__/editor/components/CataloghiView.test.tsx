import { beforeEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { CataloghiView } from "@/components/CataloghiView"
import { MOCK_CTX, renderWithCtx } from "@/__tests__/test-utils"
import { PictoriumProvider } from "@/lib/context"
import { PosterEditorProvider } from "@/lib/contexts/PosterEditorContext"
import { ThemeProvider } from "@/lib/contexts/ThemeContext"
import { userFetch } from "@/lib/http"

vi.mock("@/lib/http", () => ({ userFetch: vi.fn() }))
vi.mock("@/lib/contexts/TranslationContext", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/contexts/TranslationContext")>(),
  useT: () => ({ t: (key: string) => key }),
}))
vi.mock("@/components/CustomCatalogModal", () => ({ CustomCatalogModal: () => null }))
vi.mock("@/components/CatalogManagerModal", () => ({ CatalogManagerModal: () => null }))
// The source picker itself owns identical "ui.movie — Top 20" labels: mock it
// away so row-title queries below can only match the JustWatch pair rows.
vi.mock("@/components/RankingSourceSection", () => ({ RankingSourceSection: () => null }))

const cat = { id: "audit", name: "Audit list", type: "mixed" as const, url: "https://mdblist.com/lists/audit/list" }
const movie = { id: 1, media_type: "movie", title: "Preview movie", poster_path: "/movie.jpg" }
const tv = { id: 2, media_type: "tv", title: "Full series", poster_path: "/tv.jpg" }
const response = (items: unknown[], status = "ok") => new Response(JSON.stringify({ items, status, total: items.length }))
const mockedFetch = vi.mocked(userFetch)

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(window, "scrollTo").mockImplementation(() => {})
  mockedFetch.mockImplementation(async url => response(String(url).includes("media_type=tv") ? [tv] : [movie]))
})

describe("catalog browsing", () => {
  it("shows a private-list error instead of presenting it as empty", async () => {
    mockedFetch.mockResolvedValue(response([], "private"))
    renderWithCtx(<CataloghiView />, { tmdbKey: "k", customCatalogs: [cat] })
    expect(await screen.findByText("ui.customErrPrivate")).toBeInTheDocument()
    expect(screen.queryByText("ui.customNoTitles")).not.toBeInTheDocument()
  })

  it("opens the mixed section absent from preview, reuses page cache, and restores keyboard focus", async () => {
    renderWithCtx(<CataloghiView />, { tmdbKey: "k", customCatalogs: [cat] })
    const card = await screen.findByRole("button", { name: /Audit list — ui.tvSeries/ })
    card.focus()
    fireEvent.keyDown(card, { key: "Enter" })
    const dialog = await screen.findByRole("dialog", { name: "Audit list — ui.tvSeries" })
    expect(await within(dialog).findByAltText("Full series")).toBeInTheDocument()
    expect(within(dialog).queryByAltText("Preview movie")).not.toBeInTheDocument()
    expect(document.body.style.overflow).toBe("hidden")
    const close = within(dialog).getByRole("button", { name: "ui.close" })
    const tile = within(dialog).getByRole("button", { name: "Full series" })
    tile.focus()
    fireEvent.keyDown(window, { key: "Tab" })
    expect(close).toHaveFocus()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(card).toHaveFocus()
    expect(document.body.style.overflow).toBe("")
    fireEvent.click(card)
    await screen.findByRole("dialog")
    expect(mockedFetch.mock.calls.filter(([url]) => String(url).includes("media_type=tv"))).toHaveLength(1)
  })

  it("ignores a page response arriving after the catalog is unmounted", async () => {
    let resolve!: (res: Response) => void
    mockedFetch.mockImplementation(async url => String(url).includes("skip=0")
      ? new Promise<Response>(r => { resolve = r }) : response([movie]))
    const view = renderWithCtx(<CataloghiView />, { tmdbKey: "k", customCatalogs: [{ ...cat, url: cat.url + "-late" }] })
    fireEvent.click(await screen.findByRole("button", { name: /Audit list — ui.movie/ }))
    await waitFor(() => expect(resolve).toBeTypeOf("function"))
    view.unmount()
    await act(async () => { resolve(response([movie, tv])) })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    const fullCall = mockedFetch.mock.calls.find(([url]) => String(url).includes("skip=0"))
    expect(fullCall?.[1]?.signal?.aborted).toBe(true)
  })

  it("loads 400 titles thirty at a time and retries a failed page without losing titles", async () => {
    const offsets: number[] = []
    mockedFetch.mockImplementation(async url => {
      const params = new URL(String(url), "https://test.local").searchParams
      expect(params.get("limit")).toBe("30")
      if (!params.has("skip")) return response([movie])
      expect(params.get("media_type")).toBe("movie")
      const skip = Number(params.get("skip"))
      offsets.push(skip)
      if (skip === 30 && offsets.filter(n => n === 30).length === 1) throw new Error("offline")
      const items = Array.from({ length: 30 }, (_, i) => ({ ...movie, id: skip + i + 1, title: `Title ${skip + i + 1}` }))
      return new Response(JSON.stringify({ status: "ok", total: 400, nextOffset: skip + 30, items }))
    })
    renderWithCtx(<CataloghiView />, { tmdbKey: "k", customCatalogs: [{ ...cat, url: cat.url + "-partial" }] })
    fireEvent.click(await screen.findByRole("button", { name: /Audit list — ui.movie/ }))
    const dialog = await screen.findByRole("dialog")
    await within(dialog).findByAltText("Title 30")
    expect(within(dialog).getAllByRole("button", { name: /^Title / })).toHaveLength(30)
    fireEvent.click(within(dialog).getByRole("button", { name: "ui.showMore" }))
    await within(dialog).findByRole("alert")
    expect(within(dialog).getAllByRole("button", { name: /^Title / })).toHaveLength(30)
    fireEvent.click(within(dialog).getByRole("button", { name: "ui.retry" }))
    await within(dialog).findByAltText("Title 60")
    expect(within(dialog).getAllByRole("button", { name: /^Title / })).toHaveLength(60)
    expect(offsets).toEqual([0, 30, 30])
  })

  it("keeps a platform loading independently of JustWatch completion", () => {
    renderWithCtx(<CataloghiView />, { tmdbKey: "k", trendingStatus: "empty" })
    fireEvent.click(screen.getByRole("button", { name: "Netflix" }))
    expect(screen.getByText("ui.loadingCatalogs")).toBeInTheDocument()
    expect(screen.queryByText("ui.customNoTitles")).not.toBeInTheDocument()
  })

  it("requests only visible or selected streaming platforms", async () => {
    const callbacks: Array<(entries: IntersectionObserverEntry[]) => void> = []
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) { callbacks.push(callback) }
      observe() {}
      disconnect() {}
    })
    try {
      const loadPlatform = vi.fn(async () => true)
      const view = renderWithCtx(<CataloghiView />, { tmdbKey: "k", loadPlatform })
      expect(loadPlatform).not.toHaveBeenCalled()
      await act(async () => { callbacks[0]([{ isIntersecting: true } as IntersectionObserverEntry]) })
      expect(loadPlatform).toHaveBeenCalledTimes(1)
      expect(loadPlatform).toHaveBeenCalledWith("netflix")
      fireEvent.click(screen.getByRole("button", { name: "Disney+" }))
      expect(loadPlatform).toHaveBeenLastCalledWith("disney")
      expect(loadPlatform).toHaveBeenCalledTimes(2)
      view.unmount()
    } finally { vi.unstubAllGlobals() }
  })
})

describe("CataloghiView ranking-source names", () => {
  const jwMovie = { id: 11, media_type: "movie" as const, title: "JW Movie", poster_path: "/jwm.jpg", rank: 1 }
  const jwSeries = { id: 22, media_type: "tv" as const, title: "JW Series", poster_path: "/jws.jpg", rank: 2 }
  const trendingBoth = [jwMovie, jwSeries]

  it("keeps the charts default byte-identical (legacy section, rows and grids)", async () => {
    const view = renderWithCtx(<CataloghiView />, { tmdbKey: "k", trending: trendingBoth })
    expect(await screen.findByText("ui.justwatchTop20 🇮🇹")).toBeInTheDocument()
    expect(screen.getByText("ui.movie — Top 20")).toBeInTheDocument()
    expect(screen.getByText("ui.tvSeries — Top 20")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /ui\.movie — Top 20/ }))
    expect(await screen.findByRole("dialog", { name: "JustWatch — ui.movie" })).toBeInTheDocument()
    view.unmount()
  })

  it("shows independent popular/trending names without flags and a neutral heading", async () => {
    const view = renderWithCtx(<CataloghiView />, {
      tmdbKey: "k",
      trending: trendingBoth,
      rankingSourceMovie: "jw:popular",
      rankingSourceSeries: "jw:trending",
    })
    expect(await screen.findByText("I più popolari — Film")).toBeInTheDocument()
    expect(screen.getByText("In tendenza — Serie TV")).toBeInTheDocument()
    expect(screen.queryByText("ui.movie — Top 20")).not.toBeInTheDocument()
    expect(screen.queryByText("ui.tvSeries — Top 20")).not.toBeInTheDocument()
    // Mixed sources: no false "JustWatch Top 20" section heading.
    expect(screen.queryByText("ui.justwatchTop20 🇮🇹")).not.toBeInTheDocument()
    expect(screen.getByText("ui.rankingSourceTitle 🇮🇹")).toBeInTheDocument()
    // Expanded grids follow the same effective names.
    fireEvent.click(screen.getByRole("button", { name: /I più popolari — Film/ }))
    expect(await screen.findByRole("dialog", { name: "I più popolari — Film" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "ui.close" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /In tendenza — Serie TV/ }))
    expect(await screen.findByRole("dialog", { name: "In tendenza — Serie TV" })).toBeInTheDocument()
    view.unmount()
  })

  // Live source-switch harness: ONE mounted tree whose provider value follows
  // local state, so the button below performs a REAL same-mounted provider
  // update (no unmount/remount). CataloghiView reads the selection via
  // usePSelector, so the rename must propagate to the already-mounted rows.
  function LiveSourceSwitchHost() {
    const [movieSrc, setMovieSrc] = useState("")
    const animeItem = { id: 33, media_type: "movie" as const, title: "Anime Movie", poster_path: "/a.jpg", rank: 1 }
    const ctx = {
      ...MOCK_CTX,
      tmdbKey: "k",
      trending: trendingBoth,
      mdblistAnimeList: [animeItem],
      rankingSourceMovie: movieSrc,
      rankingSourceSeries: "",
    }
    return (
      <ThemeProvider>
        <PosterEditorProvider>
          <PictoriumProvider value={ctx}>
            <button type="button" onClick={() => setMovieSrc("jw:popular")}>switch-movie-source</button>
            <CataloghiView />
          </PictoriumProvider>
        </PosterEditorProvider>
      </ThemeProvider>
    )
  }

  it("updates names live on a same-mounted provider source change (no remount)", async () => {
    const view = render(<LiveSourceSwitchHost />)
    expect(await screen.findByText("ui.justwatchTop20 🇮🇹")).toBeInTheDocument()
    // The charts movie row title is shared with the anime movie row at this
    // layer, so the unique series row pins the initial charts state.
    expect(screen.getByText("ui.tvSeries — Top 20")).toBeInTheDocument()
    // Anime + platform headings use their own strings.
    expect(screen.getByText("ui.trendingAnime")).toBeInTheDocument()
    expect(screen.getByText("ui.streamingPlatforms")).toBeInTheDocument()
    // Same mounted tree: flip the movie source through provider state.
    fireEvent.click(screen.getByRole("button", { name: "switch-movie-source" }))
    expect(await screen.findByText("I più popolari — Film")).toBeInTheDocument()
    // Untouched series slot keeps the charts row; anime/platform strings unchanged.
    expect(screen.getByText("ui.tvSeries — Top 20")).toBeInTheDocument()
    expect(screen.getByText("ui.trendingAnime")).toBeInTheDocument()
    expect(screen.getByText("ui.streamingPlatforms")).toBeInTheDocument()
    // Scope note: the `trending` fixture rows are source-independent input at
    // this layer — only the effective names react to the selection here. Row
    // content refetch on source change is owned by the context/catalog data
    // layer, not by this view, so this test pins live name propagation only
    // and claims no data-lifecycle coverage.
    view.unmount()
  })

  it("lets an explicit rename win and shows a custom source name independently", async () => {
    const custom = { id: "mylist", name: "La mia lista", type: "movie" as const, url: "https://mdblist.com/lists/u/mylist" }
    const view = renderWithCtx(<CataloghiView />, {
      tmdbKey: "k",
      trending: trendingBoth,
      customCatalogs: [custom],
      rankingSourceMovie: "mylist",
      catalogRenames: { "pictorium-jw-series": "Le mie serie" },
    })
    expect((await screen.findAllByText("La mia lista")).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText("Le mie serie")).toBeInTheDocument()
    expect(screen.getByText("ui.rankingSourceTitle 🇮🇹")).toBeInTheDocument()
    // The driving custom list appears both as its own custom row and as the
    // JW movie row: the JW copy (last match) opens the effective grid name.
    const copies = screen.getAllByRole("button", { name: /La mia lista/ })
    expect(copies.length).toBeGreaterThanOrEqual(2)
    fireEvent.click(copies[copies.length - 1])
    expect(await screen.findByRole("dialog", { name: "La mia lista" })).toBeInTheDocument()
    view.unmount()
  })

  it("browsing stays flagless while the canonical/manifest name keeps the flag (same mode, same preference)", async () => {
    const { rankingSourceCatalogName } = await import("@/lib/ranking-source")
    const { getRegionDef } = await import("@/lib/regions")
    const itRegion = getRegionDef("IT")
    const selection = { rankingSourceMovie: "jw:popular", rankingSourceSeries: "jw:trending" }
    // Canonical/export names (manager + manifest) carry the flag with emoji ON.
    expect(rankingSourceCatalogName("pictorium-jw-movies", "movie", selection, itRegion)).toBe(
      "🇮🇹 I più popolari — Film",
    )
    expect(rankingSourceCatalogName("pictorium-jw-series", "series", selection, itRegion)).toBe(
      "🇮🇹 In tendenza — Serie TV",
    )
    // Browsing rows/expanded grids suppress it under the very same preference.
    const view = renderWithCtx(<CataloghiView />, {
      tmdbKey: "k",
      trending: trendingBoth,
      catalogShowEmojis: true,
      ...selection,
    })
    expect(await screen.findByText("I più popolari — Film")).toBeInTheDocument()
    expect(screen.getByText("In tendenza — Serie TV")).toBeInTheDocument()
    expect(screen.queryByText("🇮🇹 I più popolari — Film")).not.toBeInTheDocument()
    expect(screen.queryByText("🇮🇹 In tendenza — Serie TV")).not.toBeInTheDocument()
    view.unmount()
  })

  it("keeps ordinary emojis in custom renames visible by default in browsing", async () => {
    const custom = { id: "mylist", name: "🚀 La mia lista", type: "movie" as const, url: "https://mdblist.com/lists/u/mylist" }
    const view = renderWithCtx(<CataloghiView />, {
      tmdbKey: "k",
      trending: trendingBoth,
      customCatalogs: [custom],
      rankingSourceMovie: "mylist",
    })
    expect((await screen.findAllByText("🚀 La mia lista")).length).toBeGreaterThanOrEqual(2)
    view.unmount()
  })

  it("strips browsing names for display when emojis are off, stored values untouched", async () => {
    const view = renderWithCtx(<CataloghiView />, {
      tmdbKey: "k",
      trending: trendingBoth,
      catalogShowEmojis: false,
      rankingSourceMovie: "jw:popular",
      catalogRenames: { "pictorium-jw-series": "🚀 Le mie serie" },
    })
    expect(await screen.findByText("I più popolari — Film")).toBeInTheDocument()
    expect(screen.getByText("Le mie serie")).toBeInTheDocument()
    expect(screen.queryByText("🚀 Le mie serie")).not.toBeInTheDocument()
    view.unmount()
  })
})
