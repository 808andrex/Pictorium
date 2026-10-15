import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import { UserKeysSection } from "@/components/UserKeysSection"
import { RatingSourceIcon } from "@/components/RatingSourceIcon"
import { renderWithCtx } from "@/__tests__/test-utils"
import {
  __resetUnlockedUsersForTests,
  __resetUserCredentialsForTests,
  setStoredUserPassword,
  USER_UNLOCK_EVENT,
} from "@/lib/user-token"

const UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

function setUrl(url: string): void {
  window.history.replaceState({}, "", url)
}

function installStorages(): void {
  const mem = (store: Record<string, string>) => ({
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = String(v)
    },
    removeItem: (k: string) => {
      delete store[k]
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k]
    },
  })
  Object.defineProperty(window, "localStorage", { value: mem({}), configurable: true })
}

function unlock() {
  window.dispatchEvent(new CustomEvent(USER_UNLOCK_EVENT, { detail: { uuid: UUID } }))
}

const realFetch = global.fetch

function stubKeysFetch() {
  global.fetch = (async (url: unknown) => {
    const u = String(url)
    if (u.includes(`/api/users/${UUID}/keys`)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ tmdb: false, mdblist: false, tvdb: false, simkl: false, fanart: false }),
      }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

beforeEach(() => {
  installStorages()
  __resetUnlockedUsersForTests()
  __resetUserCredentialsForTests()
  setUrl(`/u/${UUID}/configure`)
  setStoredUserPassword(UUID, "my-valid-password")
  unlock()
  stubKeysFetch()
})

afterEach(() => {
  global.fetch = realFetch
  __resetUnlockedUsersForTests()
  __resetUserCredentialsForTests()
  setUrl("/")
  vi.restoreAllMocks()
})

describe("Space provider logos", () => {
  it("keeps visible plaintext labels above inputs and logos left of inputs on the same row", async () => {
    renderWithCtx(<UserKeysSection />)

    await waitFor(() => {
      expect(document.querySelectorAll("input")).toHaveLength(5)
    })

    // Plaintext provider labels (with genuine credential type) stay visible.
    const labels = ["TMDB", "MDBList", "TVDB", "Simkl Client ID", "Fanart.tv Project Key"]
    for (const text of labels) {
      const el = screen.getByText(text)
      expect(el.tagName).toBe("LABEL")
      // No duplicate: exactly one visible occurrence (no header logo duplicate).
      expect(screen.getAllByText(text)).toHaveLength(1)
    }

    // Brand SVG assets left of the input, same flex row, bounded geometry.
    const expectedSrc: Record<string, string> = {
      tmdb: "/rating/tmdb.svg",
      mdblist: "/rating/mdblist.svg",
      tvdb: "/rating/tvdb.svg",
      simkl: "/rating/simkl.svg",
      fanart: "/rating/art.svg",
    }
    for (const [kind, src] of Object.entries(expectedSrc)) {
      const img = document.querySelector(`img[src="${src}"]`)
      expect(img, `logo img for ${kind}`).not.toBeNull()
      expect(img!.className).toMatch(/h-5/)
      expect(img!.className).toMatch(/object-contain/)
      expect(img!.className).toMatch(/max-w-10/)
      expect(img!.className).not.toMatch(/filter|grayscale|hue-rotate|invert/)
      // Tooltip with the full brand name.
      expect(img!.closest("span[title]")?.getAttribute("title")).toBeTruthy()
      // Logo sits in the same row container as the input (left of it).
      const row = img!.closest("div.flex.flex-nowrap")
      expect(row, `logo+input row for ${kind}`).not.toBeNull()
      expect(row!.querySelector("input")).not.toBeNull()
      // Logo precedes the input in DOM order (left of input in LTR).
      const children = Array.from(row!.children)
      const logoIdx = children.findIndex((c) => c.contains(img))
      const inputIdx = children.findIndex((c) => c.tagName === "INPUT")
      expect(logoIdx).toBeGreaterThanOrEqual(0)
      expect(inputIdx).toBeGreaterThan(logoIdx)
    }
  })

  it("has no Trakt row in Space (asset ready, no invented integration)", async () => {
    renderWithCtx(<UserKeysSection />)

    await waitFor(() => {
      expect(document.querySelectorAll("input")).toHaveLength(5)
    })

    expect(document.querySelector('img[src="/rating/trakt.svg"]')).toBeNull()
    expect(screen.queryByText("Trakt")).toBeNull()
    // Recovery key / UUID labels are not providers: they keep text, untouched.
    expect(document.querySelectorAll("input")).toHaveLength(5)
  })

  it("associates every key input with its text label (htmlFor) and keeps LTR/auth behavior", async () => {
    renderWithCtx(<UserKeysSection />)

    await waitFor(() => {
      expect(document.querySelectorAll("input")).toHaveLength(5)
    })

    const labels = Array.from(document.querySelectorAll("label"))
    expect(labels).toHaveLength(5)
    for (const label of labels) {
      const forId = label.getAttribute("for")
      expect(forId, "label htmlFor").toBeTruthy()
      const input = forId ? document.getElementById(forId) : null
      expect(input?.tagName).toBe("INPUT")
      // Latin machine string stays LTR in both modes.
      expect(input?.getAttribute("dir")).toBe("ltr")
    }
    // Action buttons per row + save: verify/show/copy/deactivate unchanged.
    expect(screen.getAllByRole("button", { name: "ui.verifyKey" })).toHaveLength(5)
    expect(screen.getAllByRole("button", { name: "ui.showKey" })).toHaveLength(5)
    expect(screen.getByRole("button", { name: "ui.save" })).toBeInTheDocument()
  })

  it("RatingSourceIcon maps tvdb/fanart assets and keeps trakt intact", () => {
    const { unmount: u1 } = renderWithCtx(<RatingSourceIcon id="tvdb" />)
    expect(document.querySelector('img[src="/rating/tvdb.svg"]')).not.toBeNull()
    u1()
    const { unmount: u2 } = renderWithCtx(<RatingSourceIcon id="fanart" />)
    expect(document.querySelector('img[src="/rating/art.svg"]')).not.toBeNull()
    u2()
    renderWithCtx(<RatingSourceIcon id="trakt" />)
    expect(document.querySelector('img[src="/rating/trakt.svg"]')).not.toBeNull()
  })
})
