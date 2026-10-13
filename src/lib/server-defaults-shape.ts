/**
 * Default effettivi per formato (`poster`/`landscape`) — risoluzione pura.
 *
 * FOGLIA CLIENT-SAFE: zero import runtime (solo `import type`, cancellati in
 * compilazione). `server-defaults.ts` importa `node:fs`, KV/ioredis e non può
 * stare nel bundle browser: un solo import runtime da lì dentro rompe la
 * build Turbopack con "Can't resolve 'dns'" (via `kv` → `ioredis`).
 * `server-defaults.ts` ri-esporta `effectiveDefaultsForShape` per
 * compatibilità (route, builder URL, test); i consumer client-reachable
 * (`poster-config`, importato dai settings `"use client"`) importano da qui.
 */

import type { ServerDefaults } from "./server-defaults"

/** Solo chiavi definite (undefined = segui il flat, mai clobberare). */
function pickDefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}

/**
 * Default effettivi per il formato richiesto: in landscape i valori definiti
 * di `defaults.landscape` vincono sui flat. Ritorna lo stesso oggetto quando
 * non c'è overlay da applicare (shape portrait o nessun profilo).
 */
export function effectiveDefaultsForShape(defaults: ServerDefaults, shape: "poster" | "landscape"): ServerDefaults {
  if (shape !== "landscape" || !defaults.landscape) return defaults
  // Lo spread preserva di proposito gli explicit-null ereditari del profilo
  // (ogni consumer normalizza via `??` sul flat): il cast mantiene la vista
  // storica del tipo senza alterare il runtime.
  return { ...defaults, ...pickDefined(defaults.landscape) } as ServerDefaults
}
