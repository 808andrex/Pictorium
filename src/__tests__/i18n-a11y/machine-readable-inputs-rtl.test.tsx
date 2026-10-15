/**
 * Hebrew RTL regression for machine-readable inputs: URL / API-key / token
 * fields must stay LTR (dir="ltr") even when the document direction is RTL,
 * in both password and revealed-text modes, with exact values preserved.
 * Representative coverage for the global audit (CustomPosterUrl, catalog and
 * proxy/addon URL fields, key rows, unlock/space/status/admin inputs, PIN
 * inputs all carry the same static dir="ltr" pin — verified by typecheck and
 * per-file assertions below for the shared mechanism plus key/URL cases).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
// Opt out of the global @/lib/i18n mock: this file asserts the real setLang
// document side effects, which the mock replaces with vi.fn().
vi.unmock("@/lib/i18n")

import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { SecretInput } from "@/components/ui/SecretInput"
import { AdminUnlockCard } from "@/components/AdminUnlockCard"
import { CustomCatalogModal } from "@/components/CustomCatalogModal"
import { renderWithCtx } from "@/__tests__/test-utils"
import { setLang } from "@/lib/i18n"

const API_KEY = "tmdb_ABC123xyz7890KEY"
const LIST_URL = "https://letterboxd.com/user/list/my-list-123/"

function SecretHarness({ initial = API_KEY }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return <SecretInput label="TMDB" icon={<span />} value={value} onChange={setValue} />
}

describe("machine-readable inputs stay LTR under Hebrew RTL", () => {
  beforeEach(() => {
    setLang("he")
    expect(document.documentElement.dir).toBe("rtl")
  })

  afterEach(() => {
    setLang("it")
  })

  it("shared SecretInput keeps an API key LTR in password and revealed-text modes", () => {
    render(<SecretHarness />)
    const input = screen.getByDisplayValue(API_KEY) as HTMLInputElement
    expect(input.getAttribute("dir")).toBe("ltr")
    expect(input.type).toBe("password")

    // Reveal (type flips to text): direction pin and exact value survive.
    fireEvent.click(screen.getByRole("button", { name: "Show password" }))
    expect(input.type).toBe("text")
    expect(input.getAttribute("dir")).toBe("ltr")
    expect(input.value).toBe(API_KEY)

    // Typing more key material preserves the exact value under RTL document.
    fireEvent.change(input, { target: { value: `${API_KEY}9` } })
    expect(input.value).toBe(`${API_KEY}9`)
    expect(input.getAttribute("dir")).toBe("ltr")
  })

  it("admin token input keeps the typed token LTR under Hebrew RTL", () => {
    render(<AdminUnlockCard t={(k: string) => k} />)
    const input = screen.getByPlaceholderText("ui.adminTokenPlaceholder") as HTMLInputElement
    expect(input.getAttribute("dir")).toBe("ltr")
    fireEvent.change(input, { target: { value: "s3cr3t-admin-token" } })
    expect(input.value).toBe("s3cr3t-admin-token")
    expect(input.getAttribute("dir")).toBe("ltr")
  })

  it("custom catalog list URL keeps the exact URL LTR in Hebrew and after switching back", () => {
    const t = (k: string) => k
    const { unmount } = renderWithCtx(<CustomCatalogModal isOpen={true} onClose={vi.fn()} />, { t })
    const input = screen.getByPlaceholderText("ui.customUrlPh") as HTMLInputElement
    expect(input.getAttribute("dir")).toBe("ltr")
    fireEvent.change(input, { target: { value: LIST_URL } })
    // Exact bytes preserved: no bidi reordering, no translation interference.
    expect(input.value).toBe(LIST_URL)
    expect(input.getAttribute("dir")).toBe("ltr")
    unmount()

    // Switching back to Italian: document returns to LTR, URL field unchanged.
    setLang("it")
    expect(document.documentElement.dir).toBe("ltr")
    renderWithCtx(<CustomCatalogModal isOpen={true} onClose={vi.fn()} />, { t })
    const inputIt = screen.getByPlaceholderText("ui.customUrlPh") as HTMLInputElement
    fireEvent.change(inputIt, { target: { value: LIST_URL } })
    expect(inputIt.value).toBe(LIST_URL)
    expect(inputIt.getAttribute("dir")).toBe("ltr")
  })
})
