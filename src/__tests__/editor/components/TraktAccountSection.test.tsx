import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { TraktAccountSection } from "@/components/TraktAccountSection"
import { renderWithCtx } from "@/__tests__/test-utils"
import {
  __resetUnlockedUsersForTests,
  __resetUserCredentialsForTests,
  setStoredUserPassword,
  USER_UNLOCK_EVENT,
} from "@/lib/user-token"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

import { toast } from "sonner"

const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

function setUrl(url: string): void {
  window.history.replaceState({}, "", url)
}

function unlock(uuid: string): void {
  window.dispatchEvent(new CustomEvent(USER_UNLOCK_EVENT, { detail: { uuid } }))
}

type FetchMock = (url: unknown, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

const realFetch = global.fetch
let calls: Array<{ url: string; init?: RequestInit }>

function mockFetch(fn: FetchMock): void {
  calls = []
  global.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return fn(url, init)
  }) as unknown as typeof fetch
}

function statusRes(configured: boolean, status: string) {
  return { ok: true, status: 200, json: async () => ({ configured, status }) }
}

beforeEach(() => {
  localStorage.clear()
  __resetUnlockedUsersForTests()
  __resetUserCredentialsForTests()
  vi.clearAllMocks()
  setUrl(`/u/${UUID_A}/configure`)
  setStoredUserPassword(UUID_A, "space-password-1")
  unlock(UUID_A)
})

afterEach(() => {
  global.fetch = realFetch
  __resetUnlockedUsersForTests()
  __resetUserCredentialsForTests()
  setUrl("/")
  vi.restoreAllMocks()
})

