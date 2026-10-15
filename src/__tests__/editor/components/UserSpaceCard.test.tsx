import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, screen, within } from "@testing-library/react"
import { UserSpaceSection } from "@/components/UserSpaceSection"
import { renderWithCtx } from "@/__tests__/test-utils"
import {
  __resetUnlockedUsersForTests,
  __resetUserCredentialsForTests,
  setStoredUserPassword,
  setStoredUserToken,
  USER_UNLOCK_EVENT,
} from "@/lib/user-token"

const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const SECRET = "recovery-secret-abc"

function setUrl(url: string): void {
  window.history.replaceState({}, "", url)
}

function installStorages(): void {
  const mem = (store: Record<string, string>) => ({
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = String(v) },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { for (const k of Object.keys(store)) delete store[k] },
  })
  Object.defineProperty(window, "localStorage", { value: mem({}), configurable: true })
}

function mockKeys() {
  global.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ tmdb: false, mdblist: false, tvdb: false, hasPassword: true }),
  })) as unknown as typeof fetch
}

const realFetch = global.fetch

beforeEach(() => {
  installStorages()
  __resetUnlockedUsersForTests()
  __resetUserCredentialsForTests()
  setUrl(`/u/${UUID}/configure`)
  mockKeys()
})

afterEach(() => {
  global.fetch = realFetch
  __resetUnlockedUsersForTests()
  __resetUserCredentialsForTests()
  setUrl("/")
  vi.restoreAllMocks()
})

function unlock() {
  window.dispatchEvent(new CustomEvent(USER_UNLOCK_EVENT, { detail: { uuid: UUID } }))
}

describe("UserSpaceSection card unificata", () => {
  it("un solo titolo, UUID + recupero sempre visibili, form password dietro pulsante", async () => {
    setStoredUserToken(UUID, SECRET)
    setStoredUserPassword(UUID, "pw-1")
    unlock()
    renderWithCtx(<UserSpaceSection />)

    // UN solo header "Il mio spazio": niente più doppia sezione.
    expect(await screen.findAllByText("ui.userSpaceTitle")).toHaveLength(1)
    expect(screen.getByText(UUID)).toBeInTheDocument()
    expect(screen.getByText(SECRET)).toBeInTheDocument()

    // Form password nascosto finché non lo chiedi.
    expect(screen.queryByText("ui.userSpaceNewPw")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "ui.userSpaceChangePw" }))
    expect(await screen.findByText("ui.userSpaceNewPw")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "ui.save" })).toBeInTheDocument()
    // Richiudi.
    fireEvent.click(screen.getByRole("button", { name: "ui.userSpaceChangePw" }))
    expect(screen.queryByText("ui.userSpaceNewPw")).not.toBeInTheDocument()
  })

  it("da bloccato: solo UUID visibile (secret e password restano nascosti)", () => {
    setStoredUserToken(UUID, SECRET)
    renderWithCtx(<UserSpaceSection />)
    // UUID è pubblico (sta già nell'URL): visibile. Secret e form no.
    expect(screen.getByText(UUID)).toBeInTheDocument()
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "ui.userSpaceChangePw" })).not.toBeInTheDocument()
  })

  it("senza secret: recupero non impostato, copia disabilitata", async () => {
    setStoredUserPassword(UUID, "pw-solo-password-1")
    unlock()
    renderWithCtx(<UserSpaceSection />)

    expect(await screen.findByText(UUID)).toBeInTheDocument()
    const card = screen.getByText("ui.userRecoveryKey").closest("div")!
    const section = card.parentElement!
    const buttons = within(section).getAllByRole("button")
    // UUID copy + recovery copy (disabilitata) + pulsante cambia password.
    expect(buttons).toHaveLength(3)
    expect(buttons[1]).toBeDisabled()
  })
})
