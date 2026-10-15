import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import EditView from "@/components/EditView"
import { renderWithCtx } from "@/__tests__/test-utils"
import { resetGuestGuardForTests } from "@/lib/guest-guard"
import { USER_UNLOCK_EVENT } from "@/lib/user-token"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))

const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

function setUrl(url: string): void {
  window.history.replaceState({}, "", url)
}

const realFetch = global.fetch

beforeEach(() => {
  resetGuestGuardForTests()
  setUrl("/")
  global.fetch = (async (url: unknown) => {
    if (String(url).includes("/api/status")) {
      return { ok: true, status: 200, json: async () => ({ multiUser: true }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
})

afterEach(() => {
  global.fetch = realFetch
  resetGuestGuardForTests()
  setUrl("/")
  vi.restoreAllMocks()
})

describe("EditView profile gate segue la navigazione senza remount", () => {
  it("gate su /, si alza arrivando a /u/ + unlock", async () => {
    setUrl("/")
    renderWithCtx(<EditView />, { tmdbKey: "" })
    // Gate profili visibile sulla home.
    expect(await screen.findByText("ui.profileGateTitle")).toBeInTheDocument()

    // Navigazione senza remount verso lo spazio + login: senza re-sync del
    // pathUuid il gate resterebbe murato fino al refresh.
    setUrl(`/u/${UUID}/configure`)
    window.dispatchEvent(new CustomEvent(USER_UNLOCK_EVENT, { detail: { uuid: UUID } }))

    await waitFor(() => expect(screen.queryByText("ui.profileGateTitle")).not.toBeInTheDocument())
  })

  it("tornando indietro con popstate il gate si richiude", async () => {
    setUrl(`/u/${UUID}/configure`)
    renderWithCtx(<EditView />, { tmdbKey: "" })
    // Su /u/ niente gate (search o welcome secondo chiave).
    await waitFor(() => expect(screen.queryByText("ui.profileGateTitle")).not.toBeInTheDocument())

    // Back verso la home senza remount: il gate deve ricomparire.
    setUrl("/")
    window.dispatchEvent(new PopStateEvent("popstate"))
    expect(await screen.findByText("ui.profileGateTitle")).toBeInTheDocument()
  })
})
