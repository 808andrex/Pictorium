import { describe, it, expect } from "vitest"
import { normalizeGenreName } from "@/lib/genre-normalize"
import { GENRE_FALLBACK } from "@/lib/badges"

describe("normalizeGenreName (TV compound genres)", () => {
  it("maps Sci-Fi & Fantasy to Fantascienza in Italian", () => {
    expect(normalizeGenreName("Sci-Fi & Fantasy", "it")).toBe("Fantascienza")
    expect(normalizeGenreName("Sci-Fi & Fantasy", "it-IT")).toBe("Fantascienza")
  })

  it("maps Sci-Fi & Fantasy to Sci-Fi in English/other langs", () => {
    expect(normalizeGenreName("Sci-Fi & Fantasy", "en")).toBe("Sci-Fi")
    expect(normalizeGenreName("Sci-Fi & Fantasy", "en-US")).toBe("Sci-Fi")
    expect(normalizeGenreName("Sci-Fi & Fantasy")).toBe("Sci-Fi")
  })

  it("maps Action & Adventure deterministically (Azione/Action)", () => {
    expect(normalizeGenreName("Action & Adventure", "it")).toBe("Azione")
    expect(normalizeGenreName("Action & Adventure", "en")).toBe("Action")
  })

  it("maps War & Politics deterministically (Guerra/War)", () => {
    expect(normalizeGenreName("War & Politics", "it")).toBe("Guerra")
    expect(normalizeGenreName("War & Politics", "en")).toBe("War")
  })

  it("is case-insensitive and idempotent", () => {
    expect(normalizeGenreName("sci-fi & fantasy", "it")).toBe("Fantascienza")
    expect(normalizeGenreName("Fantascienza", "it")).toBe("Fantascienza")
    expect(normalizeGenreName("Sci-Fi", "en")).toBe("Sci-Fi")
    expect(normalizeGenreName(normalizeGenreName("Sci-Fi & Fantasy", "it"), "it")).toBe("Fantascienza")
  })

  it("passes other genres through (trimmed)", () => {
    expect(normalizeGenreName("Dramma", "it")).toBe("Dramma")
    expect(normalizeGenreName("  Drama  ", "en")).toBe("Drama")
    expect(normalizeGenreName(null, "it")).toBe("")
    expect(normalizeGenreName(undefined, "en")).toBe("")
  })

  it("normalized labels always hit GENRE_FALLBACK (never grey)", () => {
    for (const [raw, lang] of [
      ["Sci-Fi & Fantasy", "it"],
      ["Sci-Fi & Fantasy", "en"],
      ["Action & Adventure", "it"],
      ["Action & Adventure", "en"],
      ["War & Politics", "it"],
      ["War & Politics", "en"],
    ] as const) {
      const label = normalizeGenreName(raw, lang)
      expect(GENRE_FALLBACK[label]).toBeDefined()
    }
  })

  it("raw compound fallbacks exist as safety net for historic mappings", () => {
    expect(GENRE_FALLBACK["Sci-Fi & Fantasy"]).toBe(GENRE_FALLBACK["Fantascienza"])
    expect(GENRE_FALLBACK["Action & Adventure"]).toBeDefined()
    expect(GENRE_FALLBACK["War & Politics"]).toBeDefined()
  })
})
