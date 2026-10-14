import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import { CustomCatalogModal } from "@/components/CustomCatalogModal"
import { renderWithCtx } from "@/__tests__/test-utils"
import {
  __resetUnlockedUsersForTests,
  __resetUserCredentialsForTests,
  setStoredUserPassword,
  USER_UNLOCK_EVENT,
} from "@/lib/user-token"
import { consumeSettingsTab } from "@/lib/settings-tab"

const UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const TRAKT_WATCHLIST = "https://trakt.tv/users/someone/watchlist"

function setUrl(url: string): void {
  window.history.replaceState({}, "", url)
}

const realFetch = global.fetch
let calls: Array<{ url: string; headers: Record<string, string> }>

function headersOf(init?: RequestInit): Record<string, string> {
  if (!init?.headers) return {}
  if (typeof Headers !== "undefined" && init.headers instanceof Headers) {
    const out: Record<string, string> = {}
    init.headers.forEach((v, k) => {
      out[k] = v
    })
    return out
  }
  if (Array.isArray(init.headers)) return Object.fromEntries(init.headers)
  return { ...(init.headers as Record<string, string>) }
}

function mockFetch(
  fn: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>,
): void {
  calls = []
  global.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), headers: headersOf(init) })
    return fn(String(url), init)
  }) as unknown as typeof fetch
}

function fillAndSubmit(): void {
  fireEvent.change(screen.getByPlaceholderText("ui.customUrlPh"), { target: { value: TRAKT_WATCHLIST } })
  fireEvent.change(screen.getByPlaceholderText("ui.customNamePh"), { target: { value: "My Watchlist" } })
  fireEvent.click(screen.getByRole("button", { name: "ui.addCatalogBtn" }))
}

beforeEach(() => {
  localStorage.clear()
  __resetUnlockedUsersForTests()
  __resetUserCredentialsForTests()
  vi.clearAllMocks()
  consumeSettingsTab()
  setUrl(`/u/${UUID}/configure`)
  setStoredUserPassword(UUID, "space-password-3")
  window.dispatchEvent(new CustomEvent(USER_UNLOCK_EVENT, { detail: { uuid: UUID } }))
})

afterEach(() => {
  global.fetch = realFetch
  __resetUnlockedUsersForTests()
  __resetUserCredentialsForTests()
  setUrl("/")
  vi.restoreAllMocks()
})

describe("CustomCatalogModal Trakt owner-private preview", () => {
  it("passes ownership (u + auth headers) and shows the Settings connect prompt on connection_required", async () => {
    mockFetch(async (url) => {
      if (url.includes("/api/mdblist/custom?")) {
        return { ok: true, status: 200, json: async () => ({ items: [], status: "connection_required", provider: "trakt" }) }
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const onClose = vi.fn()
    const setSettingsOpen = vi.fn()
    renderWithCtx(<CustomCatalogModal isOpen={true} onClose={onClose} />, { t: ((k: string) => k) as never, setSettingsOpen })
    fillAndSubmit()
    // Typed error, not a fake empty list.
    expect(await screen.findByText("ui.customErrTraktReconnect")).toBeInTheDocument()
    // Ownership travelled with the preview request.
    const preview = calls.find((c) => c.url.includes("/api/mdblist/custom?"))
    expect(preview).toBeDefined()
    expect(preview!.url).toContain(`u=${UUID}`)
    const lower = Object.fromEntries(Object.entries(preview!.headers).map(([k, v]) => [k.toLowerCase(), v]))
    expect(lower["x-user-password"]).toBe("space-password-3")
    expect(JSON.stringify(preview!.headers)).not.toMatch(/Bearer|token.*secret/i)
    // Explicit Settings connect prompt.
    const connect = screen.getByRole("button", { name: "ui.customTraktConnect" })
    fireEvent.click(connect)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(consumeSettingsTab()).toBe("spazio")
    expect(setSettingsOpen).toHaveBeenCalledWith(true)
  })

  it("maps a 401 preview auth failure to login/connect instead of a fake empty", async () => {
    mockFetch(async (url) => {
      if (url.includes("/api/mdblist/custom?")) {
        return { ok: false, status: 401, json: async () => ({ error: "Unauthorized. Set x-user-token or Authorization: Bearer header." }) }
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    renderWithCtx(<CustomCatalogModal isOpen={true} onClose={vi.fn()} />, { t: ((k: string) => k) as never })
    fillAndSubmit()
    expect(await screen.findByText("ui.customErrTraktReconnect")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "ui.customTraktConnect" })).toBeInTheDocument()
  })

  it("renders the temporary prompt without a connect button", async () => {
    mockFetch(async (url) => {
      if (url.includes("/api/mdblist/custom?")) {
        return { ok: true, status: 200, json: async () => ({ items: [], status: "temporary", provider: "trakt" }) }
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    renderWithCtx(<CustomCatalogModal isOpen={true} onClose={vi.fn()} />, { t: ((k: string) => k) as never })
    fillAndSubmit()
    expect(await screen.findByText("ui.customErrTemporary")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "ui.customTraktConnect" })).toBeNull()
  })

  it("preserves the public flow: items save, no connect prompt", async () => {
    mockFetch(async (url) => {
      if (url.includes("/api/mdblist/custom?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [{ title: "Dune", year: 2021 }],
            status: "ok",
            provider: "letterboxd",
          }),
        }
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const addCustomCatalog = vi.fn()
    renderWithCtx(<CustomCatalogModal isOpen={true} onClose={vi.fn()} />, {
      t: ((k: string) => k) as never,
      addCustomCatalog,
    })
    fireEvent.change(screen.getByPlaceholderText("ui.customUrlPh"), {
      target: { value: "https://letterboxd.com/someone/list/sci-fi/" },
    })
    fireEvent.change(screen.getByPlaceholderText("ui.customNamePh"), { target: { value: "Sci Fi" } })
    fireEvent.click(screen.getByRole("button", { name: "ui.addCatalogBtn" }))
    await waitFor(() => expect(addCustomCatalog).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole("button", { name: "ui.customTraktConnect" })).toBeNull()
  })
})
