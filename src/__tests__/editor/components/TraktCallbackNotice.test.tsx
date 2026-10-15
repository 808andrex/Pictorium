import { beforeEach, describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import { TraktCallbackNotice } from "@/components/TraktCallbackNotice"
import { renderWithCtx } from "@/__tests__/test-utils"
import { consumeSettingsTab } from "@/lib/settings-tab"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

import { toast } from "sonner"

function setLocation(url: string): void {
  window.history.replaceState({}, "", url)
}

beforeEach(() => {
  vi.clearAllMocks()
  setLocation("/")
  // Drain any pending tab request from a previous test.
  consumeSettingsTab()
})

describe("TraktCallbackNotice", () => {
  it("connected: toasts, cleans only the trakt param, opens the Space panel", async () => {
    const setSettingsOpen = vi.fn()
    setLocation("/?trakt=connected&foo=bar#hash")
    renderWithCtx(<TraktCallbackNotice />, { setSettingsOpen })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("ui.traktCallbackConnected"))
    expect(window.location.search).toBe("?foo=bar")
    expect(window.location.hash).toBe("#hash")
    expect(consumeSettingsTab()).toBe("spazio")
    expect(setSettingsOpen).toHaveBeenCalledWith(true)
  })

  it("denied: error toast, param removed, Space panel opened", async () => {
    const setSettingsOpen = vi.fn()
    setLocation("/u/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/configure?trakt=denied")
    renderWithCtx(<TraktCallbackNotice />, { setSettingsOpen })
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("ui.traktCallbackDenied"))
    expect(window.location.search).toBe("")
    // Never navigates away from the owning profile path.
    expect(window.location.pathname).toBe("/u/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/configure")
    expect(consumeSettingsTab()).toBe("spazio")
    expect(setSettingsOpen).toHaveBeenCalledWith(true)
  })

  it("failed: error toast and cleanup", async () => {
    const setSettingsOpen = vi.fn()
    setLocation("/?trakt=failed")
    renderWithCtx(<TraktCallbackNotice />, { setSettingsOpen })
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("ui.traktCallbackFailed"))
    expect(window.location.search).toBe("")
    expect(setSettingsOpen).toHaveBeenCalledWith(true)
  })

  it("connected on the initiating profile page: toasts, cleans only the param, stays on the profile", async () => {
    const setSettingsOpen = vi.fn()
    const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    setLocation(`/u/${uuid}/configure?trakt=connected`)
    renderWithCtx(<TraktCallbackNotice />, { setSettingsOpen })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("ui.traktCallbackConnected"))
    expect(window.location.search).toBe("")
    // The correct profile remains accessible: no navigation away, profile
    // path intact, Space panel opened for the connection state.
    expect(window.location.pathname).toBe(`/u/${uuid}/configure`)
    expect(consumeSettingsTab()).toBe("spazio")
    expect(setSettingsOpen).toHaveBeenCalledWith(true)
  })

  it("failed on the initiating profile page: error toast, profile path kept", async () => {
    const setSettingsOpen = vi.fn()
    const uuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    setLocation(`/u/${uuid}/configure?trakt=failed&foo=bar`)
    renderWithCtx(<TraktCallbackNotice />, { setSettingsOpen })
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("ui.traktCallbackFailed"))
    expect(window.location.search).toBe("?foo=bar")
    expect(window.location.pathname).toBe(`/u/${uuid}/configure`)
    expect(setSettingsOpen).toHaveBeenCalledWith(true)
  })

  it("ignores arbitrary trakt values: no toast, param kept, panel untouched", async () => {
    const setSettingsOpen = vi.fn()
    setLocation("/?trakt=evil")
    renderWithCtx(<TraktCallbackNotice />, { setSettingsOpen })
    await new Promise((r) => setTimeout(r, 50))
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(window.location.search).toBe("?trakt=evil")
    expect(consumeSettingsTab()).toBeNull()
    expect(setSettingsOpen).not.toHaveBeenCalled()
    expect(screen.queryByText(/.+/)).toBeNull()
  })

  it("does nothing without the param", async () => {
    const setSettingsOpen = vi.fn()
    setLocation("/?foo=bar")
    renderWithCtx(<TraktCallbackNotice />, { setSettingsOpen })
    await new Promise((r) => setTimeout(r, 50))
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(window.location.search).toBe("?foo=bar")
    expect(setSettingsOpen).not.toHaveBeenCalled()
  })
})
