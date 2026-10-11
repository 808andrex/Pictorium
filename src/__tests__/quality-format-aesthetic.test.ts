import { describe, expect, it } from "vitest"
import {
  buildQualityBadgeSvg,
  buildQualityTierBadgeSvg,
  badgeBoxHeight,
  TOP_SHADOW_PAD,
  QUALITY_TIER_PAD_X_FACTOR,
  QUALITY_TIER_RADIUS_FACTOR,
} from "@/lib/badge-svg-shared"
import {
  renderQualityBadge,
  renderQualityTierBadge,
} from "@/lib/svg-badge"
import {
  renderQualityBadgeGroup,
  renderQualityIconBadge,
} from "@/lib/poster-service"
import { FORMAT_ICON_PATHS, VIDEO_FORMAT_OPTIONS } from "@/lib/av-specs"
import type { BadgeFont } from "@/lib/badge-styles"
import fs from "node:fs"
import path from "node:path"
import sharp from "sharp"

const ROOT = path.resolve(__dirname, "../..")
const PAD = TOP_SHADOW_PAD
const TIERS = ["4K", "FHD", "HD", "SD"] as const
const FONTS = ["inter", "barlow-condensed", "oswald"] as const satisfies readonly BadgeFont[]

function rxOf(svg: string): number {
  const m = svg.match(/rx="([\d.]+)"/)
  expect(m, "rx present").not.toBeNull()
  return Number(m![1])
}

function textLengthOf(svg: string): number {
  const m = svg.match(/textLength="(\d+)"/)
  expect(m, "textLength present").not.toBeNull()
  return Number(m![1])
}

/** Opaque-ink bbox (alpha > 10) of a rendered badge PNG. */
async function inkBox(png: Buffer, w: number, h: number) {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let x0 = w, x1 = -1, y0 = h, y1 = -1, n = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 10) {
        n++
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  expect(n, "mark visible").toBeGreaterThan(100)
  return { x0, x1, y0, y1, n }
}

describe("quality tier tag aesthetic (standard style only)", () => {
  it("is wider and less rounded than the historic neutral pill, same height", () => {
    for (const tier of TIERS) {
      for (const font of FONTS) {
        for (const fs of [17, 22]) {
          const std = buildQualityBadgeSvg(tier, fs, "", "", false, font)
          const tag = buildQualityTierBadgeSvg(tier, fs, false, font)
          // Wider box, identical height (anchors/scales downstream untouched).
          expect(tag.w, `${tier}/${font}/${fs} wider`).toBeGreaterThan(std.w)
          expect(tag.h, `${tier}/${font}/${fs} same height`).toBe(std.h)
          expect(tag.h).toBe(badgeBoxHeight(fs) + PAD * 2)
          // Less rounded: contained radius, not a full pill.
          expect(rxOf(tag.svg), `${tier}/${font}/${fs} radius`).toBe(
            Math.round(badgeBoxHeight(fs) * QUALITY_TIER_RADIUS_FACTOR),
          )
          expect(rxOf(tag.svg)).toBeLessThan(rxOf(std.svg))
          // No text clipping: pinned textLength fits the widened interior.
          const pxTier = Math.round(fs * QUALITY_TIER_PAD_X_FACTOR)
          expect(textLengthOf(tag.svg) + pxTier * 2).toBeLessThanOrEqual(tag.w - PAD * 2)
        }
      }
    }
  })

  it("rasterizes at portrait and landscape badge widths without clipping", async () => {
    for (const pw of [380, 500]) {
      const tag = await renderQualityTierBadge("4K", pw, false)
      const { n } = await inkBox(tag.png, tag.w, tag.h)
      expect(n).toBeGreaterThan(100)
      // Opaque ink stays inside the box (shadow pad margin on every side).
      const box = await inkBox(tag.png, tag.w, tag.h)
      expect(box.x0).toBeGreaterThanOrEqual(2)
      expect(box.y0).toBeGreaterThanOrEqual(2)
      expect(box.x1).toBeLessThanOrEqual(tag.w - 3)
      expect(box.y1).toBeLessThanOrEqual(tag.h - 3)
    }
  })
})

describe("age pill unchanged by the tier aesthetic", () => {
  it("keeps the historic neutral geometry (pad 0.75x, full-pill radius)", () => {
    // "VM14" estimate: V .68 + M .86 + 1 .58 + 4 .58 = 2.70em * 17 = 45.9 -> 46,
    // plus technical-mark tracking round(0.06*17*3) = 3 -> textW 49.
    const age = buildQualityBadgeSvg("VM14", 17, "", "", false, "inter")
    expect(age.w).toBe(49 + Math.round(17 * 0.75) * 2 + PAD * 2)
    expect(rxOf(age.svg)).toBe(Math.round(badgeBoxHeight(17) / 2))
  })

  it("age-only group returns the neutral pill bitmap directly (no tier path)", async () => {
    const group = await renderQualityBadgeGroup(null, "standard", null, 380, false, "inter", "VM14")
    const pill = await renderQualityBadge("VM14", 380, false)
    expect(group).not.toBeNull()
    expect(group!.png.equals(pill.png)).toBe(true)
  })
})

