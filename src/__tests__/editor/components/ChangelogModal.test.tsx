import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HomeStatusStrip } from "@/components/HomeStatusStrip"
import { ChangelogModal } from "@/components/ChangelogModal"
import { renderWithCtx } from "@/__tests__/test-utils"
import { CHANGELOG_SEEN_KEY, LATEST_CHANGELOG_VERSION, seenValue } from "@/data/changelog"

// Sezione auto sempre vuota qui (determinismo): il percorso non-vuoto è
// coperto da ChangelogRecent.test.tsx con modulo mockato.
vi.mock("@/generated/recent-changes", () => ({
  RECENT_CHANGES: [],
}))

function mockStatus(payload: unknown) {
  global.fetch = (async () => {
    return { ok: true, status: 200, json: async () => payload }
  }) as unknown as typeof fetch
}

const realFetch = global.fetch

beforeEach(() => {
  window.history.replaceState({}, "", "/")
  localStorage.clear()
  mockStatus({ multiUser: false })
})

afterEach(() => {
  global.fetch = realFetch
  localStorage.clear()
  vi.restoreAllMocks()
})

describe("ChangelogModal", () => {
  it("renders nothing when closed", () => {
    renderWithCtx(<ChangelogModal isOpen={false} onClose={() => {}} />)
    expect(screen.queryByTestId("changelog-list")).toBeNull()
  })

  it("renders releases with version badges and category tags when open", () => {
    renderWithCtx(<ChangelogModal isOpen={true} onClose={() => {}} />)
    expect(screen.getByTestId("changelog-list")).not.toBeNull()
    // Newest entry first, English body (body is intentionally not translated)
    expect(screen.getByText("v1.21")).not.toBeNull()
    expect(screen.getByText("Join the Discord community from the header links")).not.toBeNull()
    // Category labels go through i18n (it in test ctx)
    expect(screen.getAllByText("Novità").length).toBeGreaterThan(0)
  })

  it("closes via the Close button", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderWithCtx(<ChangelogModal isOpen={true} onClose={onClose} />)
    await user.click(screen.getByTestId("changelog-close"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe("HomeStatusStrip changelog dot", () => {
  it("shows the unread dot when never opened", async () => {
    renderWithCtx(<HomeStatusStrip />)
    await waitFor(() => expect(screen.getByTestId("changelog-dot")).not.toBeNull())
  })

  it("hides the dot when the latest version was already seen", async () => {
    localStorage.setItem(CHANGELOG_SEEN_KEY, LATEST_CHANGELOG_VERSION)
    renderWithCtx(<HomeStatusStrip />)
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId("changelog-dot")).toBeNull()
  })

  it("opens the modal on badge click and persists seen state on close", async () => {
    const user = userEvent.setup()
    renderWithCtx(<HomeStatusStrip />)
    await waitFor(() => expect(screen.getByTestId("changelog-open")).not.toBeNull())

    await user.click(screen.getByTestId("changelog-open"))
    expect(screen.getByTestId("changelog-list")).not.toBeNull()

    await user.click(screen.getByTestId("changelog-close"))
    await waitFor(() => expect(screen.queryByTestId("changelog-list")).toBeNull())
    expect(localStorage.getItem(CHANGELOG_SEEN_KEY)).toBe(seenValue())
    expect(screen.queryByTestId("changelog-dot")).toBeNull()
  })
})
