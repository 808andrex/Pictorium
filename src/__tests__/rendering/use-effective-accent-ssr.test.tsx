/**
 * useEffectiveAccent SSR (correction 2, client sync).
 *
 * `"use client"` does NOT exclude server rendering: Next.js still renders
 * client components on the server during initial page generation (installed
 * Next.js docs glossary, "Client Components"). React therefore requires the
 * third `useSyncExternalStore` argument — omitting `getServerSnapshot` makes
 * `renderToString` throw `Missing getServerSnapshot` (React docs,
 * `useSyncExternalStore` reference: "If you omit this argument, rendering the
 * component on the server will throw an error").
 *
 * The server snapshot MUST be a stable unknown constant (no URL, no metadata,
 * generation zero) — NEVER the mutable module `current` / seeded client
 * record (cross-request data + hydration mismatch).
 */
import { beforeEach, describe, expect, it } from "vitest"
import { renderToString } from "react-dom/server"
import { renderHook } from "@testing-library/react"
import {
  __resetEffectiveAccentDisplayForTests,
  publishEffectiveAccentDisplay,
} from "@/lib/effective-accent-display"
import { useEffectiveAccent } from "@/lib/useEffectiveAccent"
import type { EffectiveAccentMeta } from "@/lib/effective-accent"

const PREVIEW =
  "https://pictorium.test/api/poster/movie/1?preview=1&shape=poster"

const META: EffectiveAccentMeta = {
  genreHex: "#1f7a8c",
  rankHex: "#f2c14e",
  genrePaints: true,
  topPaints: true,
  topType: "extra",
  provGenre: "extracted",
  provRank: "extracted",
}

function SsrProbe({ url, enabled }: { url: string; enabled?: boolean }) {
  const state = useEffectiveAccent(url, enabled)
  return (
    <div data-status={state.status} data-hex={state.meta?.genreHex ?? ""}>
      {state.status}
    </div>
  )
}

beforeEach(() => {
  __resetEffectiveAccentDisplayForTests()
})

describe("useEffectiveAccent SSR (actual hook, renderToString)", () => {
  it("server-renders an honest placeholder while the client store is seeded ready (no hex/source leak)", () => {
    publishEffectiveAccentDisplay({ status: "ready", meta: META, previewUrl: PREVIEW, generation: 7 })
    const html = renderToString(<SsrProbe url={PREVIEW} />)
    // No client metadata may leak into server HTML: neither hex, and the
    // server snapshot itself carries no source URL.
    expect(html).not.toContain(META.genreHex!)
    expect(html).not.toContain(META.rankHex!)
    expect(html).not.toContain(PREVIEW)
    expect(html).not.toContain("ready")
    // Honest placeholder only: the seeded generation is still pending from
    // the server's point of view (never shown as painted).
    expect(html).toContain("loading")
  })

  it("server snapshot is a stable constant: reseeded client records never change SSR output", () => {
    publishEffectiveAccentDisplay({ status: "ready", meta: META, previewUrl: PREVIEW, generation: 7 })
    const first = renderToString(<SsrProbe url={PREVIEW} />)
    publishEffectiveAccentDisplay({
      status: "ready",
      meta: { ...META, genreHex: "#ffffff", rankHex: "#000000" },
      previewUrl: PREVIEW,
      generation: 8,
    })
    const second = renderToString(<SsrProbe url={PREVIEW} />)
    expect(second).toBe(first)
    expect(second).not.toContain("#ffffff")
  })

  it("server-renders unknown for an empty URL or a disabled consumer", () => {
    publishEffectiveAccentDisplay({ status: "ready", meta: META, previewUrl: PREVIEW, generation: 7 })
    expect(renderToString(<SsrProbe url="" />)).toContain("unknown")
    expect(renderToString(<SsrProbe url={PREVIEW} enabled={false} />)).toContain("unknown")
  })

  it("client mount after SSR resolves the seeded record immediately (no timers, existing React pattern)", () => {
    publishEffectiveAccentDisplay({ status: "ready", meta: META, previewUrl: PREVIEW, generation: 7 })
    const { result } = renderHook(() => useEffectiveAccent(PREVIEW, true))
    expect(result.current.status).toBe("ready")
    expect(result.current.meta).toEqual(META)
  })
})
