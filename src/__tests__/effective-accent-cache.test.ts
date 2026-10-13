/**
 * Effective-accent cache units (Stage 1, server-only).
 *
 * - validator: valid records pass through cloned (caller mutations never leak
 *   across requests), unknown keys pruned, malformed hexes/enums coerced to
 *   honest unknown, non-objects rejected, secrets-shaped keys dropped;
 * - sidecar: `writeCachedPoster`/`readCachedPoster` round-trip meta with the
 *   same TTL/tags; old entries without meta read as absent (unknown); a
 *   headers-only record without bytes is never trusted; variant entries never
 *   clobber the canonical meta;
 * - completed map: late-preview read after inflight deletion, write-before-
 *   complete ordering helper contract, 45s expiry (`>=` boundary), 128-entry
 *   deterministic insertion eviction, mutable-input safety, invalid-hex drop.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { cacheClear, cacheSet } from "@/lib/cache"
import {
  COMPLETED_ACCENT_TTL_MS,
  MAX_COMPLETED_ACCENT_RECORDS,
  sanitizeEffectiveAccentMeta,
  type EffectiveAccentMeta,
} from "@/lib/effective-accent"
import {
  __resetCompletedAccentForTests,
  readCachedPoster,
  readCompletedAccent,
  recordCompletedAccent,
  writeCachedPoster,
} from "@/lib/poster-runtime-cache"

const META: EffectiveAccentMeta = {
  genreHex: "#4e8087",
  rankHex: "#a1b2c3",
  genrePaints: true,
  topPaints: true,
  topType: "extra",
  provGenre: "extracted",
  provRank: "extracted",
  gradientHex: "#3a7d8c",
  gradientPaints: true,
  provGradient: "extracted",
}

const NOT_PAINTED: EffectiveAccentMeta = {
  genreHex: null,
  rankHex: null,
  genrePaints: false,
  topPaints: false,
  topType: null,
  provGenre: "not-painted",
  provRank: "not-painted",
  gradientHex: null,
  gradientPaints: false,
  provGradient: "not-painted",
}

beforeEach(() => {
  cacheClear()
  __resetCompletedAccentForTests()
})

afterEach(() => {
  cacheClear()
  __resetCompletedAccentForTests()
  vi.useRealTimers()
})

describe("sanitizeEffectiveAccentMeta", () => {
  it("passes valid records through as fresh clones", () => {
    const input = { ...META }
    const clean = sanitizeEffectiveAccentMeta(input)
    expect(clean).toEqual(META)
    expect(clean).not.toBe(input)
    // Mutating the input afterwards never leaks into the cleaned copy.
    input.genreHex = "#ffffff"
    expect(clean!.genreHex).toBe("#4e8087")
  })

  it("prunes unknown/secret-shaped keys", () => {
    const clean = sanitizeEffectiveAccentMeta({
      ...META,
      api_key: "secret",
      u: "uuid",
      cacheKey: "poster:v1:…",
      analysisKey: "portrait:poster:…",
      posterSrc: "/x.jpg",
      bandRGB: { r: 1, g: 2, b: 3 },
    })
    expect(clean).toEqual(META)
    expect(clean).not.toHaveProperty("api_key")
    expect(clean).not.toHaveProperty("cacheKey")
    expect(clean).not.toHaveProperty("analysisKey")
    expect(JSON.stringify(clean)).not.toContain("secret")
  })

  it("coerces invalid hexes to null + unknown (never a guessed color)", () => {
    const clean = sanitizeEffectiveAccentMeta({
      ...META,
      genreHex: "red",
      rankHex: "#fff",
    })
    expect(clean!.genreHex).toBeNull()
    expect(clean!.rankHex).toBeNull()
    expect(clean!.provGenre).toBe("unknown")
    expect(clean!.provRank).toBe("unknown")
  })

  it("drops painted claims without a valid hex", () => {
    const clean = sanitizeEffectiveAccentMeta({ ...META, genreHex: null })
    expect(clean!.genreHex).toBeNull()
    expect(clean!.provGenre).toBe("unknown")
  })

  it("keeps honest not-painted records (null hexes allowed)", () => {
    expect(sanitizeEffectiveAccentMeta({ ...NOT_PAINTED })).toEqual(NOT_PAINTED)
  })

  it("rejects non-objects and coerces bad enums/flags", () => {
    expect(sanitizeEffectiveAccentMeta(null)).toBeNull()
    expect(sanitizeEffectiveAccentMeta("x")).toBeNull()
    expect(sanitizeEffectiveAccentMeta(undefined)).toBeNull()
    const clean = sanitizeEffectiveAccentMeta({
      ...META,
      provGenre: "invented",
      topType: "rank-num",
      genrePaints: 1,
    })
    expect(clean!.provGenre).toBe("unknown")
    expect(clean!.topType).toBeNull()
    expect(clean!.genrePaints).toBe(false)
  })

  it("legacy records without gradient fields read as unknown gradient (never painted)", () => {
    const legacy = {
      genreHex: null,
      rankHex: null,
      genrePaints: false,
      topPaints: false,
      topType: null,
      provGenre: "not-painted",
      provRank: "not-painted",
    }
    const clean = sanitizeEffectiveAccentMeta(legacy)
    expect(clean!.gradientHex).toBeNull()
    expect(clean!.gradientPaints).toBe(false)
    // Honest unknown: an old header cannot say whether the gradient painted.
    expect(clean!.provGradient).toBe("unknown")
    // Badge sides keep their explicit honest state.
    expect(clean!.provGenre).toBe("not-painted")
    expect(clean!.provRank).toBe("not-painted")
  })

  it("round-trips the additive gradient entry and prunes secret-shaped gradient keys", () => {
    const clean = sanitizeEffectiveAccentMeta({
      ...META,
      bandRGB: { r: 1, g: 2, b: 3 },
    })
    expect(clean).toEqual(META)
    const painted = sanitizeEffectiveAccentMeta({
      genreHex: null,
      rankHex: null,
      genrePaints: false,
      topPaints: false,
      topType: null,
      provGenre: "not-painted",
      provRank: "not-painted",
      gradientHex: "#2a9d8f",
      gradientPaints: true,
      provGradient: "extracted",
    })
    expect(painted!.gradientHex).toBe("#2a9d8f")
    expect(painted!.gradientPaints).toBe(true)
    expect(painted!.provGradient).toBe("extracted")
  })

  it("drops gradient painted claims without a valid hex (never a guessed color)", () => {
    const clean = sanitizeEffectiveAccentMeta({
      ...META,
      gradientHex: "red",
      gradientPaints: true,
    })
    expect(clean!.gradientHex).toBeNull()
    expect(clean!.provGradient).toBe("unknown")
    // Badge sides survive the gradient coercion untouched.
    expect(clean!.genreHex).toBe("#4e8087")
  })
})

describe("accent sidecar on persisted entries", () => {
  it("round-trips meta with the same entry (bytes + headers)", () => {
    const key = "poster:eff:sidecar:1"
    writeCachedPoster(key, { buffer: Buffer.from("img"), etag: '"e1"', accentMeta: META })
    const hit = readCachedPoster(key)
    expect(hit.payload?.buffer).toEqual(Buffer.from("img"))
    expect(hit.payload?.accentMeta).toEqual(META)
  })

  it("old entries without meta read as absent (honest unknown downstream)", () => {
    const key = "poster:eff:sidecar:legacy"
    writeCachedPoster(key, { buffer: Buffer.from("img"), etag: '"e2"' })
    const hit = readCachedPoster(key)
    expect(hit.payload).not.toBeNull()
    expect(hit.payload?.accentMeta).toBeUndefined()
  })

  it("headers alone without bytes are never trusted", () => {
    const key = "poster:eff:headers-alone"
    // Simulate a KV-served headers record after the bytes were lost.
    cacheSet(`${key}:headers`, { etag: '"e3"', accentMeta: { ...META } }, ["poster"])
    const hit = readCachedPoster(key)
    expect(hit.payload).toBeNull()
  })

  it("malformed sidecars degrade to absent (legacy garbage safe)", () => {
    const key = "poster:eff:malformed"
    writeCachedPoster(key, { buffer: Buffer.from("img"), etag: '"e4"' })
    cacheSet(
      `${key}:headers`,
      { etag: '"e4"', accentMeta: { genreHex: "red", rankHex: 42, provGenre: "nope" } },
      ["poster"],
    )
    const hit = readCachedPoster(key)
    expect(hit.payload).not.toBeNull()
    // Bytes survive; the garbage meta coerces (no valid hex survives).
    expect(hit.payload?.accentMeta?.genreHex).toBeNull()
    expect(hit.payload?.accentMeta?.provGenre).toBe("unknown")
  })

  it("variant entries never clobber the canonical meta", () => {
    const canonical = "poster:eff:variant:canon"
    const variant = `${canonical}:fmtwebp`
    writeCachedPoster(canonical, { buffer: Buffer.from("img"), etag: '"e5"', accentMeta: META })
    writeCachedPoster(variant, { buffer: Buffer.from("webp"), etag: '"e5w"' })
    expect(readCachedPoster(canonical).payload?.accentMeta).toEqual(META)
    expect(readCachedPoster(variant).payload?.accentMeta).toBeUndefined()
  })
})

describe("completed accent records (late preview)", () => {
  it("reads back a recorded render (write-before-complete contract)", () => {
    const key = "poster:eff:completed:1"
    recordCompletedAccent(key, META)
    expect(readCompletedAccent(key)).toEqual(META)
  })

  it("returns cloned records (no cross-request mutation)", () => {
    const key = "poster:eff:completed:clone"
    recordCompletedAccent(key, META)
    const first = readCompletedAccent(key)!
    ;(first as { -readonly [K in keyof typeof first]: (typeof first)[K] }).genreHex = "#000000"
    expect(readCompletedAccent(key)).toEqual(META)
  })

  it("drops mutable caller input (records what was passed, immutably)", () => {
    const key = "poster:eff:completed:input"
    const input = { ...META }
    recordCompletedAccent(key, input)
    input.genreHex = "#000000"
    expect(readCompletedAccent(key)).toEqual(META)
  })

  it("rejects invalid payloads (nothing stored, honest unknown)", () => {
    recordCompletedAccent("poster:eff:completed:bad1", null)
    recordCompletedAccent("poster:eff:completed:bad2", undefined)
    recordCompletedAccent("poster:eff:completed:bad3", "hex" as unknown as EffectiveAccentMeta)
    expect(readCompletedAccent("poster:eff:completed:bad1")).toBeNull()
    expect(readCompletedAccent("poster:eff:completed:bad2")).toBeNull()
    expect(readCompletedAccent("poster:eff:completed:bad3")).toBeNull()
  })

  it(`expires after ${COMPLETED_ACCENT_TTL_MS}ms (>= boundary)`, () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const key = "poster:eff:completed:ttl"
    recordCompletedAccent(key, META)
    expect(readCompletedAccent(key)).toEqual(META)
    vi.setSystemTime(1_000_000 + COMPLETED_ACCENT_TTL_MS - 1)
    expect(readCompletedAccent(key)).toEqual(META)
    vi.setSystemTime(1_000_000 + COMPLETED_ACCENT_TTL_MS)
    expect(readCompletedAccent(key)).toBeNull()
  })

  it(`evicts deterministically at ${MAX_COMPLETED_ACCENT_RECORDS} entries (oldest first)`, () => {
    for (let i = 0; i < MAX_COMPLETED_ACCENT_RECORDS; i++) {
      recordCompletedAccent(`poster:eff:evict:${i}`, META)
    }
    expect(readCompletedAccent("poster:eff:evict:0")).toEqual(META)
    recordCompletedAccent("poster:eff:evict:new", META)
    expect(readCompletedAccent("poster:eff:evict:0")).toBeNull()
    expect(readCompletedAccent("poster:eff:evict:1")).toEqual(META)
    expect(readCompletedAccent("poster:eff:evict:new")).toEqual(META)
  })

  it("preview and final keys stay isolated (no collapsing across render-distinct requests)", () => {
    recordCompletedAccent("poster:eff:iso:preview=1", META)
    expect(readCompletedAccent("poster:eff:iso:preview=1")).toEqual(META)
    expect(readCompletedAccent("poster:eff:iso:final")).toBeNull()
  })
})
