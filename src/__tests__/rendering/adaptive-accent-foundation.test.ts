/**
 * Foundation ONLY for a future adaptive automatic badge accent.
 *
 * The solver under test (adaptiveAutomaticAccent / solveAdaptiveAccent in
 * src/lib/accent-color.ts) is NOT wired into any normalizer, caller, render
 * path or UI: existing normalizeAutomaticAccent behavior (fixed 5/12) must
 * stay byte-identical, and these tests pin that legacy contract alongside
 * the new pure function. The user chose readability: text target 4.5:1,
 * separation second priority 3:1, hue/saturation preserved, L in
 * [0.24, 0.60], anchor 5/12 for stability.
 */
import { describe, it, expect } from "vitest"
import {
  AUTO_BADGE_ACCENT_LIGHTNESS,
  AUTO_BADGE_ACCENT_L_MAX,
  AUTO_BADGE_ACCENT_L_MIN,
  AUTO_BADGE_ACCENT_L_STEP,
  AUTO_BADGE_ACCENT_SEPARATION,
  AUTO_BADGE_ACCENT_TEXT_CONTRAST,
  adaptiveAutomaticAccent,
  adaptiveAutomaticAccentHex,
  contrastRatio,
  normalizeAutomaticAccent,
  normalizeAutomaticAccentHex,
  relativeLuminance,
  solveAdaptiveAccent,
  textColorForBg,
} from "@/lib/accent-color"

const BACKGROUNDS = [0.03, 0.35, 0.75]

const MATRIX: Array<{ label: string; rgb: { r: number; g: number; b: number } }> = [
  { label: "yellow", rgb: { r: 255, g: 231, b: 51 } },
  { label: "cyan", rgb: { r: 0, g: 229, b: 255 } },
  { label: "green", rgb: { r: 34, g: 197, b: 94 } },
  { label: "red", rgb: { r: 229, g: 9, b: 20 } },
  { label: "magenta", rgb: { r: 255, g: 0, b: 255 } },
  { label: "blue", rgb: { r: 59, g: 130, b: 246 } },
  { label: "gray", rgb: { r: 128, g: 128, b: 128 } },
  { label: "black", rgb: { r: 10, g: 10, b: 10 } },
  { label: "white", rgb: { r: 255, g: 255, b: 255 } },
  { label: "pale neutral", rgb: { r: 245, g: 230, b: 196 } },
  { label: "saturated neutral teal", rgb: { r: 81, g: 149, b: 163 } },
  { label: "comedy fallback", rgb: { r: 244, g: 208, b: 63 } },
  { label: "amber", rgb: { r: 229, g: 142, b: 38 } },
  { label: "navy", rgb: { r: 22, g: 30, b: 52 } },
]

function measureHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const l = (max + min) / 2, d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = ((gn - bn) / d) % 6
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s, l }
}

function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

function toHex(c: { r: number; g: number; b: number }): string {
  const p = (n: number) => Math.round(n).toString(16).padStart(2, "0")
  return `#${p(c.r)}${p(c.g)}${p(c.b)}`
}

/** Actual renderer text contrast for an 8-bit fill (effective blending). */
function actualTextContrast(fillHex: string): { color: string; ratio: number } {
  const color = textColorForBg(fillHex)
  const r = parseInt(fillHex.slice(1, 3), 16)
  const g = parseInt(fillHex.slice(3, 5), 16)
  const b = parseInt(fillHex.slice(5, 7), 16)
  const bgLum = relativeLuminance(r, g, b)
  const m = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/)
  let tr: number, tg: number, tb: number, ta: number
  if (m) {
    tr = parseInt(m[1]); tg = parseInt(m[2]); tb = parseInt(m[3])
    ta = m[4] !== undefined ? parseFloat(m[4]) : 1
  } else {
    tr = parseInt(color.slice(1, 3), 16)
    tg = parseInt(color.slice(3, 5), 16)
    tb = parseInt(color.slice(5, 7), 16)
    ta = 1
  }
  const er = ta < 1 ? Math.round(tr * ta + r * (1 - ta)) : tr
  const eg = ta < 1 ? Math.round(tg * ta + g * (1 - ta)) : tg
  const eb = ta < 1 ? Math.round(tb * ta + b * (1 - ta)) : tb
  return { color, ratio: contrastRatio(relativeLuminance(er, eg, eb), bgLum) }
}

