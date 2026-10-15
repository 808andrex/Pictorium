import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { PictoriumRoot, usePSelector } from "@/lib/context"
import {
  __resetUnlockedUsersForTests,
  __resetUserCredentialsForTests,
  getStoredUserToken,
  setStoredUserPassword,
  setStoredUserToken,
  USER_UNLOCK_EVENT,
} from "@/lib/user-token"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))

const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const STALE = "stale-secret-from-typo"
const FRESH_PW = "fresh-password-1"

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

/** Sonda sul gate poster reale: serverHasTmdbKey dal provider vero. */
function GateProbe() {
  const open = usePSelector((v) => v.serverHasTmdbKey)
  return <div data-testid="poster-gate">{open ? "OPEN" : "CLOSED"}</div>
}

function mockServer() {
  global.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    const headers = ((init?.headers ?? {}) as Record<string, string>)
    const lower: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
    // Status chiavi namespace: secret stantio → 401, password fresca → 200.
    if (u.includes(`/api/users/${UUID}/keys`) && !u.includes("/reveal")) {
      if (lower["x-user-token"] === STALE) return new Response("{}", { status: 401 })
      if (lower["x-user-password"] === FRESH_PW) {
        return new Response(
          JSON.stringify({ tmdb: true, mdblist: false, tvdb: false, hasPassword: true }),
          { status: 200 },
        )
      }
      return new Response("{}", { status: 401 })
    }
    if (u.includes("/api/tmdb/trending")) {
      return new Response(JSON.stringify({ movies: [], tv: [] }), { status: 200 })
    }
    if (u.includes("/api/mdblist/anime")) return new Response("[]", { status: 200 })
    return new Response("{}", { status: 200 })
  }) as unknown as typeof fetch
}

const realFetch = global.fetch

beforeEach(() => {
  installStorages()
  __resetUnlockedUsersForTests()
  __resetUserCredentialsForTests()
  setUrl(`/u/${UUID}/configure`)
  mockServer()
})

afterEach(() => {
  global.fetch = realFetch
  __resetUnlockedUsersForTests()
  __resetUserCredentialsForTests()
  setUrl("/")
  vi.restoreAllMocks()
})

describe("storia: login con password e secret stantio apre i poster senza refresh", () => {
  it("gate chiuso da ospite, OPEN dopo unlock (retry password + drop secret)", async () => {
    render(
      <PictoriumRoot>
        <GateProbe />
      </PictoriumRoot>,
    )
    // Ospite: niente credenziali → gate chiuso.
    expect(await screen.findByTestId("poster-gate")).toHaveTextContent("CLOSED")

    // Il browser ha un secret stantio (typo pre-verifica) + password fresca:
    // è il login con password del modal (set password + evento unlock).
    setStoredUserToken(UUID, STALE)
    setStoredUserPassword(UUID, FRESH_PW)
    window.dispatchEvent(new CustomEvent(USER_UNLOCK_EVENT, { detail: { uuid: UUID } }))

    // Senza retry questo resterebbe CLOSED fino al refresh (il bug riportato).
    await waitFor(() => expect(screen.getByTestId("poster-gate")).toHaveTextContent("OPEN"))
    // E il secret provatamente marcio è stato buttato dalla sessione.
    expect(getStoredUserToken(UUID)).toBeNull()
  })
})

describe("storia: arrivo via gate (albero riusato) poi login apre i poster", () => {
  it("provider montato su / risincronizza l'uuid a unlock/popstate", async () => {
    // L'albero nasce sulla home (nessun uuid): simula il riuso senza remount
    // (back/forward, SPA che preserva lo stato). Poi si naviga a /u/ e si fa
    // login: senza re-sync il listener post-unlock non esisterebbe mai e il
    // gate poster resterebbe chiuso fino al refresh.
    setUrl("/")
    render(
      <PictoriumRoot>
        <GateProbe />
      </PictoriumRoot>,
    )
    expect(await screen.findByTestId("poster-gate")).toHaveTextContent("CLOSED")

    // Navigazione senza remount + login con password (credenziali pulite:
    // qui non c'entra lo secret stantio, solo lo uuid stantio).
    setUrl(`/u/${UUID}/configure`)
    setStoredUserPassword(UUID, FRESH_PW)
    window.dispatchEvent(new CustomEvent(USER_UNLOCK_EVENT, { detail: { uuid: UUID } }))

    await waitFor(() => expect(screen.getByTestId("poster-gate")).toHaveTextContent("OPEN"))
  })
})
