import { describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { buildManifestResponse } from "@/lib/build-manifest"
import { encodeConfig } from "@/lib/config-token"
import { getRegionDef } from "@/lib/regions"
import {
  isCatalogEmojisShown,
  rankingSourceBrowsingName,
  rankingSourceCatalogName,
  resolveCatalogDisplayName,
  stripCatalogEmojis,
} from "@/lib/ranking-source"
import { regionJwName } from "@/lib/catalog-definitions"

vi.mock("@/lib/server-defaults", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/server-defaults")>()
  const mocked = vi.fn(() => ({}))
  return { ...mod, getServerDefaults: mocked, getServerDefaultsChecked: vi.fn(async () => mocked()) }
})

function tokenWithVisibility(
  catalogShowEmojis?: boolean,
  rankingSourceMovie?: string,
  rankingSourceSeries?: string,
  catalogRenames?: Record<string, string>,
) {
  return encodeConfig({
    globalBadges: true,
    rankingBadges: true,
    badgeStyle: "pill",
    rankingBadgeStyle: "default",
    blurEnabled: true,
    blurIntensity: 50,
    blurFade: 30,
    blurDarkness: 40,
    gradientHeight: 35,
    networkLogo: true,
    autoRotateClean: true,
    ...(catalogShowEmojis !== undefined ? { catalogShowEmojis } : {}),
    ...(rankingSourceMovie !== undefined ? { rankingSourceMovie } : {}),
    ...(rankingSourceSeries !== undefined ? { rankingSourceSeries } : {}),
    ...(catalogRenames ? { catalogRenames } : {}),
  })
}

async function manifestCatalogNames(token: string | null) {
  const req = new NextRequest(
    token
      ? `https://pictorium.test/manifest.json?config=${token}`
      : "https://pictorium.test/manifest.json",
  )
  const res = await buildManifestResponse(req, null, token)
  const data = (await res.json()) as {
    catalogs: Array<{ id: string; name: string; type: string }>
  }
  return new Map(data.catalogs.map((c) => [c.id, c.name]))
}

describe("stripCatalogEmojis (display-only catalog names)", () => {
  it("removes country flags but keeps text, digits and punctuation", () => {
    expect(stripCatalogEmojis("🇮🇹 Top 20 Italia — Film")).toBe("Top 20 Italia — Film")
    expect(stripCatalogEmojis("🇺🇸 I più popolari — Film")).toBe("I più popolari — Film")
  })

  it("removes leading pictographs with variation selectors", () => {
    expect(stripCatalogEmojis("🔴 Netflix — Film")).toBe("Netflix — Film")
    expect(stripCatalogEmojis("☁️ Sky Go / NOW — Film")).toBe("Sky Go / NOW — Film")
    expect(stripCatalogEmojis("⛩️ Top 20 Film Anime")).toBe("Top 20 Film Anime")
    expect(stripCatalogEmojis("🍥 Crunchyroll — Anime & Serie")).toBe("Crunchyroll — Anime & Serie")
    expect(stripCatalogEmojis("🔍 Pictorium — Cerca Film")).toBe("Pictorium — Cerca Film")
  })

  it("removes ZWJ sequences, hearts with VS16 and keycaps as a whole", () => {
    expect(stripCatalogEmojis("👨‍👩‍👧 Famiglia")).toBe("Famiglia")
    expect(stripCatalogEmojis("❤️ Amore")).toBe("Amore")
    expect(stripCatalogEmojis("1️⃣ Top")).toBe("Top")
  })

  it("keeps bare digits, accents and punctuation untouched", () => {
    expect(stripCatalogEmojis("Top 20")).toBe("Top 20")
    expect(stripCatalogEmojis("Città — I più popolari (2024)")).toBe("Città — I più popolari (2024)")
    expect(stripCatalogEmojis("I più popolari — Film")).toBe("I più popolari — Film")
  })

  it("leaves no invisible variation selectors, joiners or double spaces", () => {
    const out = stripCatalogEmojis("🇮🇹  Top 20  Italia — Film ☁️")
    expect(out).toBe("Top 20 Italia — Film")
    expect(out).not.toMatch(/[\uFE0E\uFE0F\u200D]/)
    expect(out).not.toMatch(/  /)
  })

  it("handles empty input", () => {
    expect(stripCatalogEmojis("")).toBe("")
  })

  it("preserves CJK punctuation/text, enclosed CJK, ordinary arrows and plain copyright", () => {
    // CJK brackets/punctuation (U+3000–U+303F) are text, never emoji.
    expect(stripCatalogEmojis("「映画」、ドラマ。")).toBe("「映画」、ドラマ。")
    // Ordinary arrows (U+2190–U+21FF) in text form carry no VS16: not emoji.
    expect(stripCatalogEmojis("Top 20 → Film")).toBe("Top 20 → Film")
    // Plain ©/® default to text: only the VS16 emoji forms are stripped.
    expect(stripCatalogEmojis("© 2026")).toBe("© 2026")
    // Enclosed CJK in text form (U+3200–U+32FF) is text, never emoji.
    expect(stripCatalogEmojis("㈱ Top — Anime")).toBe("㈱ Top — Anime")
    expect(stripCatalogEmojis("㊗ Top")).toBe("㊗ Top")
  })

  it("still removes default-emoji, VS16 and skin-tone forms", () => {
    expect(stripCatalogEmojis("⭐ Top")).toBe("Top")
    expect(stripCatalogEmojis("©️ Top")).toBe("Top")
    expect(stripCatalogEmojis("❤️ Top")).toBe("Top")
    expect(stripCatalogEmojis("☁️ Top")).toBe("Top")
    expect(stripCatalogEmojis("👍🏽 Top")).toBe("Top")
    expect(stripCatalogEmojis("㊗️ Top")).toBe("Top")
  })
})

