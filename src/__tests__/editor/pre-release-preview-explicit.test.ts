/**
 * Pre-digital (`pre`) explicit-false parity.
 *
 * Regression: disabling the pre-digital effect ("effetto pre-digitale") left
 * the Coming Soon band in the client preview while the Stremio/test URL was
 * correct. Root cause: preview builders emitted `pre=1` only when ON and
 * omitted the param when OFF, so the shared renderer inherited a saved-ON
 * default (`query > config > defaults > false`) instead of the staged OFF.
 * Every sibling toggle (badges/ranking/cr/sep/ribbon/...) is always explicit
 * in preview URLs — `pre` was the only exception.
 */
import { describe, expect, it } from "vitest"
import { buildDefaultsPreviewUrl, buildPreviewUrl } from "@/lib/poster-url"
import { resolvePosterRenderConfig, type PosterRenderConfigInput } from "@/lib/poster-config"
import type { ServerDefaults } from "@/lib/server-defaults"
import { buildStremioPosterSearchParams } from "@/lib/stremio-poster-params"

describe("pre-digital preview explicit false (Coming Soon parity)", () => {
  it("buildPreviewUrl emits pre=0 when the effect is off (not omitted)", () => {
    const ps = { selected: { id: 1 } } as never
    const off = new URL(buildPreviewUrl(ps, { preRelease: false } as never))
    expect(off.searchParams.get("pre")).toBe("0")
    const on = new URL(buildPreviewUrl(ps, { preRelease: true } as never))
    expect(on.searchParams.get("pre")).toBe("1")
  })

  it("buildDefaultsPreviewUrl carries the staged default (off, on, landscape profile)", () => {
    const off = new URL(buildDefaultsPreviewUrl({}))
    expect(off.searchParams.get("pre")).toBe("0")
    const on = new URL(buildDefaultsPreviewUrl({ defaultPreRelease: true }))
    expect(on.searchParams.get("pre")).toBe("1")
    // Landscape profile wins over the flat only in landscape preview.
    const landOn = new URL(
      buildDefaultsPreviewUrl({
        defaultPreRelease: false,
        landscape: { preRelease: true } as never,
        previewShape: "landscape",
      }),
    )
    expect(landOn.searchParams.get("pre")).toBe("1")
    const landOff = new URL(
      buildDefaultsPreviewUrl({
        defaultPreRelease: true,
        landscape: { preRelease: false } as never,
        previewShape: "landscape",
      }),
    )
    expect(landOff.searchParams.get("pre")).toBe("0")
    const portrait = new URL(
      buildDefaultsPreviewUrl({
        defaultPreRelease: false,
        landscape: { preRelease: true } as never,
      }),
    )
    expect(portrait.searchParams.get("pre")).toBe("0")
  })

  it("server honors explicit pre=0 over an inherited-ON default (cause isolation)", () => {
    const input = (searchParams: URLSearchParams): PosterRenderConfigInput => ({
      searchParams,
      mapping: null,
      configOverride: null,
      sd: { preRelease: true } as ServerDefaults,
      hasQuery: true,
      showBadges: true,
      rankingBadges: true,
      animeRank: null,
      rankingResult: null,
      finalRank: null,
      lang: "it",
    })
    // Omitted param inherits the saved-ON default: this is what the stale
    // preview rendered (Coming Soon band despite the staged OFF).
    expect(resolvePosterRenderConfig(input(new URLSearchParams())).preRelease).toBe(true)
    // Explicit false wins: this is what the fixed preview sends.
    expect(resolvePosterRenderConfig(input(new URLSearchParams("pre=0"))).preRelease).toBe(false)
    expect(resolvePosterRenderConfig(input(new URLSearchParams("pre=1"))).preRelease).toBe(true)
  })

  it("config-token Stremio params keep explicit false (unconfigured URLs stay omission-stable)", () => {
    // With a stateless config token the effective value must travel
    // explicitly (same contract as badges/ranking/age): otherwise the token
    // master would silently win over the space default.
    expect(
      buildStremioPosterSearchParams({ config: "tok", preRelease: false }).get("pre"),
    ).toBe("0")
    expect(buildStremioPosterSearchParams({ config: "tok", preRelease: true }).get("pre")).toBe(
      "1",
    )
    // Without config the legacy omission contract is unchanged (cache-stable
    // existing URLs; the server resolves mapping/defaults as before).
    expect(buildStremioPosterSearchParams({ preRelease: false }).has("pre")).toBe(false)
    expect(buildStremioPosterSearchParams({ preRelease: true }).get("pre")).toBe("1")
  })
})
