import { describe, it, expect } from "vitest"
import { badgeCacheKey } from "@/lib/poster-service"
import { RENDER_VERSION } from "@/lib/render-version"

describe("badgeCacheKey", () => {
  it("embeds the render version so renderer changes bust bitmap entries", () => {
    expect(badgeCacheKey("genre", "Azione")).toContain(`badge:genre:${RENDER_VERSION}:`)
  })

  it("escapes string segments (labels with colons cannot collide with later fields)", () => {
    expect(badgeCacheKey("extra", "Top:10")).toContain("Top%3A10")
  })

  it("distinguishes entries by parts", () => {
    expect(badgeCacheKey("rank", "#1 Oggi", 380)).not.toBe(badgeCacheKey("rank", "#2 Oggi", 380))
  })
})