describe("catalog emoji visibility preference", () => {
  it("defaults to shown (undefined/null/true), hidden only on false", () => {
    expect(isCatalogEmojisShown(undefined)).toBe(true)
    expect(isCatalogEmojisShown(null)).toBe(true)
    expect(isCatalogEmojisShown(true)).toBe(true)
    expect(isCatalogEmojisShown(false)).toBe(false)
  })

  it("returns the stored name untouched when shown", () => {
    expect(resolveCatalogDisplayName("🇮🇹 Top 20 Italia — Film", true)).toBe("🇮🇹 Top 20 Italia — Film")
    expect(resolveCatalogDisplayName("🇮🇹 Top 20 Italia — Film", undefined)).toBe("🇮🇹 Top 20 Italia — Film")
  })

  it("strips for display when hidden without mutating the stored value", () => {
    const stored = "🚀 La mia lista — Film"
    expect(resolveCatalogDisplayName(stored, false)).toBe("La mia lista — Film")
    expect(stored).toBe("🚀 La mia lista — Film")
  })
})

describe("Popular/Trending canonical names carry the region flag; browsing stays flagless", () => {
  const itRegion = getRegionDef("IT")

  it("has the flag on movie AND series popular canonical names", () => {
    expect(
      rankingSourceCatalogName("pictorium-jw-movies", "movie", { rankingSourceMovie: "jw:popular" }, itRegion),
    ).toBe("🇮🇹 I più popolari — Film")
    expect(
      rankingSourceCatalogName("pictorium-jw-series", "series", { rankingSourceSeries: "jw:popular" }, itRegion),
    ).toBe("🇮🇹 I più popolari — Serie TV")
  })

  it("has the flag on movie AND series trending canonical names", () => {
    expect(
      rankingSourceCatalogName("pictorium-jw-movies", "movie", { rankingSourceMovie: "jw:trending" }, itRegion),
    ).toBe("🇮🇹 In tendenza — Film")
    expect(
      rankingSourceCatalogName("pictorium-jw-series", "series", { rankingSourceSeries: "jw:trending" }, itRegion),
    ).toBe("🇮🇹 In tendenza — Serie TV")
  })

  it("follows the real country flag while browsing stays flagless", () => {
    const us = getRegionDef("US")
    expect(
      rankingSourceCatalogName("pictorium-jw-movies", "movie", { rankingSourceMovie: "jw:popular" }, us),
    ).toBe("🇺🇸 I più popolari — Film")
    expect(
      rankingSourceBrowsingName("pictorium-jw-movies", "movie", { rankingSourceMovie: "jw:popular" }, us),
    ).toBe("I più popolari — Film")
    expect(
      rankingSourceBrowsingName("pictorium-jw-series", "series", { rankingSourceSeries: "jw:trending" }, us),
    ).toBe("In tendenza — Serie TV")
  })

  it("keeps the Charts flag via the regional default", () => {
    expect(regionJwName("pictorium-jw-movies", "movie", itRegion)).toBe("🇮🇹 Top 20 Italia — Film")
    expect(regionJwName("pictorium-jw-series", "series", itRegion)).toBe("🇮🇹 Top 20 Italia — Serie TV")
  })
})

describe("Stremio manifest follows the emoji visibility selection", () => {
  it("keeps full flagged names by default (current behavior)", async () => {
    const names = await manifestCatalogNames(tokenWithVisibility(undefined, "jw:popular", ""))
    expect(names.get("pictorium-jw-movies")).toBe("🇮🇹 I più popolari — Film")
    expect(names.get("pictorium-jw-series")).toBe("🇮🇹 Top 20 Italia — Serie TV")
    expect(names.get("pictorium-search-movies")).toBe("🔍 Pictorium — Cerca Film")
  })

  it("strips every catalog name when hidden, including popular flags and search rows", async () => {
    const names = await manifestCatalogNames(tokenWithVisibility(false, "jw:popular", ""))
    expect(names.get("pictorium-jw-movies")).toBe("I più popolari — Film")
    expect(names.get("pictorium-jw-series")).toBe("Top 20 Italia — Serie TV")
    expect(names.get("pictorium-netflix-movies")).toBe("Netflix — Film")
    expect(names.get("pictorium-search-movies")).toBe("Pictorium — Cerca Film")
  })

  it("lets an explicit user rename win and strips only for display", async () => {
    const names = await manifestCatalogNames(
      tokenWithVisibility(false, "jw:popular", "", {
        "pictorium-jw-movies": "🚀 La mia classifica",
      }),
    )
    expect(names.get("pictorium-jw-movies")).toBe("La mia classifica")
  })
})
