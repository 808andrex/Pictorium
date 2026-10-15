import { describe, it, expect } from "vitest"
import { isSensitiveKey, sanitizeLogData } from "@/lib/logger"

describe("logger sanitization", () => {
  describe("isSensitiveKey", () => {
    it("rileva chiavi sensibili esatte", () => {
      expect(isSensitiveKey("apiKey")).toBe(true)
      expect(isSensitiveKey("api_key")).toBe(true)
      expect(isSensitiveKey("tmdbKey")).toBe(true)
      expect(isSensitiveKey("tvdbApiKey")).toBe(true)
      expect(isSensitiveKey("mdblistKey")).toBe(true)
      expect(isSensitiveKey("password")).toBe(true)
      expect(isSensitiveKey("secret")).toBe(true)
      expect(isSensitiveKey("token")).toBe(true)
      expect(isSensitiveKey("authorization")).toBe(true)
      expect(isSensitiveKey("pin")).toBe(true)
    })

    it("rileva suffissi sensibili composti", () => {
      expect(isSensitiveKey("userToken")).toBe(true)
      expect(isSensitiveKey("clientSecret")).toBe(true)
      expect(isSensitiveKey("userPassword")).toBe(true)
      expect(isSensitiveKey("customApiKey")).toBe(true)
      expect(isSensitiveKey("userPin")).toBe(true)
      expect(isSensitiveKey("oldPin")).toBe(true)
    })

    it("NON tocca chiavi legittime di routing, cache e diagnostica", () => {
      expect(isSensitiveKey("cacheKey")).toBe(false)
      expect(isSensitiveKey("posterKey")).toBe(false)
      expect(isSensitiveKey("catalogKey")).toBe(false)
      expect(isSensitiveKey("rateLimitKey")).toBe(false)
      expect(isSensitiveKey("bucketKey")).toBe(false)
      expect(isSensitiveKey("keys")).toBe(false)
      expect(isSensitiveKey("kinds")).toBe(false)
      expect(isSensitiveKey("keyCount")).toBe(false)
      expect(isSensitiveKey("status")).toBe(false)
      expect(isSensitiveKey("id")).toBe(false)
    })
  })

  describe("sanitizeLogData", () => {
    it("offusca chiavi sensibili e preserva le altre", () => {
      const input = {
        userId: "12345",
        cacheKey: "movie:550",
        apiKey: "super_secret_tmdb_key",
        nested: {
          password: "my_password_123",
          catalogKey: "netflix-movies",
          secret: "jwt_token_abc",
        },
      }
      const sanitized = sanitizeLogData(input) as typeof input
      expect(sanitized.userId).toBe("12345")
      expect(sanitized.cacheKey).toBe("movie:550")
      expect(sanitized.apiKey).toBe("[REDACTED]")
      expect(sanitized.nested.catalogKey).toBe("netflix-movies")
      expect(sanitized.nested.password).toBe("[REDACTED]")
      expect(sanitized.nested.secret).toBe("[REDACTED]")
    })

    it("gestisce array e oggetti nidificati", () => {
      const input = {
        items: [
          { token: "abc", name: "test1" },
          { token: "def", name: "test2" },
        ],
      }
      const sanitized = sanitizeLogData(input) as typeof input
      expect(sanitized.items[0].token).toBe("[REDACTED]")
      expect(sanitized.items[0].name).toBe("test1")
      expect(sanitized.items[1].token).toBe("[REDACTED]")
      expect(sanitized.items[1].name).toBe("test2")
    })

    it("gestisce riferimenti circolari senza crashare", () => {
      const circular: Record<string, unknown> = {
        title: "Matrix",
        apiKey: "secret",
      }
      circular.self = circular

      const sanitized = sanitizeLogData(circular) as Record<string, unknown>
      expect(sanitized.title).toBe("Matrix")
      expect(sanitized.apiKey).toBe("[REDACTED]")
      expect(sanitized.self).toBe("[CIRCULAR]")
    })

    it("limita la profondita massima ricorsiva a 4 livelli", () => {
      const deep = { a: { b: { c: { d: { e: "too_deep" } } } } }
      const sanitized = sanitizeLogData(deep) as { a: { b: { c: { d: unknown } } } }
      expect(sanitized.a.b.c.d).toBe("[MAX_DEPTH]")
    })
  })
})
