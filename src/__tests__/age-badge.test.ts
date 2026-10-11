import { describe, expect, it } from "vitest"
import sharp from "sharp"
import { DEFAULT_AGE_COUNTRY, sanitizeAgeLabel } from "@/lib/certification"
import {
  resolveAgeBadgeRequest,
  resolvePosterRenderConfig,
  type PosterRenderConfigInput,
} from "@/lib/poster-config"
import { buildStremioPosterSearchParams } from "@/lib/stremio-poster-params"
import { normalizePosterCacheParams } from "@/lib/poster-runtime-cache"
import { buildDefaultsPreviewUrl, buildPreviewUrl } from "@/lib/poster-url"
import { generatePosterBuffer, renderQualityBadgeGroup, type GenerationInput } from "@/lib/poster-service"
import { STD_W, STD_H } from "@/lib/poster-render-helpers"
import type { WikidataResult } from "@/lib/awards"
import type { ServerDefaults } from "@/lib/server-defaults"
import type { VideoFormat } from "@/lib/av-specs"

function baseInput(overrides: Partial<PosterRenderConfigInput> = {}): PosterRenderConfigInput {
  return {
    searchParams: new URLSearchParams(),
    mapping: null,
    configOverride: null,
    sd: {},
    hasQuery: true,
    showBadges: true,
    rankingBadges: true,
    animeRank: null,
    rankingResult: null,
    finalRank: null,
    ...overrides,
  }
}

describe("sanitizeAgeLabel", () => {
  it("preserves genuine certification labels untouched", () => {
    expect(sanitizeAgeLabel("VM14")).toBe("VM14")
    expect(sanitizeAgeLabel("PG-13")).toBe("PG-13")
    expect(sanitizeAgeLabel("TV-MA")).toBe("TV-MA")
    expect(sanitizeAgeLabel("R18+")).toBe("R18+")
    expect(sanitizeAgeLabel("FSK 16")).toBe("FSK 16")
    expect(sanitizeAgeLabel("U")).toBe("U")
  })

  it("trims surrounding whitespace", () => {
    expect(sanitizeAgeLabel("  VM14  ")).toBe("VM14")
  })

  it("hides the badge on blank/non-string input", () => {
    expect(sanitizeAgeLabel("")).toBeNull()
    expect(sanitizeAgeLabel("   ")).toBeNull()
    expect(sanitizeAgeLabel(null)).toBeNull()
    expect(sanitizeAgeLabel(undefined)).toBeNull()
    expect(sanitizeAgeLabel(16)).toBeNull()
  })

  it("rejects markup and oversized labels (fail-open hide)", () => {
    expect(sanitizeAgeLabel("<b>VM14</b>")).toBeNull()
    expect(sanitizeAgeLabel("VM14<script>")).toBeNull()
    expect(sanitizeAgeLabel("VM14😀")).toBeNull()
    expect(sanitizeAgeLabel("A".repeat(13))).toBeNull()
    expect(sanitizeAgeLabel("A".repeat(12))).toBe("A".repeat(12))
  })
})

describe("resolveAgeBadgeRequest", () => {
  it("defaults to OFF with IT country", () => {
    expect(DEFAULT_AGE_COUNTRY).toBe("IT")
    const r = resolveAgeBadgeRequest(new URLSearchParams(), null, {}, null)
    expect(r.ageBadge).toBe(false)
    expect(r.ageCountry).toBe("IT")
  })

  it("query wins over config and defaults", () => {
    const q = new URLSearchParams({ age: "1", agecountry: "us" })
    const r = resolveAgeBadgeRequest(q, { ageBadge: false, ageCountry: "FR" } as never, { ageBadge: false, ageCountry: "DE" }, null)
    expect(r.ageBadge).toBe(true)
    expect(r.ageCountry).toBe("US")
  })

  it("explicit query OFF wins over enabled defaults", () => {
    const q = new URLSearchParams({ age: "0" })
    const r = resolveAgeBadgeRequest(q, null, { ageBadge: true, ageCountry: "US" }, null)
    expect(r.ageBadge).toBe(false)
    // Country still resolves (harmless: badge hidden, no fetch, same key).
    expect(r.ageCountry).toBe("US")
  })

  it("falls through per level on invalid country (never invents)", () => {
    // A valid-shape but unknown code ("xx" -> "XX") is accepted as-is: the
    // data layer hides the badge (no such TMDB territory), never a fallback.
    expect(resolveAgeBadgeRequest(new URLSearchParams({ agecountry: "xx" }), null, { ageCountry: "US" }, null).ageCountry).toBe("XX")
    // GLOBAL is explicitly excluded (not a certification territory).
    expect(resolveAgeBadgeRequest(new URLSearchParams({ agecountry: "GLOBAL" }), null, { ageCountry: "FR" }, null).ageCountry).toBe("FR")
    // Three-letter codes are not ISO alpha-2: fall through to the default.
    expect(resolveAgeBadgeRequest(new URLSearchParams({ agecountry: "USA" }), null, {}, null).ageCountry).toBe("IT")
    expect(resolveAgeBadgeRequest(new URLSearchParams({ agecountry: "USA" }), null, { ageCountry: "US" }, null).ageCountry).toBe("US")
    // Empty query value falls back to config, then defaults, then IT.
    expect(resolveAgeBadgeRequest(new URLSearchParams({ agecountry: "" }), { ageCountry: "DE" } as never, {}, null).ageCountry).toBe("DE")
  })

  it("config token participates between query and defaults", () => {
    const r = resolveAgeBadgeRequest(
      new URLSearchParams(),
      { ageBadge: true, ageCountry: "jp" } as never,
      { ageBadge: false, ageCountry: "FR" },
      null,
    )
    expect(r.ageBadge).toBe(true)
    expect(r.ageCountry).toBe("JP")
  })
})

