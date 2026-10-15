import { beforeEach, describe, expect, it, vi } from "vitest"
import { __resetTvdbBreaker, getTvdbMovieId, isTvdbBreakerOpen } from "@/lib/tvdb"

beforeEach(() => {
  __resetTvdbBreaker()
  vi.restoreAllMocks()
})

describe("TVDB external abort", () => {
  it("pre-aborted signal returns null without fetch and without tripping the breaker", async () => {
    const spy = vi.spyOn(globalThis, "fetch")
    const ctrl = new AbortController()
    ctrl.abort()
    const res = await getTvdbMovieId("tt9998881", "key-signal-test", ctrl.signal)
    expect(res).toBeNull()
    expect(spy).not.toHaveBeenCalled()
    expect(isTvdbBreakerOpen()).toBe(false)
  })

  it("without signal a network error still fails open (no throw)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"))
    const res = await getTvdbMovieId("tt9998882", "key-signal-test-2")
    expect(res).toBeNull()
  })
})
