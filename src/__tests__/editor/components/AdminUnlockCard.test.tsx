import { beforeEach, describe, expect, it, vi, afterEach } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { AdminUnlockCard } from "@/components/AdminUnlockCard"
import { clearAdminToken, getAdminToken, setAdminToken } from "@/lib/admin-token"

const t = (k: string) => k

function stubCacheStatus(status: number) {
  const fetchMock = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => ({}) }))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

beforeEach(() => {
  clearAdminToken()
  try { window.sessionStorage.clear() } catch {}
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearAdminToken()
  try { window.sessionStorage.clear() } catch {}
})

describe("AdminUnlockCard", () => {
  it("clears a wrong token on 401 and stays locked", async () => {
    const onUnlocked = vi.fn()
    const fetchMock = stubCacheStatus(401)
    render(<AdminUnlockCard t={t} onUnlocked={onUnlocked} />)

    fireEvent.change(screen.getByPlaceholderText("ui.adminTokenPlaceholder"), { target: { value: "wrong" } })
    fireEvent.click(screen.getByRole("button", { name: "ui.adminTokenUnlock" }))
    await screen.findByText("ui.adminTokenNotSet")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit?]
    expect(url).toContain("/api/cache/status")
    expect((init?.headers as Record<string, string>)["x-admin-token"]).toBe("wrong")
    expect(getAdminToken()).toBeNull()
    expect(onUnlocked).not.toHaveBeenCalled()
  })

  it("saves the token only after a verified 200 and notifies", async () => {
    const onUnlocked = vi.fn()
    stubCacheStatus(200)
    render(<AdminUnlockCard t={t} onUnlocked={onUnlocked} />)

    fireEvent.change(screen.getByPlaceholderText("ui.adminTokenPlaceholder"), { target: { value: "s3cr3t" } })
    fireEvent.click(screen.getByRole("button", { name: "ui.adminTokenUnlock" }))
    await screen.findByText("ui.adminTokenActive")

    expect(getAdminToken()).toBe("s3cr3t")
    expect(onUnlocked).toHaveBeenCalledTimes(1)
  })

  it("lock button forgets the token and notifies", async () => {
    const onLock = vi.fn()
    setAdminToken("s3cr3t")
    render(<AdminUnlockCard t={t} onLock={onLock} />)

    expect(await screen.findByText("ui.adminTokenActive")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "ui.adminTokenLock" }))
    expect(await screen.findByText("ui.adminTokenNotSet")).toBeInTheDocument()
    expect(getAdminToken()).toBeNull()
    expect(onLock).toHaveBeenCalledTimes(1)
  })
})
