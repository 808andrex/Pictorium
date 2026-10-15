import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveLogoFitEnabled, type LogoFitInputs } from "@/lib/best-fit-config"

// BEST_FIT_GLOBAL è letto a module-load (`const raw = process.env...`), quindi
// ogni import deve avvenire DOPO l'impostazione dell'env (stesso pattern di
// config-token.test.ts). `importConfig()` resetta il registro moduli e
// re-importa così il modulo legge l'env corrente.
async function importConfig() {
  vi.resetModules()
  return import("@/lib/best-fit-config")
}

describe("POSTERIUM_BEST_FIT_ENABLED (module-level)", () => {
  beforeEach(() => {
    delete process.env.POSTERIUM_BEST_FIT_ENABLED
  })
  afterEach(() => {
    delete process.env.POSTERIUM_BEST_FIT_ENABLED
    vi.resetModules()
  })

  it("auto quando la variabile non è impostata", async () => {
    delete process.env.POSTERIUM_BEST_FIT_ENABLED
    const { BEST_FIT_GLOBAL } = await importConfig()
    expect(BEST_FIT_GLOBAL).toBe("auto")
  })

  it("off per valori falsy", async () => {
    for (const v of ["0", "false", "off", "no", "OFF"]) {
      process.env.POSTERIUM_BEST_FIT_ENABLED = v
      const { BEST_FIT_GLOBAL } = await importConfig()
      expect(BEST_FIT_GLOBAL, `valore: ${v}`).toBe("off")
    }
  })

  it("on per valori truthy", async () => {
    for (const v of ["1", "true", "on", "yes", "ON"]) {
      process.env.POSTERIUM_BEST_FIT_ENABLED = v
      const { BEST_FIT_GLOBAL } = await importConfig()
      expect(BEST_FIT_GLOBAL, `valore: ${v}`).toBe("on")
    }
  })

  it("ignora spazi bianchi", async () => {
    process.env.POSTERIUM_BEST_FIT_ENABLED = " 0 "
    const { BEST_FIT_GLOBAL } = await importConfig()
    expect(BEST_FIT_GLOBAL).toBe("off")
  })
})

describe("resolveLogoFitEnabled — globale > query > config > per-shape > legacy", () => {
  const base: LogoFitInputs = {
    global: "auto",
    queryLogoFit: null,
    configLogoFit: undefined,
    sdFit: null,
    isLandscape: false,
  }

  it("default spento con tutto undefined", () => {
    expect(resolveLogoFitEnabled(base)).toBe(false)
    expect(resolveLogoFitEnabled({ ...base, sdFit: {} })).toBe(false)
  })

  it("globale vince su tutto", () => {
    const on = { ...base, queryLogoFit: "0", configLogoFit: false, sdFit: { defaultPortraitFitEnabled: false } }
    expect(resolveLogoFitEnabled({ ...on, global: "off" })).toBe(false)
    expect(resolveLogoFitEnabled({ ...on, global: "on" })).toBe(true)
  })

  it("query vince su config e defaults", () => {
    const sd = { defaultPortraitFitEnabled: true }
    expect(resolveLogoFitEnabled({ ...base, queryLogoFit: "0", configLogoFit: true, sdFit: sd })).toBe(false)
    expect(resolveLogoFitEnabled({ ...base, queryLogoFit: "1", configLogoFit: false, sdFit: {} })).toBe(true)
  })

  it("config vince sui defaults", () => {
    const sd = { defaultPortraitFitEnabled: true }
    expect(resolveLogoFitEnabled({ ...base, configLogoFit: false, sdFit: sd })).toBe(false)
    expect(resolveLogoFitEnabled({ ...base, configLogoFit: true, sdFit: {} })).toBe(true)
  })

  it("per-shape del namespace abilita il fit (ponte UI → Stremio)", () => {
    expect(
      resolveLogoFitEnabled({ ...base, sdFit: { defaultPortraitFitEnabled: true }, isLandscape: false }),
    ).toBe(true)
    expect(
      resolveLogoFitEnabled({ ...base, sdFit: { defaultLandscapeFitEnabled: true }, isLandscape: true }),
    ).toBe(true)
  })

  it("per-shape segue il canvas: portrait ON non accende il landscape", () => {
    const sd = { defaultPortraitFitEnabled: true }
    expect(resolveLogoFitEnabled({ ...base, sdFit: sd, isLandscape: false })).toBe(true)
    expect(resolveLogoFitEnabled({ ...base, sdFit: sd, isLandscape: true })).toBe(false)
  })

  it("per-shape esplicito vince sul legacy", () => {
    const sd = { defaultPortraitFitEnabled: false, defaultLogoFitEnabled: true }
    expect(resolveLogoFitEnabled({ ...base, sdFit: sd, isLandscape: false })).toBe(false)
    const sd2 = { defaultLandscapeFitEnabled: true, defaultLogoFitEnabled: false }
    expect(resolveLogoFitEnabled({ ...base, sdFit: sd2, isLandscape: true })).toBe(true)
  })

  it("legacy resta fallback quando il per-shape manca", () => {
    expect(resolveLogoFitEnabled({ ...base, sdFit: { defaultLogoFitEnabled: true } })).toBe(true)
    expect(resolveLogoFitEnabled({ ...base, sdFit: { defaultLogoFitEnabled: false } })).toBe(false)
  })
})