describe("resolvePosterRenderConfig age pair", () => {
  it("resolves ageBadge/ageCountry with global-only chain (no mapping)", () => {
    const r = resolvePosterRenderConfig(baseInput({
      searchParams: new URLSearchParams({ age: "1", agecountry: "FR" }),
    }))
    expect(r.ageBadge).toBe(true)
    expect(r.ageCountry).toBe("FR")
  })

  it("ignores mapping for age (global-only like minQuality)", () => {
    const r = resolvePosterRenderConfig(baseInput({
      mapping: { tmdbId: 1, mediaType: "movie", title: "T", posterPath: "/p.jpg", logoPath: null, originalPosterPath: null, language: null, updatedAt: "2026-01-01", badgeQuality: true } as never,
      sd: { ageBadge: true, ageCountry: "US" },
    }))
    expect(r.ageBadge).toBe(true)
    expect(r.ageCountry).toBe("US")
  })

  it("default OFF preserves the legacy render path", () => {
    const r = resolvePosterRenderConfig(baseInput())
    expect(r.ageBadge).toBe(false)
    expect(r.ageCountry).toBe("IT")
  })
})

describe("stremio poster params age emission", () => {
  it("emits nothing when disabled (existing URLs byte-identical)", () => {
    const p = buildStremioPosterSearchParams({})
    expect(p.has("age")).toBe(false)
    expect(p.has("agecountry")).toBe(false)
    const p2 = buildStremioPosterSearchParams({ ageBadge: false, ageCountry: "US" })
    expect(p2.has("age")).toBe(false)
    expect(p2.has("agecountry")).toBe(false)
  })

  it("emits age=1 plus canonical country when enabled", () => {
    const p = buildStremioPosterSearchParams({ ageBadge: true, ageCountry: "us" })
    expect(p.get("age")).toBe("1")
    expect(p.get("agecountry")).toBe("US")
  })

  it("is explicit both ways with a config token (token must not win silently)", () => {
    const on = buildStremioPosterSearchParams({ config: "tok", ageBadge: true, ageCountry: "FR" })
    expect(on.get("age")).toBe("1")
    expect(on.get("agecountry")).toBe("FR")
    const off = buildStremioPosterSearchParams({ config: "tok" })
    expect(off.get("age")).toBe("0")
    expect(off.has("agecountry")).toBe(false)
  })

  it("never emits GLOBAL or garbage countries", () => {
    const g = buildStremioPosterSearchParams({ ageBadge: true, ageCountry: "GLOBAL" })
    expect(g.get("age")).toBe("1")
    expect(g.has("agecountry")).toBe(false)
  })
})

describe("poster cache key age handling", () => {
  it("keeps age params in the allowlist", () => {
    const p = normalizePosterCacheParams(new URLSearchParams("age=1&agecountry=US&bq=1"))
    expect(p.get("age")).toBe("1")
    expect(p.get("agecountry")).toBe("US")
  })

  it("canonicalizes lowercase countries to one key", () => {
    const a = normalizePosterCacheParams(new URLSearchParams("age=1&agecountry=us")).toString()
    const b = normalizePosterCacheParams(new URLSearchParams("age=1&agecountry=US")).toString()
    expect(a).toBe(b)
  })

  it("drops invalid countries so they collapse onto the default key", () => {
    const garbage = normalizePosterCacheParams(new URLSearchParams("age=1&agecountry=USA")).toString()
    const absent = normalizePosterCacheParams(new URLSearchParams("age=1")).toString()
    expect(garbage).toBe(absent)
    const global = normalizePosterCacheParams(new URLSearchParams("age=1&agecountry=GLOBAL")).toString()
    expect(global).toBe(absent)
    const digits = normalizePosterCacheParams(new URLSearchParams("age=1&agecountry=1A")).toString()
    expect(digits).toBe(absent)
  })

  it("keeps distinct countries on distinct keys", () => {
    const us = normalizePosterCacheParams(new URLSearchParams("age=1&agecountry=US")).toString()
    const it = normalizePosterCacheParams(new URLSearchParams("age=1&agecountry=IT")).toString()
    expect(us).not.toBe(it)
  })
})