describe("TraktAccountSection", () => {
  it("disconnected profile shows a connect button with the Trakt logo and label", async () => {
    mockFetch(async (url) => {
      if (String(url).includes(`/api/users/${UUID_A}/trakt/status`)) return statusRes(true, "disconnected")
      throw new Error(`unexpected fetch ${String(url)}`)
    })
    renderWithCtx(<TraktAccountSection />)
    const connect = await screen.findByRole("button", { name: "ui.traktConnect" })
    expect(connect).not.toBeDisabled()
    const logo = connect.querySelector('img[alt="trakt"]')
    expect(logo).not.toBeNull()
    expect(logo?.getAttribute("src")).toBe("/rating/trakt.svg")
    expect(screen.getByText("ui.traktDisconnected")).toBeInTheDocument()
  })

  it("connect is busy-guarded and routes navigation through the dirty-guard action", async () => {
    let resolveAuthorize!: (v: { ok: boolean; status: number; json: () => Promise<unknown> }) => void
    const authorizeGate = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((r) => {
      resolveAuthorize = r
    })
    mockFetch(async (url, init) => {
      const u = String(url)
      if (u.includes(`/api/users/${UUID_A}/trakt/status`)) return statusRes(true, "disconnected")
      if (u.includes(`/api/users/${UUID_A}/trakt/authorize`) && init?.method === "POST") return authorizeGate
      throw new Error(`unexpected fetch ${u}`)
    })
    const externalRuns: Array<() => void> = []
    renderWithCtx(<TraktAccountSection onRequestExternalAction={(run) => externalRuns.push(run)} />)
    const connect = await screen.findByRole("button", { name: "ui.traktConnect" })
    fireEvent.click(connect)
    fireEvent.click(connect)
    await waitFor(() => expect(connect).toBeDisabled())
    // Duplicate clicks while busy issue a single authorize POST.
    expect(calls.filter((c) => String(c.url).includes("/trakt/authorize"))).toHaveLength(1)
    resolveAuthorize({ ok: true, status: 200, json: async () => ({ authorizeUrl: "https://auth.trakt.tv/oauth/authorize?state=x", expiresIn: 600 }) })
    await waitFor(() => expect(externalRuns).toHaveLength(1))
    expect(typeof externalRuns[0]).toBe("function")
    // Cancellation leaves everything unchanged: no navigation happened here
    // and the badge still shows the pre-connect state.
    expect(window.location.href).not.toContain("trakt.tv")
    expect(screen.getByText("ui.traktDisconnected")).toBeInTheDocument()
  })

  it("authorize 503 surfaces a temporary error without disconnecting", async () => {
    mockFetch(async (url) => {
      const u = String(url)
      if (u.includes(`/api/users/${UUID_A}/trakt/status`)) return statusRes(true, "disconnected")
      if (u.includes("/trakt/authorize")) return { ok: false, status: 503, json: async () => ({ error: "x" }) }
      throw new Error(`unexpected fetch ${u}`)
    })
    renderWithCtx(<TraktAccountSection onRequestExternalAction={() => {}} />)
    fireEvent.click(await screen.findByRole("button", { name: "ui.traktConnect" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("ui.traktUnavailable"))
    expect(screen.getByText("ui.traktDisconnected")).toBeInTheDocument()
  })

  it("connected profile shows status plus disconnect; disconnect success toasts and refreshes", async () => {
    let linked = true
    mockFetch(async (url, init) => {
      const u = String(url)
      if (u.includes(`/api/users/${UUID_A}/trakt/status`)) return statusRes(true, linked ? "connected" : "disconnected")
      if (u.includes(`/api/users/${UUID_A}/trakt/disconnect`) && init?.method === "DELETE") {
        linked = false
        return { ok: true, status: 200, json: async () => ({ ok: true, revoked: true }) }
      }
      throw new Error(`unexpected fetch ${u}`)
    })
    renderWithCtx(<TraktAccountSection />)
    expect(await screen.findByText("ui.traktConnected")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "ui.traktDisconnect" }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("ui.traktDisconnectOk"))
    expect(await screen.findByText("ui.traktDisconnected")).toBeInTheDocument()
    expect(await screen.findByRole("button", { name: "ui.traktConnect" })).toBeInTheDocument()
  })

  it("missing deployment config disables connect with an admin note and no secret values", async () => {
    mockFetch(async (url) => {
      if (String(url).includes(`/api/users/${UUID_A}/trakt/status`)) return statusRes(false, "disconnected")
      throw new Error(`unexpected fetch ${String(url)}`)
    })
    const { container } = renderWithCtx(<TraktAccountSection />) as unknown as { container: HTMLElement }
    const connect = (await screen.findByRole("button", { name: "ui.traktConnect" })) as HTMLButtonElement
    expect(connect.disabled).toBe(true)
    expect(screen.getByText("ui.traktNotConfigured")).toBeInTheDocument()
    expect(container.textContent ?? "").not.toMatch(/secret|client_secret|api[_-]?key/i)
  })

  it("temporary status offers retry and never a false disconnected badge", async () => {
    mockFetch(async (url) => {
      if (String(url).includes(`/api/users/${UUID_A}/trakt/status`)) return statusRes(true, "unavailable")
      throw new Error(`unexpected fetch ${String(url)}`)
    })
    renderWithCtx(<TraktAccountSection />)
    expect(await screen.findByRole("alert")).toHaveTextContent("ui.traktUnavailable")
    expect(screen.queryByText("ui.traktDisconnected")).toBeNull()
    expect(screen.queryByRole("button", { name: "ui.traktConnect" })).toBeNull()
    // Single retry action (label resolves through the test i18n harness).
    const buttons = screen.getAllByRole("button")
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).not.toBeDisabled()
  })

  it("drops a stale profile-A response after switching to profile B", async () => {
    let resolveA!: (v: { ok: boolean; status: number; json: () => Promise<unknown> }) => void
    const gateA = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((r) => {
      resolveA = r
    })
    mockFetch(async (url) => {
      const u = String(url)
      if (u.includes(`/api/users/${UUID_A}/trakt/status`)) return gateA
      if (u.includes(`/api/users/${UUID_B}/trakt/status`)) return statusRes(true, "disconnected")
      throw new Error(`unexpected fetch ${u}`)
    })
    renderWithCtx(<TraktAccountSection />)
    // Switch profile while A's status is still in flight.
    setStoredUserPassword(UUID_B, "space-password-2")
    setUrl(`/u/${UUID_B}/configure`)
    unlock(UUID_B)
    expect(await screen.findByText("ui.traktDisconnected")).toBeInTheDocument()
    // A's late response must not repaint this section as connected.
    resolveA(statusRes(true, "connected"))
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByText("ui.traktConnected")).toBeNull()
    expect(screen.getByText("ui.traktDisconnected")).toBeInTheDocument()
  })

  it("stays hidden for locked profiles", async () => {
    mockFetch(async () => statusRes(true, "connected"))
    __resetUnlockedUsersForTests()
    __resetUserCredentialsForTests()
    const { container } = renderWithCtx(<TraktAccountSection />) as unknown as { container: HTMLElement }
    await new Promise((r) => setTimeout(r, 50))
    expect(container.textContent ?? "").toBe("")
    // No Trakt status polling while the profile is locked (other providers
    // may fetch on mount; only the Trakt namespace is asserted here).
    expect((calls ?? []).filter((c) => c.url.includes("/trakt/"))).toHaveLength(0)
  })

  it("loads on a late unlock: listeners install even while initially locked", async () => {
    mockFetch(async (url) => {
      if (String(url).includes(`/api/users/${UUID_A}/trakt/status`)) return statusRes(true, "disconnected")
      throw new Error(`unexpected fetch ${String(url)}`)
    })
    // Start locked: the section renders nothing and fetches nothing…
    __resetUnlockedUsersForTests()
    __resetUserCredentialsForTests()
    renderWithCtx(<TraktAccountSection />)
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.filter((c) => c.url.includes("/trakt/"))).toHaveLength(0)
    expect(screen.queryByRole("button", { name: "ui.traktConnect" })).toBeNull()
    // …but the late unlock still loads it (no remount needed).
    setStoredUserPassword(UUID_A, "space-password-1")
    unlock(UUID_A)
    expect(await screen.findByRole("button", { name: "ui.traktConnect" })).toBeInTheDocument()
    expect(calls.filter((c) => c.url.includes(`/api/users/${UUID_A}/trakt/status`)).length).toBeGreaterThan(0)
  })

  it("refuses non-exact authorize URLs: legacy host, lookalikes, paths, http", async () => {
    const seen: string[] = []
    mockFetch(async (url, init) => {
      const u = String(url)
      if (u.includes(`/api/users/${UUID_A}/trakt/status`)) return statusRes(true, "disconnected")
      if (u.includes(`/api/users/${UUID_A}/trakt/authorize`) && init?.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ authorizeUrl: seen.shift() ?? "", expiresIn: 600 }) }
      }
      throw new Error(`unexpected fetch ${u}`)
    })
    const badUrls = [
      "https://trakt.tv/oauth/authorize?state=x",
      "https://auth.trakt.tv.evil.com/oauth/authorize?state=x",
      "https://auth-trakt.tv/oauth/authorize?state=x",
      "https://auth.trakt.tv/other?state=x",
      "https://auth.trakt.tv/oauth/authorize/evil?state=x",
      "http://auth.trakt.tv/oauth/authorize?state=x",
      "https://auth.trakt.tv:443.evil.com/oauth/authorize?state=x",
      "",
    ]
    for (const bad of badUrls) {
      seen.push(bad)
      vi.clearAllMocks()
      renderWithCtx(<TraktAccountSection onRequestExternalAction={() => {}} />)
      try {
        fireEvent.click(await screen.findByRole("button", { name: "ui.traktConnect" }))
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith("ui.traktConnError"))
        // Refused before any navigation surface: the dirty-guard never runs.
        expect(window.location.href).not.toContain("trakt.tv")
      } finally {
        cleanup()
      }
    }
  })

  it("accepts only the exact PKCE authorize URL (unit)", async () => {
    const { isTraktAuthorizeUrl } = await import("@/components/TraktAccountSection")
    expect(isTraktAuthorizeUrl("https://auth.trakt.tv/oauth/authorize?state=x")).toBe(true)
    expect(isTraktAuthorizeUrl("https://auth.trakt.tv/oauth/authorize")).toBe(true)
    for (const bad of [
      "https://trakt.tv/oauth/authorize?state=x",
      "https://auth.trakt.tv.evil.com/oauth/authorize",
      "http://auth.trakt.tv/oauth/authorize",
      "https://auth.trakt.tv/oauth/token",
      "https://auth.trakt.tv/",
      "",
      null,
      42,
    ]) {
      expect(isTraktAuthorizeUrl(bad), String(bad)).toBe(false)
    }
  })

  it("failed refresh keeps the known badge and offers retry (no false disconnect)", async () => {
    let statusCalls = 0
    mockFetch(async (url, init) => {
      const u = String(url)
      if (u.includes(`/api/users/${UUID_A}/trakt/status`)) {
        statusCalls++
        // First read links the profile; the post-disconnect re-read fails.
        if (statusCalls === 1) return statusRes(true, "connected")
        return { ok: false, status: 500, json: async () => ({ error: "x" }) }
      }
      if (u.includes(`/api/users/${UUID_A}/trakt/disconnect`) && init?.method === "DELETE") {
        return { ok: true, status: 200, json: async () => ({ ok: true, revoked: true }) }
      }
      throw new Error(`unexpected fetch ${u}`)
    })
    renderWithCtx(<TraktAccountSection />)
    expect(await screen.findByText("ui.traktConnected")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "ui.traktDisconnect" }))
    // Disconnect succeeded but the confirming re-read failed: the known
    // badge is kept (never a false "disconnected") with a retry action.
    // (The test i18n harness resolves ui.retry to "Riprova".)
    await waitFor(() => expect(screen.getByRole("button", { name: "Riprova" })).toBeInTheDocument())
    expect(screen.getByText("ui.traktConnected")).toBeInTheDocument()
    expect(screen.queryByText("ui.traktDisconnected")).toBeNull()
    expect(toast.success).toHaveBeenCalledWith("ui.traktDisconnectOk")
  })

  it("drops a stale connect completion after switching profile (no cross-profile navigation)", async () => {
    let resolveAuthorize!: (v: { ok: boolean; status: number; json: () => Promise<unknown> }) => void
    const authorizeGate = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((r) => {
      resolveAuthorize = r
    })
    mockFetch(async (url, init) => {
      const u = String(url)
      if (u.includes(`/api/users/${UUID_A}/trakt/status`)) return statusRes(true, "disconnected")
      if (u.includes(`/api/users/${UUID_B}/trakt/status`)) return statusRes(true, "disconnected")
      if (u.includes(`/api/users/${UUID_A}/trakt/authorize`) && init?.method === "POST") return authorizeGate
      throw new Error(`unexpected fetch ${u}`)
    })
    const externalRuns: Array<() => void> = []
    renderWithCtx(<TraktAccountSection onRequestExternalAction={(run) => externalRuns.push(run)} />)
    fireEvent.click(await screen.findByRole("button", { name: "ui.traktConnect" }))
    // Switch profile while A's authorize POST is still in flight.
    setStoredUserPassword(UUID_B, "space-password-2")
    setUrl(`/u/${UUID_B}/configure`)
    unlock(UUID_B)
    resolveAuthorize({
      ok: true,
      status: 200,
      json: async () => ({ authorizeUrl: "https://auth.trakt.tv/oauth/authorize?state=x", expiresIn: 600 }),
    })
    await new Promise((r) => setTimeout(r, 50))
    // A's late completion navigates nobody: the grant dies with the switch.
    expect(externalRuns).toHaveLength(0)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("drops a stale disconnect completion after switching profile (no wrong-profile toast)", async () => {
    let resolveDisconnect!: (v: { ok: boolean; status: number; json: () => Promise<unknown> }) => void
    const disconnectGate = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((r) => {
      resolveDisconnect = r
    })
    mockFetch(async (url, init) => {
      const u = String(url)
      if (u.includes(`/api/users/${UUID_A}/trakt/status`)) return statusRes(true, "connected")
      if (u.includes(`/api/users/${UUID_B}/trakt/status`)) return statusRes(true, "disconnected")
      if (u.includes(`/api/users/${UUID_A}/trakt/disconnect`) && init?.method === "DELETE") return disconnectGate
      throw new Error(`unexpected fetch ${u}`)
    })
    renderWithCtx(<TraktAccountSection />)
    fireEvent.click(await screen.findByRole("button", { name: "ui.traktDisconnect" }))
    // Switch profile while A's disconnect is still in flight.
    setStoredUserPassword(UUID_B, "space-password-2")
    setUrl(`/u/${UUID_B}/configure`)
    unlock(UUID_B)
    resolveDisconnect({ ok: true, status: 200, json: async () => ({ ok: true, revoked: true }) })
    await new Promise((r) => setTimeout(r, 50))
    // No toast for the abandoned profile; the section now serves B.
    expect(toast.success).not.toHaveBeenCalledWith("ui.traktDisconnectOk")
    expect(await screen.findByText("ui.traktDisconnected")).toBeInTheDocument()
  })
})
