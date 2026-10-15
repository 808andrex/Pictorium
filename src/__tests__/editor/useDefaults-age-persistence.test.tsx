/**
 * Regression: age defaults must survive the auto-persist path.
 *
 * `defaultsToPayload` (src/lib/useDefaults.ts) dropped `ageBadge`/`ageCountry`
 * while the read path (`buildFromStored`), the manual `saveDefaults` payload
 * and the `/api/defaults` schema all carry them: toggling the age badge (or
 * its country) wrote a payload without those keys, so the next unrelated
 * edit overwrote localStorage + server state and the choice was lost.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useDefaults } from "@/lib/useDefaults"
import { shouldSkipServerSync } from "@/lib/guest-guard"

vi.mock("@/lib/guest-guard", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/guest-guard")>()
  return { ...mod, shouldSkipServerSync: vi.fn(async () => false) }
})

function createStorageStub() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v))
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
    clear: () => {
      store.clear()
    },
  }
}

type StorageStub = ReturnType<typeof createStorageStub>

describe("useDefaults age persistence", () => {
  let putBodies: Record<string, unknown>[]
  let storage: StorageStub

  beforeEach(() => {
    storage = createStorageStub()
    vi.stubGlobal("localStorage", storage)
    putBodies = []
    vi.useFakeTimers()
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { method?: string; body?: string }) => {
        if (init?.method === "PUT") {
          putBodies.push(JSON.parse(init.body as string))
          return { ok: true, status: 200, json: async () => ({}) }
        }
        // Hydration GET: empty server state, local storage wins the merge.
        return { ok: true, status: 200, json: async () => ({}) }
      }),
    )
    vi.mocked(shouldSkipServerSync).mockResolvedValue(false)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  async function settle() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
    })
  }

  it("age toggle + country land in localStorage AND the debounced PUT body", async () => {
    const { result } = renderHook(() => useDefaults())
    await settle()
    expect(putBodies).toEqual([])

    act(() => {
      result.current.update({ defaultAgeBadge: true, defaultAgeCountry: "US" })
    })
    // Synchronous local write carries both keys before the debounce fires.
    const stored = JSON.parse(storage.getItem("badgeDefaults")!) as Record<string, unknown>
    expect(stored.ageBadge).toBe(true)
    expect(stored.ageCountry).toBe("US")
    expect(putBodies).toEqual([])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(putBodies).toHaveLength(1)
    expect(putBodies[0].ageBadge).toBe(true)
    expect(putBodies[0].ageCountry).toBe("US")
    expect(result.current.defaultSyncStatus).toBe("synced")
  })

  it("an unrelated edit does not drop previously saved age fields", async () => {
    storage.setItem("badgeDefaults", JSON.stringify({ ageBadge: true, ageCountry: "FR" }))
    const { result } = renderHook(() => useDefaults())
    await settle()
    expect(result.current.defaultAgeBadge).toBe(true)
    expect(result.current.defaultAgeCountry).toBe("FR")
    expect(putBodies).toEqual([])

    act(() => {
      result.current.update({ defaultBadgeYear: false })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(putBodies).toHaveLength(1)
    expect(putBodies[0].ageBadge).toBe(true)
    expect(putBodies[0].ageCountry).toBe("FR")
    const stored = JSON.parse(storage.getItem("badgeDefaults")!) as Record<string, unknown>
    expect(stored.ageBadge).toBe(true)
    expect(stored.ageCountry).toBe("FR")
  })

  it("reload roundtrip retains ON + non-IT selections", async () => {
    storage.setItem("badgeDefaults", JSON.stringify({ ageBadge: true, ageCountry: "US" }))
    const { result } = renderHook(() => useDefaults())
    await settle()
    expect(result.current.defaultAgeBadge).toBe(true)
    expect(result.current.defaultAgeCountry).toBe("US")
  })

  it("reload roundtrip retains OFF + non-IT selections", async () => {
    storage.setItem("badgeDefaults", JSON.stringify({ ageBadge: false, ageCountry: "DE" }))
    const { result } = renderHook(() => useDefaults())
    await settle()
    expect(result.current.defaultAgeBadge).toBe(false)
    expect(result.current.defaultAgeCountry).toBe("DE")
  })

  it("legacy payloads without age keys hydrate OFF/IT and keep them on the next edit", async () => {
    storage.setItem("badgeDefaults", JSON.stringify({ defaultBadgeYear: false }))
    const { result } = renderHook(() => useDefaults())
    await settle()
    expect(result.current.defaultAgeBadge).toBe(false)
    expect(result.current.defaultAgeCountry).toBe("IT")

    act(() => {
      result.current.update({ defaultGradientHeight: 31 })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(putBodies).toHaveLength(1)
    expect(putBodies[0].ageBadge).toBe(false)
    expect(putBodies[0].ageCountry).toBe("IT")
    const stored = JSON.parse(storage.getItem("badgeDefaults")!) as Record<string, unknown>
    expect(stored.ageBadge).toBe(false)
    expect(stored.ageCountry).toBe("IT")
  })
})
