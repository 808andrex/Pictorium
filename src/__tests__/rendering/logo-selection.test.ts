import { describe, expect, it } from "vitest"
import { selectBestLogo, logoBestLogoFallbackReason, logoDefaultScale } from "@/lib/logo-selection"
import type { TMDBImage } from "@/lib/types"

const logo = (iso: string | null): TMDBImage => ({
  file_path: `/${iso ?? "null"}.png`, iso_639_1: iso, vote_average: 1, width: 500, height: 200,
})

describe("selectBestLogo", () => {
  it("returns the requested language when present", () => {
    expect(selectBestLogo([logo("en"), logo("he")], "he")?.iso_639_1).toBe("he")
  })

  it("falls back to English, not Italian, for a non-Italian language", () => {
    // Regressione: l'italiano era il tier 2 per OGNI lingua, quindi un utente
    // ebraico senza logo in ebraico riceveva quello italiano prima dell'inglese.
    expect(selectBestLogo([logo("it"), logo("en")], "he")?.iso_639_1).toBe("en")
    expect(selectBestLogo([logo("it"), logo("en")], "ja")?.iso_639_1).toBe("en")
  })

  it("prefers English over the original language", () => {
    expect(selectBestLogo([logo("ja"), logo("en")], "he", "ja")?.iso_639_1).toBe("en")
  })

  it("falls back to the original language when English is missing", () => {
    expect(selectBestLogo([logo("ko"), logo("ja")], "he", "ja")?.iso_639_1).toBe("ja")
  })

  it("falls back to the first available logo", () => {
    expect(selectBestLogo([logo("ko")], "he", "ja")?.iso_639_1).toBe("ko")
  })

  it("keeps the Italian order unchanged for Italian users", () => {
    expect(selectBestLogo([logo("en"), logo("it")], "it")?.iso_639_1).toBe("it")
    expect(selectBestLogo([logo("en"), logo("ja")], "it", "ja")?.iso_639_1).toBe("en")
  })

  it("returns undefined for an empty list", () => {
    expect(selectBestLogo([], "he")).toBeUndefined()
  })
})

describe("logoDefaultScale", () => {
  const sized = (w: number | null, h: number | null): TMDBImage => ({
    file_path: "/x.png", iso_639_1: "en", vote_average: 1,
    width: w as number, height: h as number,
  })

  it("scales sublinearly with aspect (2/3-power curve, cap 75)", () => {
    expect(logoDefaultScale(sized(400, 400))).toBe(38) // 1:1 invariato
    expect(logoDefaultScale(sized(600, 400))).toBe(49) // 1.5:1
    expect(logoDefaultScale(sized(800, 400))).toBe(60) // 2:1 (Joker)
    expect(logoDefaultScale(sized(1000, 400))).toBe(69) // 2.5:1
    expect(logoDefaultScale(sized(1200, 400))).toBe(75) // 3:1 al cap
  })

  it("returns null without dimensions", () => {
    expect(logoDefaultScale(sized(null, null))).toBeNull()
    expect(logoDefaultScale(sized(0, 100))).toBeNull()
    expect(logoDefaultScale(sized(100, 0))).toBeNull()
  })
})

describe("logoBestLogoFallbackReason", () => {
  it("treats an exact match and English as non-fallbacks", () => {
    expect(logoBestLogoFallbackReason(logo("he"), "he")).toBeNull()
    expect(logoBestLogoFallbackReason(logo("en"), "he")).toBeNull()
  })

  it("no longer whitelists Italian for other languages", () => {
    expect(logoBestLogoFallbackReason(logo("it"), "he")).toBe("any")
  })

  it("reports origLang and none", () => {
    expect(logoBestLogoFallbackReason(logo("ja"), "he", "ja")).toBe("origLang")
    expect(logoBestLogoFallbackReason(undefined, "he")).toBe("none")
  })
})
