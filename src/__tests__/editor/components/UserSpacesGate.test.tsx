import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import { UserSpacesList } from "@/components/UserSpaceSection"
import { renderWithCtx } from "@/__tests__/test-utils"
import {
  __resetUnlockedUsersForTests,
  __resetUserCredentialsForTests,
  getStoredUserPassword,
  isUserUnlocked,
  USER_UNLOCK_EVENT,
} from "@/lib/user-token"

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
}))

const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

function setUrl(url: string): void {
  window.history.replaceState({}, "", url)
}

// localStorage osservabile: alla fine deve restare pulito da credenziali.
let localStore: Record<string, string> = {}
function installStorages(): void {
  localStore = {}
  const mem = (store: Record<string, string>) => ({
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = String(v) },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { for (const k of Object.keys(store)) delete store[k] },
  })
  Object.defineProperty(window, "localStorage", { value: mem(localStore), configurable: true })
}

function mockApi() {
  global.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    if (u.includes("/api/status")) {
      return { ok: true, status: 200, json: async () => ({ multiUser: true }) }
    }
    if (u.includes("/api/users") && (init as RequestInit)?.method === "POST" && !u.includes("/verify")) {
      const body = JSON.parse(String((init as { body?: string }).body || "{}")) as { password?: unknown }
      if (typeof body.password !== "string" || body.password.length < 8) {
        return { ok: false, status: 400, json: async () => ({ error: "Password required" }) }
      }
      return { ok: true, status: 200, json: async () => ({ uuid: UUID, secret: "new-secret-1" }) }
    }
    if (u.includes(`/api/users/${UUID}/verify`)) {
      const body = JSON.parse(String((init as { body?: string }).body || "{}")) as { password?: unknown }
      const ok = body.password === "right-password-1"
      return { ok, status: ok ? 200 : 401, json: async () => (ok ? { ok: true } : {}) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

const realFetch = global.fetch

beforeEach(() => {
  installStorages()
  __resetUnlockedUsersForTests()
  __resetUserCredentialsForTests()
  pushMock.mockClear()
  setUrl("/")
  mockApi()
})

afterEach(() => {
  global.fetch = realFetch
  __resetUnlockedUsersForTests()
  __resetUserCredentialsForTests()
  window.sessionStorage.removeItem("pictorium_active_space")
  setUrl("/")
  vi.restoreAllMocks()
})

function expectNoTrustedMemory() {
  const leaked = Object.keys(localStore).filter((k) => k.includes("trusted"))
  expect(leaked).toEqual([])
}

describe("UserSpacesList gate crea/entri (zero memoria)", () => {
  it("crea: password corta = bottone spento; ok = secret una tantum + login immediato", async () => {
    renderWithCtx(<UserSpacesList />)
    // Due input con stesso placeholder (crea + login): il primo è creazione.
    const pwInputs = await screen.findAllByPlaceholderText("••••••••")
    const pwInput = pwInputs[0]
    fireEvent.change(pwInput, { target: { value: "short" } })
    expect(screen.getByRole("button", { name: "ui.userSpaceCreate" })).toBeDisabled()

    fireEvent.change(pwInput, { target: { value: "new-password-1" } })
    fireEvent.click(screen.getByRole("button", { name: "ui.userSpaceCreate" }))

    // Secret mostrato una volta + UUID, e si è già dentro (niente doppia password).
    expect(await screen.findByText("new-secret-1")).toBeInTheDocument()
    expect(screen.getByText(UUID)).toBeInTheDocument()
    await waitFor(() => expect(isUserUnlocked(UUID)).toBe(true))
    expect(getStoredUserPassword(UUID)).toBe("new-password-1")
    // Il secret resta sul dispositivo (sempre copiabile), niente lista spazi.
    expect(localStore[`pictorium-user-token:${UUID.toLowerCase()}`]).toBe("new-secret-1")
    expectNoTrustedMemory()
  })

  it("entra: UUID + password verificati, poi naviga allo spazio", async () => {
    renderWithCtx(<UserSpacesList />)
    await screen.findByText("ui.userSpaceOr")

    const uuidInput = screen.getByPlaceholderText("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
    const pwInputs = screen.getAllByPlaceholderText("••••••••")
    fireEvent.change(uuidInput, { target: { value: UUID } })
    fireEvent.change(pwInputs[pwInputs.length - 1], { target: { value: "right-password-1" } })
    fireEvent.click(screen.getByRole("button", { name: "ui.userUnlockOpen" }))

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/u/${UUID}/configure`))
    expect(isUserUnlocked(UUID)).toBe(true)
    expect(getStoredUserPassword(UUID)).toBe("right-password-1")
    // Login non scrive nulla (niente secret da salvare qui).
    expectNoTrustedMemory()
  })

  it("shortcut: spazio attivo sbloccato mostra banner e naviga", async () => {
    window.sessionStorage.setItem("pictorium_active_space", UUID)
    window.dispatchEvent(new CustomEvent(USER_UNLOCK_EVENT, { detail: { uuid: UUID } }))
    renderWithCtx(<UserSpacesList />)
    // Banner con UUID + pulsante: niente ridigitazione.
    expect(await screen.findByText(UUID)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "ui.userSpaceOpen" }))
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/u/${UUID}/configure`))
    // Solo lettura sessionStorage: niente scritture persistenti.
    expectNoTrustedMemory()
  })

  it("shortcut: spazio attivo bloccato non mostra banner ma precompila il login", async () => {
    window.sessionStorage.setItem("pictorium_active_space", UUID)
    renderWithCtx(<UserSpacesList />)
    await screen.findByText("ui.userSpaceOr")
    // Niente banner senza unlock: solo prefill del campo UUID.
    expect(screen.queryByRole("button", { name: "ui.userSpaceOpen" })).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")).toHaveValue(UUID)
    expectNoTrustedMemory()
  })

  it("entra: password errata resta al gate, niente navigazione", async () => {
    renderWithCtx(<UserSpacesList />)
    await screen.findByText("ui.userSpaceOr")

    fireEvent.change(screen.getByPlaceholderText("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"), {
      target: { value: UUID },
    })
    const pwInputs = screen.getAllByPlaceholderText("••••••••")
    fireEvent.change(pwInputs[pwInputs.length - 1], { target: { value: "wrong" } })
    fireEvent.click(screen.getByRole("button", { name: "ui.userUnlockOpen" }))

    await waitFor(() => expect(pushMock).not.toHaveBeenCalled())
    expect(isUserUnlocked(UUID)).toBe(false)
    expect(screen.queryByText("new-secret-1")).not.toBeInTheDocument()
  })
})
