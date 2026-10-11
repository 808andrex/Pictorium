/**
 * Removed-feature compat (Fresh numeral font, dropped): snapshots saved
 * while the selector existed may still carry `freshNumeralFont` /
 * `defaultFreshNumeralFont`. The numeral always renders historic Inter now;
 * legacy payloads must validate with the obsolete keys ignored (stripped),
 * never reject the whole preset/token/mapping.
 */
import { describe, it, expect } from "vitest"
import {
  visualPresetValuesSchema,
  stripRemovedFreshFontKeys,
} from "@/lib/visual-presets"
import { APPLE_VISUAL_DEFAULTS } from "@/lib/default-visual-presets"
import { mappingSchema } from "@/lib/validation"
import { configTokenSchema } from "@/lib/config-token"

describe("removed Fresh numeral-font legacy compat", () => {
  it("strips flat + nested landscape obsolete keys and preserves the rest", () => {
    const legacy = {
      defaultBadgeStyle: "shadow",
      defaultFreshNumeralFont: "inter",
      landscape: { badgeStyle: "shadow", freshNumeralFont: "inter-display-extrabold" },
    }
    const stripped = stripRemovedFreshFontKeys(legacy)
    expect(stripped).toEqual({
      defaultBadgeStyle: "shadow",
      landscape: { badgeStyle: "shadow" },
    })
    // Scalars and arrays pass through untouched.
    expect(stripRemovedFreshFontKeys(null)).toBeNull()
    expect(stripRemovedFreshFontKeys("inter")).toBe("inter")
    expect(stripRemovedFreshFontKeys([{ freshNumeralFont: "inter", a: 1 }])).toEqual([{ a: 1 }])
  })

  it("strict preset values accept a legacy snapshot after stripping (reject without)", () => {
    const legacy = {
      ...APPLE_VISUAL_DEFAULTS,
      defaultFreshNumeralFont: "inter",
      landscape: { ...APPLE_VISUAL_DEFAULTS.landscape, freshNumeralFont: "inter-display-extrabold" },
    }
    expect(visualPresetValuesSchema.safeParse(legacy).success).toBe(false)
    const parsed = visualPresetValuesSchema.safeParse(stripRemovedFreshFontKeys(legacy))
    expect(parsed.success).toBe(true)
  })

  it("non-strict mapping schema sheds the obsolete per-title key automatically", () => {
    const parsed = mappingSchema.safeParse({
      tmdbId: 1,
      mediaType: "movie",
      title: "T",
      posterPath: "/p.jpg",
      badgeFont: "inter",
      freshNumeralFont: "inter",
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && "freshNumeralFont" in parsed.data).toBe(false)
  })

  it("non-strict config token sheds the obsolete flat key automatically", () => {
    const parsed = configTokenSchema.safeParse({
      globalBadges: true,
      rankingBadges: true,
      badgeStyle: "shadow",
      rankingBadgeStyle: "default",
      badgeFont: "inter",
      freshNumeralFont: "inter",
      blurEnabled: true,
      blurIntensity: 20,
      blurFade: 50,
      blurDarkness: 30,
      gradientHeight: 60,
      autoRotateClean: false,
      networkLogo: false,
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && "freshNumeralFont" in parsed.data).toBe(false)
  })
})
