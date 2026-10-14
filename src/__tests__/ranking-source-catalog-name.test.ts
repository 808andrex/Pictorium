import { describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { buildManifestResponse } from "@/lib/build-manifest"
import { encodeConfig } from "@/lib/config-token"
import { getRegionDef } from "@/lib/regions"
import {
  rankingSourceBrowsingName,
  rankingSourceCatalogName,
} from "@/lib/ranking-source"

vi.mock("@/lib/server-defaults", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/server-defaults")>()
  const mocked = vi.fn(() => ({}))
  return { ...mod, getServerDefaults: mocked, getServerDefaultsChecked: vi.fn(async () => mocked()) }
})

function tokenWithRanking(
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

describe("rankingSourceCatalogName (popular/trending canonical names with flags)", () => {
  const itRegion = getRegionDef("IT")

  it("names a popular-driven movie Top 20 with the region flag prefix", () => {
    expect(
      rankingSourceCatalogName(
        "pictorium-jw-movies",
        "movie",
        { rankingSourceMovie: "jw:popular" },
        itRegion,
      ),
    ).toBe("🇮🇹 I più popolari — Film")
  })

  it("names a trending-driven series Top 20 with the region flag prefix", () => {
    expect(
      rankingSourceCatalogName(
        "pictorium-jw-series",
        "series",
        { rankingSourceSeries: "jw:trending" },
        itRegion,
      ),
    ).toBe("🇮🇹 In tendenza — Serie TV")
  })

  it("covers both slots for both modes with the region flag", () => {
    expect(
      rankingSourceCatalogName(
        "pictorium-jw-series",
        "series",
        { rankingSourceSeries: "jw:popular" },
        itRegion,
      ),
    ).toBe("🇮🇹 I più popolari — Serie TV")
    expect(
      rankingSourceCatalogName(
        "pictorium-jw-movies",
        "movie",
        { rankingSourceMovie: "jw:trending" },
        itRegion,
      ),
    ).toBe("🇮🇹 In tendenza — Film")
  })

  it("follows explicit country changes with the real country flag", () => {
    const us = getRegionDef("US")
    expect(
      rankingSourceCatalogName(
        "pictorium-jw-movies",
        "movie",
        { rankingSourceMovie: "jw:popular" },
        us,
      ),
    ).toBe("🇺🇸 I più popolari — Film")
    expect(
      rankingSourceCatalogName(
        "pictorium-jw-series",
        "series",
        { rankingSourceSeries: "jw:trending" },
        us,
      ),
    ).toBe("🇺🇸 In tendenza — Serie TV")
  })

  it("returns null for charts (regional Top 20 name applies) and for non-JW catalogs", () => {
    expect(
      rankingSourceCatalogName(
        "pictorium-jw-movies",
        "movie",
        { rankingSourceMovie: "" },
        itRegion,
      ),
    ).toBeNull()
    expect(
      rankingSourceCatalogName(
        "pictorium-netflix-movies",
        "movie",
        { rankingSourceMovie: "jw:popular" },
        itRegion,
      ),
    ).toBeNull()
  })
})

describe("rankingSourceBrowsingName (flagless browsing display)", () => {
  const itRegion = getRegionDef("IT")

  it("suppresses the flag for popular/trending on both slots", () => {
    expect(
      rankingSourceBrowsingName(
        "pictorium-jw-movies",
        "movie",
        { rankingSourceMovie: "jw:popular" },
        itRegion,
      ),
    ).toBe("I più popolari — Film")
    expect(
      rankingSourceBrowsingName(
        "pictorium-jw-series",
        "series",
        { rankingSourceSeries: "jw:popular" },
        itRegion,
      ),
    ).toBe("I più popolari — Serie TV")
    expect(
      rankingSourceBrowsingName(
        "pictorium-jw-movies",
        "movie",
        { rankingSourceMovie: "jw:trending" },
        itRegion,
      ),
    ).toBe("In tendenza — Film")
    expect(
      rankingSourceBrowsingName(
        "pictorium-jw-series",
        "series",
        { rankingSourceSeries: "jw:trending" },
        itRegion,
      ),
    ).toBe("In tendenza — Serie TV")
  })

  it("stays flagless on explicit country changes too", () => {
    const us = getRegionDef("US")
    expect(
      rankingSourceBrowsingName(
        "pictorium-jw-movies",
        "movie",
        { rankingSourceMovie: "jw:popular" },
        us,
      ),
    ).toBe("I più popolari — Film")
    expect(
      rankingSourceBrowsingName(
        "pictorium-jw-series",
        "series",
        { rankingSourceSeries: "jw:trending" },
        us,
      ),
    ).toBe("In tendenza — Serie TV")
  })

  it("passes custom source names through untouched and returns null for charts", () => {
    const customs = [
      { id: "mylist", name: "🚀 La mia lista", type: "movie" as const, url: "https://mdblist.com/lists/u/mylist" },
    ]
    expect(
      rankingSourceBrowsingName(
        "pictorium-jw-movies",
        "movie",
        { customCatalogs: customs, rankingSourceMovie: "mylist" },
        itRegion,
      ),
    ).toBe("🚀 La mia lista")
    expect(
      rankingSourceBrowsingName("pictorium-jw-movies", "movie", { rankingSourceMovie: "" }, itRegion),
    ).toBeNull()
  })
})

describe("Stremio manifest reflects the persisted popular/trending source", () => {
  it("serves the flagged popular name for the movie Top 20 while series keeps Top 20", async () => {
    const names = await manifestCatalogNames(tokenWithRanking("jw:popular", ""))
    expect(names.get("pictorium-jw-movies")).toBe("🇮🇹 I più popolari — Film")
    expect(names.get("pictorium-jw-series")).toBe("🇮🇹 Top 20 Italia — Serie TV")
  })

  it("serves the flagged trending name for the series Top 20", async () => {
    const names = await manifestCatalogNames(tokenWithRanking("", "jw:trending"))
    expect(names.get("pictorium-jw-series")).toBe("🇮🇹 In tendenza — Serie TV")
    expect(names.get("pictorium-jw-movies")).toBe("🇮🇹 Top 20 Italia — Film")
  })

  it("keeps charts names untouched without a selection", async () => {
    const names = await manifestCatalogNames(tokenWithRanking("", ""))
    expect(names.get("pictorium-jw-movies")).toBe("🇮🇹 Top 20 Italia — Film")
    expect(names.get("pictorium-jw-series")).toBe("🇮🇹 Top 20 Italia — Serie TV")
  })

  it("lets an explicit user rename win over the popular name", async () => {
    const names = await manifestCatalogNames(
      tokenWithRanking("jw:popular", "", {
        "pictorium-jw-movies": "La mia classifica",
      }),
    )
    expect(names.get("pictorium-jw-movies")).toBe("La mia classifica")
  })

  it("updates the manifest flag on explicit country change (US region)", async () => {
    const token = encodeConfig({
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
      rankingSourceMovie: "jw:popular",
      rankingSourceSeries: "jw:trending",
      region: "US",
    })
    const names = await manifestCatalogNames(token)
    expect(names.get("pictorium-jw-movies")).toBe("🇺🇸 I più popolari — Film")
    expect(names.get("pictorium-jw-series")).toBe("🇺🇸 In tendenza — Serie TV")
  })
})