describe("preview URL age roundtrip", () => {
  it("buildPreviewUrl is always explicit (WYSIWYG, defaults included)", () => {
    const ps = { selected: { id: 1 } } as never
    const off = new URL(buildPreviewUrl(ps, { ageBadge: false } as never))
    expect(off.searchParams.get("age")).toBe("0")
    expect(off.searchParams.get("agecountry")).toBe("IT")
    const on = new URL(buildPreviewUrl(ps, { ageBadge: true, ageCountry: "us" } as never))
    expect(on.searchParams.get("age")).toBe("1")
    expect(on.searchParams.get("agecountry")).toBe("US")
  })

  it("buildDefaultsPreviewUrl carries toggle plus independent country", () => {
    const off = new URL(buildDefaultsPreviewUrl({}))
    expect(off.searchParams.get("age")).toBe("0")
    expect(off.searchParams.get("agecountry")).toBe("IT")
    const on = new URL(buildDefaultsPreviewUrl({ defaultAgeBadge: true, defaultAgeCountry: "FR" }))
    expect(on.searchParams.get("age")).toBe("1")
    expect(on.searchParams.get("agecountry")).toBe("FR")
  })
})

describe("renderQualityBadgeGroup age stacking", () => {
  const PW = 380

  it("returns null with no quality, no formats and no age (legacy path)", async () => {
    await expect(renderQualityBadgeGroup(null, "standard", null, PW)).resolves.toBeNull()
    await expect(renderQualityBadgeGroup(null, "standard", [], PW, false, "inter", null)).resolves.toBeNull()
  })

  it("renders the age pill alone when 4K is absent", async () => {
    const group = await renderQualityBadgeGroup(null, "standard", null, PW, false, "inter", "VM14")
    expect(group).not.toBeNull()
    expect(group!.w).toBeGreaterThan(0)
    expect(group!.h).toBeGreaterThan(0)
    expect(group!.png.length).toBeGreaterThan(0)
  })

  it("stacks age below quality (taller group, same column)", async () => {
    const qualityOnly = await renderQualityBadgeGroup("4K", "standard", null, PW, false, "inter", null)
    const withAge = await renderQualityBadgeGroup("4K", "standard", null, PW, false, "inter", "VM14")
    expect(qualityOnly).not.toBeNull()
    expect(withAge).not.toBeNull()
    // Same column width family, strictly taller: quality on top, age below.
    expect(withAge!.h).toBeGreaterThan(qualityOnly!.h)
    expect(Math.abs(withAge!.w - qualityOnly!.w)).toBeLessThanOrEqual(qualityOnly!.w)
  })

  it("keeps the quality-only bitmap byte-identical without age", async () => {
    const a = await renderQualityBadgeGroup("4K", "standard", null, PW, false, "inter", null)
    const b = await renderQualityBadgeGroup("4K", "standard", null, PW, false, "inter", undefined)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a!.png.equals(b!.png)).toBe(true)
  })

  it("treats blank age as absent", async () => {
    await expect(renderQualityBadgeGroup(null, "standard", null, PW, false, "inter", "   ")).resolves.toBeNull()
    const q = await renderQualityBadgeGroup("4K", "standard", null, PW, false, "inter", "")
    const plain = await renderQualityBadgeGroup("4K", "standard", null, PW, false, "inter", null)
    expect(q!.png.equals(plain!.png)).toBe(true)
  })
})

