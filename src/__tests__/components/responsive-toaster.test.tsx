import { afterEach, describe, expect, it, vi } from "vitest"
import { render, act } from "@testing-library/react"
import { toast } from "sonner"
import { ResponsiveToaster } from "@/components/ResponsiveToaster"

// Breakpoint regression: every desktop toast bottom-right, mobile keeps the
// global top-center contract (canonical lg boundary, same query as
// usePosterSave.saveSuccessToastPosition and the globals.css mobile offset).
// Sonner renders each position section only once a toast fires, so every case
// fires a real toast and asserts the section it lands in.
describe("ResponsiveToaster position (desktop bottom-right, mobile top-center)", () => {
  const realMatchMedia = window.matchMedia
  let matches = false
  const listeners = new Set<() => void>()

  function stubViewport(isMobile: boolean) {
    matches = isMobile
    listeners.clear()
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn(() => ({
        get matches() {
          return matches
        },
        media: "(max-width: 1023.5px)",
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: (_: string, cb: () => void) => {
          listeners.add(cb)
        },
        removeEventListener: (_event: string, cb: () => void) => {
          listeners.delete(cb)
        },
        dispatchEvent: () => false,
      })),
    })
  }

  function section(x: string, y: string) {
    return document.querySelector(
      `[data-sonner-toaster][data-x-position="${x}"][data-y-position="${y}"] [data-sonner-toast]`,
    )
  }

  afterEach(async () => {
    await act(async () => {
      toast.dismiss()
    })
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: realMatchMedia,
    })
    vi.restoreAllMocks()
  })

  it("desktop (>=1024): fired toast lands bottom-right", async () => {
    stubViewport(false)
    const ui = render(<ResponsiveToaster />)
    await act(async () => {
      toast.success("desktop check", { duration: 30_000 })
    })
    await vi.waitFor(() => expect(section("right", "bottom")).not.toBeNull())
    expect(section("center", "top")).toBeNull()
    ui.unmount()
  })

  it("mobile/tablet (<1024): fired toast stays top-center", async () => {
    stubViewport(true)
    const ui = render(<ResponsiveToaster />)
    await act(async () => {
      toast.success("mobile check", { duration: 30_000 })
    })
    await vi.waitFor(() => expect(section("center", "top")).not.toBeNull())
    expect(section("right", "bottom")).toBeNull()
    ui.unmount()
  })

  it("viewport crossing lg moves new toasts to the new section live", async () => {
    stubViewport(false)
    const ui = render(<ResponsiveToaster />)
    await act(async () => {
      toast.success("before crossing", { duration: 30_000 })
    })
    await vi.waitFor(() => expect(section("right", "bottom")).not.toBeNull())
    await act(async () => {
      matches = true
      listeners.forEach((cb) => cb())
    })
    await act(async () => {
      toast.success("after crossing", { duration: 30_000 })
    })
    await vi.waitFor(() => expect(section("center", "top")).not.toBeNull())
    ui.unmount()
  })

  it("unmount removes the media-query listener (no leak)", () => {
    stubViewport(false)
    expect(listeners.size).toBe(0)
    const ui = render(<ResponsiveToaster />)
    expect(listeners.size).toBe(1)
    ui.unmount()
    expect(listeners.size).toBe(0)
  })
})
