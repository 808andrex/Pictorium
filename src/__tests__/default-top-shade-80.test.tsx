/**
 * Universal top-shade default (80) — user-authorized global change:
 * - the canonical factory default moves 50 -> 80 on every shape (client flat,
 *   landscape editor default, server render chain, preview + Stremio URL
 *   fallbacks);
 * - the SEVEN ready looks own top 80 in BOTH shapes (portrait flat + effective
 *   landscape), from the same shared canonical source as the per-title chooser;
 * - explicit stored values (0/30/50) are respected verbatim — no migration of
 *   stored profiles / personal presets / per-title mappings;
 * - applying a preset to portrait freezes the other shape's saved top (never
 *   leaks the new flat 80 into it).
 * BetterPoster velatura (darkness 0 -> 30) lives in better-poster-darkness-30.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import {
  APPLE_VISUAL_DEFAULTS,
  BETTER_POSTER_VISUAL_DEFAULTS,
  FRESH_VISUAL_DEFAULTS,
  RPDB_VISUAL_DEFAULTS,
} from "@/lib/default-visual-presets"
import { quickLookDesired, type QuickLookId } from "@/lib/quick-visual-presets"
import { READY_PRESET_ENTRIES } from "@/lib/ready-visual-presets"
import {
  applyPortraitIsolated,
  normalizePersonalPreset,
  portraitPresetPatch,
  resolveEffectiveLandscape,
  visualPresetValuesSchema,
  type VisualPresetValues,
} from "@/lib/visual-presets"
import { resolvePosterRenderConfig, type PosterRenderConfigInput } from "@/lib/poster-config"
import { buildDefaultsPreviewUrl } from "@/lib/poster-url"
import { buildStremioPosterSearchParams } from "@/lib/stremio-poster-params"
import { useDefaults } from "@/lib/useDefaults"
import { resetGuestGuardForTests } from "@/lib/guest-guard"
import type { Mapping } from "@/lib/types"

const READY_IDS = ["apple", "better-poster", "rpdb", "essential", "ratings", "full", "fresh"] as const

function baseInput(overrides: Partial<PosterRenderConfigInput> = {}): PosterRenderConfigInput {
  return {
    searchParams: new URLSearchParams(),
    mapping: null,
    configOverride: null,
    sd: {},
    hasQuery: false,
    showBadges: true,
    rankingBadges: true,
    animeRank: null,
    rankingResult: null,
    finalRank: null,
    ...overrides,
  }
}

const mapping = (partial: Partial<Mapping> = {}): Mapping => ({
  tmdbId: 1, mediaType: "movie", title: "T", posterPath: "/p.jpg",
  logoPath: null, originalPosterPath: null, language: null, updatedAt: "2026-01-01",
  ...partial,
})

describe("ready-seven own top 80 in both shapes (shared canonical source)", () => {
  it("exposes the seven canonical looks in gallery order", () => {
    expect(READY_PRESET_ENTRIES.map((e) => e.id)).toEqual([...READY_IDS])
  })

  it.each(READY_IDS)("%s portrait flat is 80 and effective landscape is 80", (id) => {
    const entry = READY_PRESET_ENTRIES.find((e) => e.id === id)!
    expect(portraitPresetPatch(entry.desired(true)).defaultTopShade).toBe(80)
    expect(resolveEffectiveLandscape(entry.desired(false))?.topShade).toBe(80)
  })

  it("snapshot constants carry the canonical 80 (flat, nested where present)", () => {
    expect(BETTER_POSTER_VISUAL_DEFAULTS.defaultTopShade).toBe(80)
    expect(RPDB_VISUAL_DEFAULTS.defaultTopShade).toBe(80)
    expect(APPLE_VISUAL_DEFAULTS.defaultTopShade).toBe(80)
    expect(APPLE_VISUAL_DEFAULTS.landscape?.topShade).toBe(80)
    expect(FRESH_VISUAL_DEFAULTS.defaultTopShade).toBe(80)
    expect(FRESH_VISUAL_DEFAULTS.landscape?.topShade).toBe(80)
  })

  it("quick looks carry 80 via the canonical transform reset (both targets)", () => {
    for (const id of ["essential", "ratings", "full"] as QuickLookId[]) {
      expect(quickLookDesired(id, true).defaultTopShade, `${id} portrait`).toBe(80)
      expect(quickLookDesired(id, false).defaultTopShade, `${id} landscape`).toBe(80)
    }
  })
})

describe("absence falls back to 80 on every chain", () => {
  it("server render chain without query/mapping/config/defaults", () => {
    expect(resolvePosterRenderConfig(baseInput()).topShade).toBe(80)
    // Non-numeric query still fails closed to the canonical default.
    expect(
      resolvePosterRenderConfig(baseInput({ searchParams: new URLSearchParams({ ts: "abc" }) })).topShade,
    ).toBe(80)
  })

  it("Stremio URL omits ts at the new default and resolves it back to 80", () => {
    expect(buildStremioPosterSearchParams({}).has("ts")).toBe(false)
    expect(buildStremioPosterSearchParams({ topShade: 80 }).has("ts")).toBe(false)
  })

  it("preview URL always carries ts=80 (explicit and absent flat)", () => {
    const params = (p: Parameters<typeof buildDefaultsPreviewUrl>[0]) =>
      new URL(buildDefaultsPreviewUrl(p), "http://localhost").searchParams
    expect(params({ defaultTopShade: 80 }).get("ts")).toBe("80")
    // Absent flat falls back to the canonical default on both shapes.
    expect(params({}).get("ts")).toBe("80")
    expect(params({ previewShape: "landscape" }).get("ts")).toBe("80")
  })

  it("a fresh session (empty storage) starts at 80 on both shapes", async () => {
    vi.useFakeTimers()
    resetGuestGuardForTests()
    localStorage.clear()
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })))
    const { result } = renderHook(() => useDefaults())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
    })
    expect(result.current.defaultTopShade).toBe(80)
    expect(result.current.topShade).toBe(80)
  })

  it("a legacy store missing the key reads the canonical 80", async () => {
    vi.useFakeTimers()
    resetGuestGuardForTests()
    localStorage.clear()
    localStorage.setItem(
      "badgeDefaults",
      JSON.stringify({ defaultBadgeYear: false, defaultGradientHeight: 45 }),
    )
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })))
    const { result } = renderHook(() => useDefaults())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
    })
    expect(result.current.defaultTopShade).toBe(80)
    expect(result.current.topShade).toBe(80)
  })
})

describe("explicit stored values are respected verbatim (no migration)", () => {
  it("server chain honors explicit 0/30/50", () => {
    for (const v of [0, 30, 50]) {
      expect(resolvePosterRenderConfig(baseInput({ sd: { topShade: v } })).topShade).toBe(v)
      expect(buildStremioPosterSearchParams({ topShade: v }).get("ts")).toBe(String(v))
    }
  })

  it("a per-title mapping top 50 wins over the new default", () => {
    expect(resolvePosterRenderConfig(baseInput({ mapping: mapping({ topShade: 50 }) })).topShade).toBe(50)
  })

  it("personal explicit top 50 survives normalize and the input is not mutated", () => {
    const personal = visualPresetValuesSchema.parse({
      ...APPLE_VISUAL_DEFAULTS,
      defaultTopShade: 50,
    }) as VisualPresetValues
    const before = JSON.stringify(personal)
    expect(normalizePersonalPreset(personal).defaultTopShade).toBe(50)
    // No stored-profile rewrite (pure normalize).
    expect(JSON.stringify(personal)).toBe(before)
  })

  it("normalize never invents a top for a snapshot missing it (no preset migration)", () => {
    const raw = { ...APPLE_VISUAL_DEFAULTS } as unknown as Record<string, unknown>
    delete raw.defaultTopShade
    const before = JSON.stringify(raw)
    const normalized = normalizePersonalPreset(raw as unknown as VisualPresetValues) as unknown as Record<string, unknown>
    expect("defaultTopShade" in normalized).toBe(false)
    expect(JSON.stringify(raw)).toBe(before)
  })
})

describe("applying a preset to portrait freezes the other shape's saved top", () => {
  it("inheriting landscape freezes the pre-edit effective (no flat-80 leak)", () => {
    const current = visualPresetValuesSchema.parse({
      ...APPLE_VISUAL_DEFAULTS,
      defaultTopShade: 10,
      landscape: {},
    }) as VisualPresetValues
    const next = applyPortraitIsolated(current, BETTER_POSTER_VISUAL_DEFAULTS)
    expect(next.defaultTopShade).toBe(80)
    expect(next.landscape?.topShade).toBe(10)
  })

  it("an explicit other-shape top 50 stays 50 (never overwritten by the flat 80)", () => {
    const current = visualPresetValuesSchema.parse({
      ...APPLE_VISUAL_DEFAULTS,
      defaultTopShade: 10,
      landscape: { topShade: 50 },
    }) as VisualPresetValues
    const next = applyPortraitIsolated(current, BETTER_POSTER_VISUAL_DEFAULTS)
    expect(next.defaultTopShade).toBe(80)
    expect(next.landscape?.topShade).toBe(50)
  })
})

beforeEach(() => {
  resetGuestGuardForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