describe("quality -> age -> formats order with the new tier tag", () => {
  const PW = 380
  const GAP = Math.round(5 * PW / 380)

  it("stacks tier, age, then bare format marks top-to-bottom", async () => {
    const tier = await renderQualityTierBadge("4K", PW, false)
    const age = await renderQualityBadge("VM14", PW, false)
    const hdr = await renderQualityIconBadge(FORMAT_ICON_PATHS["hdr"], PW, false)
    expect(hdr).not.toBeNull()
    const group = await renderQualityBadgeGroup("4K", "standard", ["hdr"], PW, false, "inter", "VM14")
    expect(group).not.toBeNull()
    const vt = tier.h - PAD * 2
    const va = age.h - PAD * 2
    const vf = hdr!.h - PAD * 2
    expect(group!.w).toBe(Math.max(tier.w, age.w, hdr!.w))
    expect(group!.h).toBe(PAD * 2 + vt + GAP + va + GAP + vf)
  })

  it("keeps a uniform gap across a four-row column (tier/age/hdr/imax)", async () => {
    const tier = await renderQualityTierBadge("4K", PW, false)
    const age = await renderQualityBadge("VM14", PW, false)
    const hdr = await renderQualityIconBadge(FORMAT_ICON_PATHS["hdr"], PW, false)
    const imax = await renderQualityIconBadge(FORMAT_ICON_PATHS["imax"], PW, false)
    expect(hdr).not.toBeNull()
    expect(imax).not.toBeNull()
    const group = await renderQualityBadgeGroup("4K", "standard", ["hdr", "imax"], PW, false, "inter", "VM14")
    expect(group).not.toBeNull()
    const rows = [tier.h, age.h, hdr!.h, imax!.h].map((h) => h - PAD * 2)
    expect(group!.h).toBe(PAD * 2 + rows.reduce((a, b) => a + b, 0) + GAP * 3)
  })
})

describe("format marks without containers, no relabeling", () => {
  it("keeps the generic HDR label (never HDR10) and every per-format asset", () => {
    const labels = new Map(VIDEO_FORMAT_OPTIONS.map((o) => [o.id, o.label] as const))
    expect(labels.get("hdr")).toBe("HDR")
    expect([...labels.keys()]).not.toContain("hdr10")
    for (const fmt of ["dv", "hdr", "hdr10plus", "atmos", "imax"] as const) {
      expect(
        fs.existsSync(path.join(ROOT, "public", FORMAT_ICON_PATHS[fmt])),
        `missing asset ${fmt}`,
      ).toBe(true)
    }
  })

  it("ships hdr/hdr10plus sources with no container path", () => {
    for (const fmt of ["hdr", "hdr10plus"] as const) {
      const src = fs.readFileSync(path.join(ROOT, "public", FORMAT_ICON_PATHS[fmt]), "utf8")
      // Rounded-rectangle container frame of the previous artwork.
      expect(src).not.toMatch(/94\.3H/)
      expect(src).not.toMatch(/<rect/)
    }
  })

  it("renders bare marks with transparent surroundings on any background", async () => {
    for (const fmt of ["hdr", "hdr10plus", "dv", "atmos"] as const) {
      const icon = await renderQualityIconBadge(FORMAT_ICON_PATHS[fmt], 380, false)
      expect(icon).not.toBeNull()
      const { data } = await sharp(icon!.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      const corner = (x: number, y: number): number => data[(y * icon!.w + x) * 4 + 3]
      // 5x5 bitmap corners (shadow pad zone): no box may reach the edges.
      for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 5; x++) {
          expect(corner(x, y), `${fmt} tl`).toBe(0)
          expect(corner(icon!.w - 1 - x, y), `${fmt} tr`).toBe(0)
          expect(corner(x, icon!.h - 1 - y), `${fmt} bl`).toBe(0)
          expect(corner(icon!.w - 1 - x, icon!.h - 1 - y), `${fmt} br`).toBe(0)
        }
      }
      // Compositing proof on a synthetic red background: mark visible, surround clean.
      const comp = await sharp({
        create: { width: icon!.w, height: icon!.h, channels: 4, background: { r: 212, g: 0, b: 0, alpha: 1 } },
      })
        .composite([{ input: icon!.png }])
        .png()
        .toBuffer()
      const raw = await sharp(comp).ensureAlpha().raw().toBuffer()
      // Far corner stays pure background red (no translucent box film).
      const i = (4 * icon!.w + 4) * 4
      expect(raw[i]).toBe(212)
      expect(raw[i + 1]).toBe(0)
      expect(raw[i + 2]).toBe(0)
    }
  })

  it("matches the optical visible height of the Dolby singles (bounded)", async () => {
    // Dolby singles measure ~0.74 ink-height fraction of the icon box;
    // the reframed HDR marks must sit in the same band. IMAX (pinned raw
    // coords) and the two-line Dolby combo keep their historic boxes.
    // Render large (pw 760 -> 62px box) so thin HDR10+ strokes resolve
    // solid alpha cores; at poster scale antialiasing thins them below any
    // halo-excluding threshold. Geometry scales linearly with pw.
    const fracs: Record<string, number> = {}
    for (const fmt of ["dv", "atmos", "hdr", "hdr10plus"] as const) {
      const icon = await renderQualityIconBadge(FORMAT_ICON_PATHS[fmt], 760, false)
      expect(icon).not.toBeNull()
      // Drop-shadow halo excluded by construction: measure the bright core
      // (alpha > 200) so the blur tail cannot inflate the height.
      const { data } = await sharp(icon!.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      let y0 = icon!.h, y1 = -1
      for (let y = 0; y < icon!.h; y++) {
        for (let x = 0; x < icon!.w; x++) {
          if (data[(y * icon!.w + x) * 4 + 3] > 200) {
            if (y < y0) y0 = y
            if (y > y1) y1 = y
          }
        }
      }
      expect(y1, `${fmt} mark visible`).toBeGreaterThan(y0)
      const frac = (y1 - y0 + 1) / (icon!.h - PAD * 2)
      expect(frac, `${fmt} optical height`).toBeGreaterThan(0.6)
      expect(frac, `${fmt} optical height`).toBeLessThan(0.86)
      fracs[fmt] = frac
    }
    const vals = Object.values(fracs)
    expect(Math.max(...vals) / Math.min(...vals)).toBeLessThanOrEqual(1.15)
  })
})