describe("adaptive accent foundation constants", () => {
  it("keeps the legacy 5/12 anchor exported and uses the 4.5 readability target", () => {
    expect(AUTO_BADGE_ACCENT_LIGHTNESS).toBeCloseTo(5 / 12, 12)
    expect(AUTO_BADGE_ACCENT_L_MIN).toBe(0.24)
    expect(AUTO_BADGE_ACCENT_L_MAX).toBe(0.6)
    expect(AUTO_BADGE_ACCENT_TEXT_CONTRAST).toBe(4.5)
    expect(AUTO_BADGE_ACCENT_SEPARATION).toBe(3)
    expect(AUTO_BADGE_ACCENT_L_STEP).toBe(0.01)
  })

  it("evaluates a bounded candidate set (constant CPU, no renderer load)", () => {
    const { diagnostics } = solveAdaptiveAccent({ r: 81, g: 149, b: 163 })
    expect(diagnostics.evaluations).toBeLessThanOrEqual(80)
    expect(diagnostics.evaluations).toBeGreaterThan(30)
  })
})

describe("adaptive accent pure matrix (no background)", () => {
  it.each(MATRIX.map((m) => [m.label, m.rgb] as const))(
    "%s: bounded L, hue/sat preserved, actual text contrast documented",
    (_label, input) => {
      const { color: out, diagnostics } = solveAdaptiveAccent(input)
      const before = measureHsl(input.r, input.g, input.b)
      const after = measureHsl(out.r, out.g, out.b)
      // L stays inside the contrast-derived bounds (8-bit quantization slack).
      expect(after.l).toBeGreaterThanOrEqual(AUTO_BADGE_ACCENT_L_MIN - 0.003)
      expect(after.l).toBeLessThanOrEqual(AUTO_BADGE_ACCENT_L_MAX + 0.003)
      // Hue/saturation preserved; achromatic inputs stay neutral gray.
      if (before.s > 0.02) {
        expect(hueDist(after.h, before.h)).toBeLessThan(3)
        expect(Math.abs(after.s - before.s)).toBeLessThan(0.04)
      } else {
        expect(after.s).toBeLessThan(0.04)
        expect(out.r).toBe(out.g)
        expect(out.g).toBe(out.b)
      }
      // The measured renderer choice matches the diagnostic, on the final
      // 8-bit fill (never an assumed-white claim).
      const actual = actualTextContrast(toHex(out))
      expect(actual.color).toBe(diagnostics.textColor)
      expect(actual.ratio).toBeCloseTo(diagnostics.textContrast, 9)
      if (diagnostics.feasibleText) {
        expect(actual.ratio).toBeGreaterThanOrEqual(4.5 - 1e-6)
      } else {
        // Documented best-effort: no bounded candidate reaches 4.5.
        expect(actual.ratio).toBeLessThan(4.5)
      }
    },
  )

  it("keeps the exact anchor when it is already text-safe (no gratuitous move)", () => {
    const matches = MATRIX.filter(
      ({ rgb }) =>
        JSON.stringify(adaptiveAutomaticAccent(rgb)) === JSON.stringify(normalizeAutomaticAccent(rgb)),
    )
    expect(matches.length).toBeGreaterThan(0)
  })

  it("maps white to the same bounded neutral gray as the legacy path", () => {
    const out = adaptiveAutomaticAccent({ r: 255, g: 255, b: 255 })
    expect(out).toEqual(normalizeAutomaticAccent({ r: 255, g: 255, b: 255 }))
    expect(out.r).toBe(out.g)
    expect(out.g).toBe(out.b)
  })
})

