/**
 * useEffectiveAccent (client, header transport): pure display selector over
 * the record published by `usePosterPreview` from the `X-Pictorium-Accent`
 * response header of the SAME image bytes. No fetch, no timers, no retries —
 * zero dedicated JSON traffic in the normal flow. No canonical writes, URL
 * identity gating, stale-gated.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import {
  __resetEffectiveAccentDisplayForTests,
  publishEffectiveAccentDisplay,
} from "@/lib/effective-accent-display"
import {
  resolveAccentPickerDisplay,
  useEffectiveAccent,
} from "@/lib/useEffectiveAccent"
import type { EffectiveAccentMeta } from "@/lib/effective-accent"

const PREVIEW =
  "https://pictorium.test/api/poster/movie/1?rv=e6889605bb&preview=1&bs=colored&rs=default&ts=80&bd=30&be=1&shape=poster&config=abc&api_key=secret"

const META: EffectiveAccentMeta = {
  genreHex: "#1f7a8c",
  rankHex: "#f2c14e",
  genrePaints: true,
  topPaints: true,
  topType: "extra",
  provGenre: "extracted",
  provRank: "extracted",
}

beforeEach(() => {
  __resetEffectiveAccentDisplayForTests()
  vi.unstubAllGlobals()
})

describe("useEffectiveAccent (header record selector)", () => {
  it("does not fetch without a URL, or when disabled (thumbnails stay silent)", () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const { result: empty } = renderHook(() => useEffectiveAccent("", true))
    expect(empty.current.status).toBe("unknown")
    const { result: off } = renderHook(() => useEffectiveAccent(PREVIEW, false))
    expect(off.current.status).toBe("unknown")
    // Zero dedicated JSON traffic: the selector never fetches.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("resolves ready metadata published for the exact preview URL", () => {
    const { result, rerender } = renderHook(() => useEffectiveAccent(PREVIEW, true))
    // No record yet for this URL: loading (never a stale hex, never the base).
    expect(result.current.status).toBe("loading")
    expect(result.current.meta).toBeNull()
    publishEffectiveAccentDisplay({ status: "ready", meta: META, previewUrl: PREVIEW, generation: 1 })
    rerender()
    expect(result.current.status).toBe("ready")
    expect(result.current.meta).toEqual(META)
  })

  it("treats a record for another URL as loading (stale can never claim the new preview)", () => {
    publishEffectiveAccentDisplay({ status: "ready", meta: META, previewUrl: `${PREVIEW}&ts=20`, generation: 1 })
    const { result } = renderHook(() => useEffectiveAccent(PREVIEW, true))
    expect(result.current.status).toBe("loading")
    expect(result.current.meta).toBeNull()
  })

  it("resolves unknown for failure/timeout/legacy records (honest placeholder)", () => {
    publishEffectiveAccentDisplay({ status: "unknown", meta: null, previewUrl: PREVIEW, generation: 2 })
    const { result } = renderHook(() => useEffectiveAccent(PREVIEW, true))
    expect(result.current.status).toBe("unknown")
    expect(result.current.meta).toBeNull()
  })

  it("clears the old hex immediately on URL change (identity gating during render)", () => {
    publishEffectiveAccentDisplay({ status: "ready", meta: META, previewUrl: PREVIEW, generation: 1 })
    const other = `${PREVIEW}&ts=20`
    const { result, rerender } = renderHook(({ url }: { url: string }) => useEffectiveAccent(url, true), {
      initialProps: { url: PREVIEW },
    })
    expect(result.current.meta).toEqual(META)
    rerender({ url: other })
    // The old hex disappears with the URL change itself, before any publish.
    expect(result.current.meta).toBeNull()
    expect(result.current.status).toBe("loading")
    // The new generation lands with its own bytes + header: latest wins.
    const second = { ...META, genreHex: "#222222" } as EffectiveAccentMeta
    publishEffectiveAccentDisplay({ status: "ready", meta: second, previewUrl: other, generation: 2 })
    rerender({ url: other })
    expect(result.current.meta?.genreHex).toBe("#222222")
  })

  it("keeps a late record for the previous URL from overwriting the new preview", () => {
    const other = `${PREVIEW}&ts=20`
    const { result, rerender } = renderHook(({ url }: { url: string }) => useEffectiveAccent(url, true), {
      initialProps: { url: other },
    })
    // Stale publish for the old URL arrives late: the new preview stays loading.
    publishEffectiveAccentDisplay({ status: "ready", meta: META, previewUrl: PREVIEW, generation: 1 })
    rerender({ url: other })
    expect(result.current.status).toBe("loading")
    expect(result.current.meta).toBeNull()
  })
})

describe("resolveAccentPickerDisplay", () => {
  it("prefers bottom by locality, falls back to top, never merges", () => {
    expect(resolveAccentPickerDisplay(META).pickerHex).toBe(META.genreHex)
    expect(resolveAccentPickerDisplay({ ...META, genrePaints: false, genreHex: null }).pickerHex).toBe(
      META.rankHex,
    )
    expect(
      resolveAccentPickerDisplay({ ...META, genrePaints: false, genreHex: null, topPaints: false, rankHex: null })
        .pickerHex,
    ).toBeNull()
    expect(resolveAccentPickerDisplay(null).pickerHex).toBeNull()
  })
})
