import { afterEach, describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import EditView from "@/components/EditView"
import { renderWithCtx } from "@/__tests__/test-utils"
import { resetGuestGuardForTests } from "@/lib/guest-guard"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))

const realFetch = global.fetch

function mockStatus(multiUser: boolean) {
  global.fetch = (async (url: unknown) => {
    if (String(url).includes("/api/status")) {
      return { ok: true, json: async () => ({ multiUser }) }
    }
    return { ok: false, json: async () => ({}) }
  }) as unknown as typeof fetch
}

afterEach(() => {
  global.fetch = realFetch
  resetGuestGuardForTests()
})

describe("EditView profile gate", () => {
  it("con multi-user e senza uuid mostra il gate e nasconde ricerca/welcome", async () => {
    mockStatus(true)
    renderWithCtx(<EditView />, { tmdbKey: "" })
    expect(await screen.findByText("ui.profileGateTitle")).toBeInTheDocument()
    expect(screen.queryByPlaceholderText("ui.searchPlaceholderLarge")).not.toBeInTheDocument()
    expect(screen.queryByText("ui.noKey")).not.toBeInTheDocument()
  })

  it("con multi-user spento resta la home classica", async () => {
    mockStatus(false)
    renderWithCtx(<EditView />, { tmdbKey: "" })
    expect(await screen.findByPlaceholderText("ui.searchPlaceholderLarge")).toBeInTheDocument()
    expect(screen.queryByText("ui.userSpaceListTitle")).not.toBeInTheDocument()
  })

  it("il gate regge anche con selected impostata da altre viste (niente bypass)", async () => {
    mockStatus(true)
    renderWithCtx(<EditView />, {
      tmdbKey: "",
      selected: {
        id: 550,
        media_type: "movie",
        title: "Fight Club",
        name: "",
        poster_path: "/fc.jpg",
        release_date: "1999-10-15",
      },
    })
    expect(await screen.findByText("ui.profileGateTitle")).toBeInTheDocument()
    expect(screen.queryByText("ui.previewLive")).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText("ui.searchPlaceholderLarge")).not.toBeInTheDocument()
  })
})