describe("adaptive accent context matrix (dark/mid/light background)", () => {
  it.each(MATRIX.map((m) => [m.label, m.rgb] as const))(
    "%s: text-first 4.5 where feasible, separation second priority",
    (_label, input) => {
      for (const bg of BACKGROUNDS) {
        const { color: out, diagnostics } = solveAdaptiveAccent(input, { backgroundLuminance: bg })
        const actual = actualTextContrast(toHex(out))
        expect(actual.color).toBe(diagnostics.textColor)
        if (diagnostics.feasibleText) {
          // Text priority survives an impossible separation bar.
          expect(actual.ratio).toBeGreaterThanOrEqual(4.5 - 1e-6)
        } else {
          expect(diagnostics.feasibleText).toBe(false)
        }
        if (diagnostics.feasibleSeparation) {
          expect(diagnostics.separation).not.toBeNull()
          expect(diagnostics.separation!).toBeGreaterThanOrEqual(3 - 1e-6)
        }
        // L stays bounded under context too.
        const after = measureHsl(out.r, out.g, out.b)
        expect(after.l).toBeGreaterThanOrEqual(AUTO_BADGE_ACCENT_L_MIN - 0.003)
        expect(after.l).toBeLessThanOrEqual(AUTO_BADGE_ACCENT_L_MAX + 0.003)
      }
    },
  )

  it("moves L with the local background when context permits (dark vs light differ)", () => {
    const moved = MATRIX.filter(({ rgb }) => {
      const dark = solveAdaptiveAccent(rgb, { backgroundLuminance: 0.03 }).diagnostics.l
      const light = solveAdaptiveAccent(rgb, { backgroundLuminance: 0.75 }).diagnostics.l
      return Math.abs(dark - light) > 1e-9
    })
    expect(moved.length).toBeGreaterThan(0)
  })
})

describe("adaptive accent determinism and guards", () => {
  it("is deterministic and idempotent within quantization tolerance", () => {
    for (const { rgb } of MATRIX) {
      for (const bg of [undefined, 0.03, 0.75] as const) {
        const opts = bg === undefined ? undefined : { backgroundLuminance: bg }
        const a = solveAdaptiveAccent(rgb, opts)
        const b = solveAdaptiveAccent(rgb, opts)
        expect(b.color).toEqual(a.color)
        expect(b.diagnostics).toEqual(a.diagnostics)
        // Re-solving the solver output stays put (quantized h/s slack: 1 step).
        const again = solveAdaptiveAccent(a.color, opts)
        const lOut = measureHsl(again.color.r, again.color.g, again.color.b).l
        const lFirst = measureHsl(a.color.r, a.color.g, a.color.b).l
        expect(Math.abs(lOut - lFirst)).toBeLessThanOrEqual(AUTO_BADGE_ACCENT_L_STEP + 0.003)
      }
    }
  })

  it("clamps malformed channels deterministically instead of producing NaN", () => {
    const out = adaptiveAutomaticAccent({ r: NaN, g: Infinity, b: -20 })
    for (const v of [out.r, out.g, out.b]) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(255)
    }
    expect(adaptiveAutomaticAccent({ r: NaN, g: Infinity, b: -20 })).toEqual(out)
  })

  it("hex wrapper passes malformed input through and round-trips valid hex", () => {
    for (const bad of ["red", "", "#fff", "#5195a"]) {
      expect(adaptiveAutomaticAccentHex(bad)).toBe(bad)
    }
    const out = adaptiveAutomaticAccentHex("#5195a3")
    expect(out).toMatch(/^#[0-9a-f]{6}$/)
    expect(adaptiveAutomaticAccentHex(out)).toBe(out)
  })
})

describe("legacy automatic accent untouched by the foundation", () => {
  it("normalizeAutomaticAccent still forces exactly 5/12 (incl. Comedy fallback)", () => {
    const legacy = (hex: string): number => {
      const c = normalizeAutomaticAccentHex(hex)
      const m = measureHsl(
        parseInt(c.slice(1, 3), 16),
        parseInt(c.slice(3, 5), 16),
        parseInt(c.slice(5, 7), 16),
      )
      return m.l
    }
    expect(Math.abs(legacy("#F4D03F") - 5 / 12)).toBeLessThan(0.002)
    expect(Math.abs(legacy("#5195a3") - 5 / 12)).toBeLessThan(0.002)
    expect(normalizeAutomaticAccentHex("red")).toBe("red")
  })
})
