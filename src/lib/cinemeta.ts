import { cacheGet, cacheSet } from "./cache"
import { timedFetch } from "./outbound-stats"
import { createLogger } from "@/lib/logger"
import { envWithFallback } from "@/lib/env-compat"
import { createCircuitBreaker, parseRetryAfterMs } from "@/lib/circuit-breaker"
import { combineAbortSignals, raceWithAbort } from "@/lib/abort-signal"

const log = createLogger("cinemeta")

// Override E2E/mock deterministico (stesso pattern degli altri provider): in
// produzione la env è assente e si usa l'endpoint reale (pubblico, nessuna key).
const CINEMETA_BASE = process.env.CINEMETA_API_URL || "https://v3-cinemeta.strem.io"

const CINEMETA_TIMEOUT_MS = (() => {
  const raw = envWithFallback("CINEMETA_TIMEOUT_MS")
  const n = raw ? parseInt(raw, 10) : 1500
  return Number.isFinite(n) && n >= 300 && n <= 10000 ? n : 1500
})()

// Fail-open breaker dedicato: 3 fallimenti consecutivi → 30s di cooldown.
const cinemetaBreaker = createCircuitBreaker({ name: "cinemeta", failureThreshold: 3, backoffMs: 30_000 })

/** Solo per i test: azzera lo stato del breaker Cinemeta. */
export function __resetCinemetaBreaker(): void {
  cinemetaBreaker.reset()
}

const CINEMETA_NULL_TTL_MS = 60_000
const CINEMETA_NULL_MAX = 500
const cinemetaNullAt = new Map<string, number>()

function cinemetaNullSet(cacheKey: string): void {
  if (cinemetaNullAt.size >= CINEMETA_NULL_MAX) {
    const firstKey = cinemetaNullAt.keys().next().value
    if (firstKey) cinemetaNullAt.delete(firstKey)
  }
  cinemetaNullAt.set(cacheKey, Date.now())
}

function cinemetaNullFresh(cacheKey: string): boolean {
  const nulledAt = cinemetaNullAt.get(cacheKey)
  if (nulledAt === undefined) return false
  if (Date.now() - nulledAt < CINEMETA_NULL_TTL_MS) return true
  cinemetaNullAt.delete(cacheKey)
  return false
}

/** Solo per i test: svuota la negative cache Cinemeta. */
export function __resetCinemetaNullForTest(): void {
  cinemetaNullAt.clear()
}

// Deduplica i fetch concorrenti sullo stesso ID (griglie catalogo).
const cinemetaInflight = new Map<string, Promise<CinemetaOutcome>>()

interface CinemetaOutcome {
  status: "ok" | "miss" | "error"
  rating: number | null
}

export type CinemetaMediaType = "movie" | "tv" | "series" | "anime" | null | undefined

interface CinemetaMeta {
  imdbRating?: unknown
}

function toTen(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""))
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round((n > 10 ? n / 10 : n) * 10) / 10
}

async function fetchCinemetaType(
  imdbId: string,
  type: "movie" | "series",
  signal?: AbortSignal,
): Promise<CinemetaOutcome> {
  const cacheKey = `cinemeta:rating:${type}:${imdbId}`
  const cached = cacheGet<number>(cacheKey)
  if (typeof cached === "number") return { status: "ok", rating: cached }
  if (cinemetaNullFresh(cacheKey)) return { status: "miss", rating: null }
  if (cinemetaBreaker.isOpen()) return { status: "error", rating: null }

  const existing = cinemetaInflight.get(cacheKey)
  // Coalescing preservato (stesso trasporto condiviso), ma ogni waiter
  // gareggia col proprio signal: un fetch lento condiviso non deve tenere
  // in ostaggio il budget di fallback del chiamante.
  if (existing) return raceWithAbort(existing, signal)

  const promise: Promise<CinemetaOutcome> = (async (): Promise<CinemetaOutcome> => {
    try {
      const res = await timedFetch(`${CINEMETA_BASE}/meta/${type}/${encodeURIComponent(imdbId)}.json`, {
        headers: { Accept: "application/json" },
        signal: combineAbortSignals(signal, CINEMETA_TIMEOUT_MS),
      })
      if (res.status === 429 || res.status >= 500) {
        cinemetaBreaker.recordFailure(parseRetryAfterMs((n) => res.headers.get(n)))
        return { status: "error", rating: null }
      }
      // Cinemeta NON fa 404 sugli id ignoti (200 con meta vuoto): il miss si
      // rileva da imdbRating assente, mai dallo status.
      if (!res.ok) {
        cinemetaNullSet(cacheKey)
        return { status: "miss", rating: null }
      }
      cinemetaBreaker.recordSuccess()
      const data = (await res.json().catch(() => null)) as { meta?: CinemetaMeta } | null
      const rating = toTen(data?.meta?.imdbRating)
      if (rating === null) {
        cinemetaNullSet(cacheKey)
        return { status: "miss", rating: null }
      }
      cacheSet(cacheKey, rating, ["cinemeta"])
      return { status: "ok", rating }
    } catch (e) {
      if (!signal?.aborted) cinemetaBreaker.recordFailure()
      log.error("Cinemeta rating fetch failed", { error: e instanceof Error ? e.message : String(e) })
      return { status: "error", rating: null }
    }
  })()
  cinemetaInflight.set(cacheKey, promise)
  try {
    return await promise
  } finally {
    if (cinemetaInflight.get(cacheKey) === promise) cinemetaInflight.delete(cacheKey)
  }
}

/**
 * Voto IMDb via Cinemeta (gratis, senza chiave). Prova il tipo coerente col
 * mediaType e, se senza voto, l'altro tipo (Cinemeta risolve spesso anche sul
 * tipo "sbagliato", ma non sempre). Ritorna null su transienti (il chiamante
 * decide il fallback) e registra i miss in negativa.
 */
export async function fetchCinemetaRating(
  imdbId: string | null | undefined,
  mediaType?: CinemetaMediaType,
  signal?: AbortSignal,
): Promise<number | null> {
  if (!imdbId) return null
  const primary: "movie" | "series" = mediaType === "tv" || mediaType === "series" ? "series" : "movie"
  const secondary: "movie" | "series" = primary === "movie" ? "series" : "movie"

  const first = await fetchCinemetaType(imdbId, primary, signal)
  if (first.rating !== null) return first.rating
  // Solo i miss genuini provano l'altro tipo; i transienti escono subito
  // (stesso upstream, ritentare raddoppierebbe i danni).
  if (first.status !== "miss") return null
  const second = await fetchCinemetaType(imdbId, secondary, signal)
  return second.rating
}