describe("generatePosterBuffer age + disabled quality (production regression)", () => {
  async function darkPoster(): Promise<Buffer> {
    return sharp({
      create: { width: STD_W, height: STD_H, channels: 3, background: "#101010" },
    })
      .jpeg()
      .toBuffer()
  }

  function posterInput(overrides: Partial<GenerationInput> = {}): GenerationInput {
    return {
      posterBuf: Buffer.alloc(0),
      logoFetch: null,
      backdropFetch: null,
      backdropScale: 100,
      backdropOffsetX: 0,
      backdropOffsetY: 0,
      blurEnabled: false,
      blurHeight: 50,
      blurIntensity: 10,
      blurFade: 10,
      blurDarkness: 0,
      badgesEnabled: true,
      rankingEnabled: false,
      genreName: "Dramma",
      voteAverage: null,
      badgeStyle: "shadow",
      rankingBadgeStyle: "default",
      badgeGenre: true,
      badgeYear: false,
      badgeRating: false,
      topLight: false,
      targetCenter: 0,
      ribbonSide: "left",
      logoScale: null,
      logoOffsetX: null,
      logoOffsetY: null,
      topBadgeScale: 100,
      topBadgeOffsetX: 0,
      topBadgeOffsetY: 0,
      genreBadgeScale: 100,
      qualityBadgeScale: 100,
      separateBadgeScale: 100,
      networkLogoScale: 100,
      genreBadgeOffsetX: 0,
      genreBadgeOffsetY: 0,
      qualityBadgeOffsetX: 0,
      qualityBadgeOffsetY: 0,
      networkLogoOffsetX: 0,
      networkLogoOffsetY: 0,
      mediaType: "movie",
      finalRank: null,
      animeRankResult: null,
      rankingResult: null,
      mapping: null,
      tmdbNetworks: [],
      productionCompanies: [],
      tmdbStudios: [],
      tvType: null,
      tvStatus: null,
      releaseDate: null,
      firstAirDate: null,
      lastAirDate: null,
      seasonCount: null,
      originCountries: [],
      wikidataResult: { awards: [], nominations: [], studios: [], director: null } satisfies WikidataResult,
      tmdbKeywords: [],
      locale: "it",
      t: (k: string) => k,
      qLabel: null,
      queryExtra: null,
      qNetLogo: null,
      networkLogo: false,
      sd: {} satisfies ServerDefaults,
      accentOverride: null,
      imdbTop250: false,
      preRelease: false,
      ...overrides,
    }
  }

  const TECH_FORMATS = ["dv", "atmos"] as VideoFormat[]

  it("age-only with bq=0 renders byte-identical to no tech stack at all (hidden quality not revived)", async () => {
    const poster = await darkPoster()
    const suppliedButDisabled = await generatePosterBuffer(posterInput({
      posterBuf: poster,
      badgeQuality: false,
      quality: "4K",
      videoFormats: TECH_FORMATS,
      ageLabel: "VM14",
    }))
    const cleanAgeOnly = await generatePosterBuffer(posterInput({
      posterBuf: poster,
      badgeQuality: false,
      quality: null,
      videoFormats: null,
      ageLabel: "VM14",
    }))
    expect(suppliedButDisabled.equals(cleanAgeOnly)).toBe(true)
  })

  it("toggling age off with bq=0 removes the group without resurrecting tech", async () => {
    const poster = await darkPoster()
    const withAge = await generatePosterBuffer(posterInput({
      posterBuf: poster,
      badgeQuality: false,
      quality: "4K",
      videoFormats: TECH_FORMATS,
      ageLabel: "VM14",
    }))
    const withoutAge = await generatePosterBuffer(posterInput({
      posterBuf: poster,
      badgeQuality: false,
      quality: "4K",
      videoFormats: TECH_FORMATS,
      ageLabel: null,
    }))
    const legacy = await generatePosterBuffer(posterInput({
      posterBuf: poster,
      badgeQuality: false,
      quality: null,
      videoFormats: null,
      ageLabel: null,
    }))
    // The age pill was really rendered (group present with age, gone without).
    expect(withAge.equals(withoutAge)).toBe(false)
    // Age off + bq off + tech supplied = legacy bytes (tech stays hidden).
    expect(withoutAge.equals(legacy)).toBe(true)
  })

  it("enabled quality still stacks above age (ON behavior unchanged)", async () => {
    const poster = await darkPoster()
    const stacked = await generatePosterBuffer(posterInput({
      posterBuf: poster,
      badgeQuality: true,
      quality: "4K",
      videoFormats: null,
      ageLabel: "VM14",
    }))
    const qualityOnly = await generatePosterBuffer(posterInput({
      posterBuf: poster,
      badgeQuality: true,
      quality: "4K",
      videoFormats: null,
      ageLabel: null,
    }))
    const ageOnly = await generatePosterBuffer(posterInput({
      posterBuf: poster,
      badgeQuality: false,
      quality: null,
      videoFormats: null,
      ageLabel: "VM14",
    }))
    expect(stacked.equals(qualityOnly)).toBe(false)
    expect(stacked.equals(ageOnly)).toBe(false)
  })

  it("default off stays byte-identical (absent vs explicit nulls)", async () => {
    const poster = await darkPoster()
    const absent = await generatePosterBuffer(posterInput({ posterBuf: poster }))
    const explicit = await generatePosterBuffer(posterInput({
      posterBuf: poster,
      badgeQuality: true,
      quality: null,
      videoFormats: null,
      ageLabel: null,
    }))
    expect(absent.equals(explicit)).toBe(true)
  })
})
