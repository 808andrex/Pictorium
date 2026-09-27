import { describe, it, expect } from "vitest"
import { lookupAwardIds, withIdAwards, withIdNoms } from "@/lib/award-ids"
import { computeTopBadge } from "@/lib/poster-badge"
import { createT } from "@/lib/i18n"

const t = createT("it")

describe("lookupAwardIds", () => {
  it("Oscar winner beats everything (Oppenheimer: anche Globe, Oscar primo)", () => {
    expect(lookupAwardIds(872585, "movie")).toEqual({ wins: ["Oscar", "Golden Globe"], noms: [] })
  })

  it("Globe winner movie without Oscar (The Revenant)", () => {
    expect(lookupAwardIds(281957, "movie")).toEqual({ wins: ["Golden Globe"], noms: [] })
  })

  it("Oscar nominee without win (Barbie)", () => {
    expect(lookupAwardIds(346698, "movie")).toEqual({ wins: [], noms: ["Oscar"] })
  })

  it("Palma d'Oro winner (Parasite vince anche l'Oscar: Oscar primo)", () => {
    expect(lookupAwardIds(496243, "movie")).toEqual({ wins: ["Oscar", "Cannes"], noms: [] })
  })

  it("Leone d'Oro winner (Joker)", () => {
    expect(lookupAwardIds(475557, "movie")).toEqual({ wins: ["Venezia"], noms: [] })
  })

  it("TV: Emmy winner (Breaking Bad)", () => {
    expect(lookupAwardIds(1396, "tv")).toEqual({ wins: ["Emmy"], noms: [] })
  })

  it("TV: Globe winner without Emmy (Abbott Elementary)", () => {
    expect(lookupAwardIds(125935, "tv")).toEqual({ wins: ["Golden Globe"], noms: [] })
  })

  it("namespace separati: film/105 non è tv/105", () => {
    // 105 film (Ritorno al futuro) non sta in nessuna lista: resta vuoto
    // anche se un giorno un tv/105 vincesse un Emmy.
    expect(lookupAwardIds(105, "movie")).toEqual({ wins: [], noms: [] })
    // Oppenheimer come serie TV: niente (ID da mondo film).
    expect(lookupAwardIds(872585, "tv")).toEqual({ wins: [], noms: [] })
    // Breaking Bad come film: niente (ID da mondo serie).
    expect(lookupAwardIds(1396, "movie")).toEqual({ wins: [], noms: [] })
  })

  it("sconosciuto/invalido → vuoto (mai un bollino inventato)", () => {
    expect(lookupAwardIds(999999999, "movie")).toEqual({ wins: [], noms: [] })
    expect(lookupAwardIds(null, "movie")).toEqual({ wins: [], noms: [] })
    expect(lookupAwardIds(undefined, "tv")).toEqual({ wins: [], noms: [] })
    expect(lookupAwardIds(NaN, "movie")).toEqual({ wins: [], noms: [] })
    expect(lookupAwardIds(-5, "movie")).toEqual({ wins: [], noms: [] })
  })
})

describe("withIdAwards / withIdNoms", () => {
  it("certi in testa, generici intatti, dedup", () => {
    expect(withIdAwards(872585, "movie", ["BAFTA"])).toEqual(["Oscar", "Golden Globe", "BAFTA"])
    expect(withIdAwards(872585, "movie", ["Oscar", "Golden Globe", "BAFTA"])).toEqual(["Oscar", "Golden Globe", "BAFTA"])
    expect(withIdNoms(346698, "movie", ["BAFTA"])).toEqual(["Oscar", "BAFTA"])
  })

  it("senza match restituisce copia uguale", () => {
    expect(withIdAwards(null, "movie", ["Oscar"])).toEqual(["Oscar"])
    expect(withIdNoms(999999999, "tv", [])).toEqual([])
  })
})

describe("computeTopBadge con liste ID", () => {
  const base = {
    mediaType: "movie" as const,
    releaseDate: null,
    firstAirDate: null,
    lastAirDate: null,
    seasonCount: null,
    originCountries: [] as string[],
    voteAverage: 8,
    trendRank: null,
    animeRank: null,
    awards: [] as string[],
    nominations: [] as string[],
    studios: [] as string[],
    director: null,
    tvType: null,
    tvStatus: null,
    keywords: [] as string[],
    imdbTop250: false,
  }

  it("Oppenheimer da ID: vince l'Oscar anche senza Wikidata", () => {
    const c = computeTopBadge({ ...base, tmdbId: 872585 }, t, "it")
    expect(c.awardBadge).toBe("Oscar")
    expect(c.badge?.label).toBe("Oscar")
  })

  it("Barbie da ID: nomination senza vittoria", () => {
    const c = computeTopBadge({ ...base, tmdbId: 346698 }, t, "it")
    expect(c.badge?.label).toBe("Candidato Oscar")
  })

  it("senza tmdbId: comportamento invariato (solo Wikidata)", () => {
    const c = computeTopBadge({ ...base, awards: ["Emmy"] }, t, "it")
    expect(c.awardBadge).toBe("Emmy")
  })

  it("Breaking Bad: Emmy batte Golden Globe anche con entrambe le label", () => {
    const tvBase = { ...base, mediaType: "tv" as const }
    const c = computeTopBadge({ ...tvBase, tmdbId: 1396, awards: ["Golden Globe", "Emmy"] }, t, "it")
    expect(c.awardBadge).toBe("Emmy")
    expect(c.badge?.label).toBe("Emmy")
  })
})
