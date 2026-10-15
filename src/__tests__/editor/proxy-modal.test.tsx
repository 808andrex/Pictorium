import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ProxyModal } from "@/components/ProxyModal"
import * as userToken from "@/lib/user-token"

vi.mock("@/lib/contexts/TranslationContext", () => ({
  useT: () => ({ t: (k: string) => k }),
}))

describe("ProxyModal", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("generates proxy URL without user token when outside user space", () => {
    vi.spyOn(userToken, "currentPathUuid").mockReturnValue(null)

    render(<ProxyModal isOpen={true} onClose={() => {}} />)
    const presetBtn = screen.getByText("Cinemeta")
    fireEvent.click(presetBtn)

    const generated = screen.getByText(/api\/proxy\/manifest\.json/)
    expect(generated.textContent).toContain("/api/proxy/manifest.json?url=")
    expect(generated.textContent).not.toContain("&u=")
  })

  it("generates proxy URL with &u= when inside user space", () => {
    vi.spyOn(userToken, "currentPathUuid").mockReturnValue("abcd-1234-uuid")

    render(<ProxyModal isOpen={true} onClose={() => {}} />)
    const presetBtn = screen.getByText("Cinemeta")
    fireEvent.click(presetBtn)

    const generated = screen.getByText(/api\/proxy\/manifest\.json/)
    expect(generated.textContent).toContain("&u=abcd-1234-uuid")
  })
})
