import { describe, expect, it, vi } from "vitest"
import { countActiveUsers, USER_ACTIVE_WINDOW_MS, type UserInfo } from "@/lib/user-activity"

describe("countActiveUsers", () => {
  it("restituisce 0 per lista vuota", () => {
    expect(countActiveUsers([])).toBe(0)
  })

  it("conta utenti con attività entro 7 giorni", () => {
    const now = Date.now()
    const users: UserInfo[] = [
      { uuid: "u1", lastAccess: new Date(now - 1 * 86400000).toISOString(), bytes: 100 },
      { uuid: "u2", lastAccess: new Date(now - 6 * 86400000).toISOString(), bytes: 100 },
    ]
    expect(countActiveUsers(users)).toBe(2)
  })

  it("bordo inclusivo: include utente esattamente a cutoff (now - 7gg)", () => {
    // Clock congelato: il confronto esatto al millisecondo è flaky con
    // Date.now() reale (bastano 1-2ms tra fixture e cutoff sotto carico).
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"))
      const now = Date.now()
      const users: UserInfo[] = [
        { uuid: "u1", lastAccess: new Date(now - USER_ACTIVE_WINDOW_MS).toISOString(), bytes: 100 },
      ]
      expect(countActiveUsers(users)).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("esclude utenti con attività oltre 7 giorni", () => {
    const now = Date.now()
    const users: UserInfo[] = [
      { uuid: "u1", lastAccess: new Date(now - 8 * 86400000).toISOString(), bytes: 100 },
    ]
    expect(countActiveUsers(users)).toBe(0)
  })

  it("ignora lastAccess null o stringa di data non valida", () => {
    const users: UserInfo[] = [
      { uuid: "u1", lastAccess: null, bytes: 100 },
      { uuid: "u2", lastAccess: "invalid-date", bytes: 100 },
      { uuid: "u3", lastAccess: "", bytes: 100 },
    ]
    expect(countActiveUsers(users)).toBe(0)
  })

  it("calcola correttamente su lista mista", () => {
    const now = Date.now()
    const users: UserInfo[] = [
      { uuid: "u1", lastAccess: new Date(now - 2 * 86400000).toISOString(), bytes: 100 }, // attivo
      { uuid: "u2", lastAccess: new Date(now - 8 * 86400000).toISOString(), bytes: 100 }, // vecchio
      { uuid: "u3", lastAccess: null, bytes: 100 }, // mai usato
      { uuid: "u4", lastAccess: new Date(now - 12 * 3600000).toISOString(), bytes: 100 }, // attivo (12h)
      { uuid: "u5", lastAccess: "not-a-timestamp", bytes: 100 }, // corrotto
    ]
    expect(countActiveUsers(users)).toBe(2)
  })

  it("rispetta parametro windowMs personalizzato", () => {
    const now = Date.now()
    const users: UserInfo[] = [
      { uuid: "u1", lastAccess: new Date(now - 2 * 86400000).toISOString(), bytes: 100 },
    ]
    // Con finestra 1 giorno è inattivo, con finestra 3 giorni è attivo
    expect(countActiveUsers(users, 1 * 86400000)).toBe(0)
    expect(countActiveUsers(users, 3 * 86400000)).toBe(1)
  })
})
