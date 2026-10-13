import crypto from "node:crypto"
import { cacheGet, cacheSet } from "./cache"
import { timedFetch } from "./outbound-stats"
import { createLogger } from "@/lib/logger"
import { envWithFallback } from "@/lib/env-compat"
import { createCircuitBreaker, parseRetryAfterMs } from "@/lib/circuit-breaker"
import { combineAbortSignals } from "@/lib/abort-signal"
import { fetchSimklRating } from "./simkl"
import { fetchAnimeRatings, normalizeAnimeSide } from "./anime-ratings"
import { fetchCinemetaRating } from "./cinemeta"

const log = createLogger("ratings")

// Override E2E/mock deterministico (stesso pattern di mdblist.ts): in
// produzione la env è assente e si usa l'endpoint reale.
const MDBLIST = process.env.MDBLIST_API_URL || "https://mdblist.com/api"

// Phase 2 (Provider Resilience): deadline interna 8000 → 1500ms. I caller
// fanno già race con RATING_WAIT_MS, ma il fetch restava zombie fino a 8s;
// la route tmdb-details non passa alcun signal, quindi questo è la sua unica
// guardia anti-starvation.
const MDBLIST_TIMEOUT_MS = (() => {
  const raw = envWithFallback("MDBLIST_TIMEOUT_MS")
  const n = raw ? parseInt(raw, 10) : 1500
  return Number.isFinite(n) && n >= 300 && n <= 10000 ? n : 1500
})()

// Fail-open breaker dedicato: 3 fallimenti consecutivi → 30s di cooldown.
// Mentre è aperto le chiamate ritornano subito null (fallback al voto TMDB
// nativo nei caller) senza toccare la rete.
const mdblistBreaker = createCircuitBreaker({ name: "mdblist", failureThreshold: 3, backoffMs: 30_000 })

/** Solo per i test: azzera lo stato del breaker MDBList. */
export function __resetMdblistBreaker(): void {
  mdblistBreaker.reset()
}

const RATINGS_NULL_TTL_MS = 60_000
/** Explicit TTL for valid aggregated results: 6h (success only, never null/fail). */
export const RATINGS_SUCCESS_TTL_MS = 6 * 60 * 60 * 1000
const RATINGS_NULL_MAX = 500
const ratingsNullAt = new Map<string, number>()

function ratingsNullSet(cacheKey: string): void {
  if (ratingsNullAt.size >= RATINGS_NULL_MAX) ratingsNullAt.delete(ratingsNullAt.keys().next().value!)
  ratingsNullAt.set(cacheKey, Date.now())
}

/** Solo per i test: svuota la negative cache dei null. */
export function __resetRatingsNullForTest(): void {
  ratingsNullAt.clear()
}

export function isMdblistBreakerOpen(): boolean {
  return mdblistBreaker.isOpen()
}

// SUPPORTED_RATING_SOURCES + parseRatingSources/resolveRatingSources vivono
// in rating-weights.ts (foglia client-safe senza import runtime): ratings.ts
// importa cache/KV e non può stare nel bundle browser. Ri-esportati qui per
// compatibilità (route, hardening, test esistenti importano da questo modulo).
import { DEFAULT_RATING_SOURCES, UI_RATING_SOURCES, SUPPORTED_RATING_SOURCES, parseRatingSources, resolveRatingSources } from "./rating-weights"
export { DEFAULT_RATING_SOURCES, UI_RATING_SOURCES, SUPPORTED_RATING_SOURCES, parseRatingSources, resolveRatingSources }
export type { RatingSource } from "./rating-weights"

export interface AggregatedRatings {
  sources: Record<string, number>
  average: number
  count: number
}

function toTen(v: number): number {
  return v > 10 ? v / 10 : v
}

function avg(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

// parseRatingSources/resolveRatingSources: definiti in rating-weights.ts
// (foglia client-safe), ri-esportati sopra per compatibilità.

export function calculateAverageRating(
  ratings: AggregatedRatings | null,
  requestedSources?: string[]
): number | null {
  if (!ratings || !ratings.sources) return null
  const targetSources = requestedSources && requestedSources.length > 0
    ? requestedSources.map((s) => {
        const lower = s.toLowerCase()
        if (lower === "tomatoesaudience" || lower === "popcorn") return "popcorntime"
        if (lower === "myanimelist") return "mal"
        return lower
      })
    : DEFAULT_RATING_SOURCES

  const values: number[] = []
  for (const src of targetSources) {
    const val = ratings.sources[src]
    if (typeof val === "number" && !isNaN(val) && val > 0) {
      values.push(val)
    }
  }

  if (values.length === 0) return null
  return avg(values)
}

/** Cap display colonna rating separati: oltre, la colonna destra mangia il poster. */
export const MAX_SEPARATE_RATINGS = 5

/** Fonti mostrate in percentuale invece che in decimi (valore /10 → `88%`). */
const PERCENT_SOURCES: ReadonlySet<string> = new Set(["tomatoes", "popcorntime"])

export interface SeparateRating {
  readonly id: string
  readonly value: number
}

/**
 * Sottoinsieme ordinato delle fonti aggregate per la colonna separata:
 * ordine di selezione `requestedSources`, skip valori mancanti/0, cap
 * MAX_SEPARATE_RATINGS (=5). Ritorna [] quando niente è mostrabile (il chiamante
 * ripiega sulla media ★).
 */
export function pickSeparateRatings(
  ratings: AggregatedRatings | null,
  requestedSources?: string[],
  max: number = MAX_SEPARATE_RATINGS,
): SeparateRating[] {
  if (!ratings || !ratings.sources) return []
  const wanted = requestedSources && requestedSources.length > 0
    ? requestedSources.map((s) => s.trim().toLowerCase())
    : [...DEFAULT_RATING_SOURCES]
  const out: SeparateRating[] = []
  for (const src of wanted) {
    if (out.length >= max) break
    const v = ratings.sources[src]
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out.push({ id: src, value: v })
  }
  return out
}

/** Formato display di una fonte separata: `7.3` decimale, `88%` per la famiglia percent. */
export function formatSeparateValue(source: string, value: number): string {
  if (PERCENT_SOURCES.has(source.toLowerCase())) return `${Math.round(value * 10)}%`
  return (Math.round(value * 10) / 10).toFixed(1)
}

export interface FetchAggregatedOptions {
  simklKey?: string | null
  tmdbId?: number | string | null
  mediaType?: "movie" | "tv" | "series" | "anime" | null
  wantSimkl?: boolean
  wantAnilist?: boolean
  wantKitsu?: boolean
  /** Voto IMDb via Cinemeta quando MDBList non lo fornisce (fallback sequenziale). */
  wantImdb?: boolean
  /**
   * Selezione esplicita delle fonti richieste (rsrc risolta dai caller).
   * Guida il routing dei provider: con selezione la selezione vince sui
   * flag want* (difesa in profondità: niente upstream per fonti non
   * richieste). Assente = legacy all-source (tutti i provider condizionali
   * attivi secondo i flag). Normalizzata (sort/dedupe) per la cache key,
   * mai per l'ordine di display (quello resta al computeVote dei caller).
   */
  requestedSources?: readonly string[] | null
  /**
   * Budget complessivo (ms) per primario + fallback + side provider
   * (clamp 300–10000). Il primario ne riceve una share limitata (60%) così
   * il fallback resta genuinamente utilizzabile; il totale non supera mai
   * la deadline del chiamante. Assente = legacy (solo timeout interni).
   */
  ratingWaitMs?: number | null
  /**
   * Voto TMDB diretto genuino (details.vote_average) applicato come overlay
   * request-specific su `sources.tmdb`: prevale sempre sul TMDB di MDBList
   * sia sui risultati freschi sia sulle cache hit, e colma il valore quando
   * MDBList non lo fornisce (quota/outage). La base cachata resta sempre
   * senza diretto, l'overlay si applica su copia alla restituzione e il voto
   * diretto non entra mai nel cache key né nella cache success (congelarlo
   * maschererebbe il recovery del provider). Vale solo dove tmdb è
   * richiesto (legacy) o esplicito in selezione. Solo voto TMDB genuino —
   * mai medie congelate da mapping/query.
   */
  tmdbFallbackVote?: number | null
}

interface MdbListFetchResult {
  sources: Record<string, number> | null
  isGenuineMiss: boolean
}

// Fonti servite SOLO dai direct provider condizionali (Simkl diretto,
// AniList/Kitsu diretti): da sole non sono mai un motivo per chiamare
// MDBList. MAL resta coperta dall'aggregatore MDBList (vedi sotto).
const DIRECT_ONLY_SOURCES: ReadonlySet<string> = new Set(["simkl", "anilist", "kitsu"])

// Fonti che MDBList può fornire (imdb anche via Cinemeta, tmdb anche diretto).
// Partizionano la whitelist con DIRECT_ONLY_SOURCES: tutto ciò che non è
// direct-only (inclusa MAL) può richiedere l'aggregatore MDBList.

// Versione del namespace cache rating: le entry pre-routing non devono mai
// influenzare la nuova precedenza (direct TMDB sopra MDBList).
const RATINGS_CACHE_VERSION = "v2"

// Share del budget complessivo riservata al primario: il fallback riceve il
// resto e resta genuinamente utilizzabile.
const PRIMARY_BUDGET_SHARE = 0.6

function normalizeRequestedSources(raw: readonly string[] | null | undefined): string[] | null {
  if (!raw) return null
  const seen = new Set<string>()
  for (const s of raw) {
    const t = String(s ?? "").trim().toLowerCase()
    if (t) seen.add(t)
  }
  return seen.size > 0 ? [...seen] : null
}

function clampOverallBudget(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null
  return Math.min(Math.max(Math.floor(raw), 300), 10000)
}

function isGenuineDirectVote(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0
}

function roundVote(v: number): number {
  return Math.round(Math.min(v, 10) * 10) / 10
}

// Media aritmetica storica: imdb+tmdb quando presenti, altrimenti tutte le
// fonti disponibili. Unico comportamento (vedi rating-weights.ts).
function averageFor(sources: Record<string, number>): number {
  const defaults: number[] = []
  if (typeof sources.imdb === "number") defaults.push(sources.imdb)
  if (typeof sources.tmdb === "number") defaults.push(sources.tmdb)
  return avg(defaults.length > 0 ? defaults : Object.values(sources))
}

/**
 * Overlay del voto TMDB diretto genuino (mai aggregate salvate/query):
 * vince su MDBList ANCHE sulle cache hit. Non muta mai l'oggetto cachato
 * condiviso: ritorna la base invariata quando non c'è niente da applicare,
 * una copia altrimenti.
 */
function withDirectTmdbOverlay(base: AggregatedRatings, vote: number | null): AggregatedRatings {
  if (vote === null || base.sources.tmdb === roundVote(vote)) return base
  const sources = { ...base.sources, tmdb: roundVote(vote) }
  return { sources, average: averageFor(sources), count: Object.keys(sources).length }
}

/**
 * Signal di fase: scatta al primo tra abort del chiamante e budget di fase.
 * Timer e listener sempre puliti all'uscita (niente leak, niente zombie).
 */
function phaseSignal(
  parent: AbortSignal | undefined | null,
  ms: number | undefined,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (ms === undefined) return { signal: parent ?? undefined, cleanup: () => undefined }
  const ctrl = new AbortController()
  const timer = setTimeout(() => {
    try {
      ctrl.abort(new DOMException("Aborted", "AbortError"))
    } catch { /* noop */ }
  }, Math.max(1, Math.floor(ms)))
  let onAbort: (() => void) | undefined
  if (parent) {
    if (parent.aborted) {
      clearTimeout(timer)
      try {
        ctrl.abort((parent as unknown as { reason?: unknown }).reason)
      } catch { /* noop */ }
    } else {
      onAbort = () => {
        clearTimeout(timer)
        try {
          ctrl.abort((parent as unknown as { reason?: unknown }).reason)
        } catch { /* noop */ }
      }
      parent.addEventListener("abort", onAbort, { once: true })
    }
  }
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer)
      if (onAbort && parent) parent.removeEventListener("abort", onAbort)
    },
  }
}

// Join di un side provider col residuo di budget: oltre il budget vale come
// transient (null), mai oltre la deadline del chiamante. Timer sempre pulito;
// il fetch orfano viene abortito dal signal upstream (finally del chiamante).
async function joinSide<T>(promise: Promise<T> | null, ms: number | undefined, fallback: T): Promise<T> {
  if (!promise) return fallback
  if (ms === undefined) {
    try {
      return await promise
    } catch {
      return fallback
    }
  }
  if (ms <= 0) return fallback
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new DOMException("Aborted", "AbortError")), Math.max(1, Math.floor(ms)))
      }),
    ])
  } catch {
    return fallback
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function fetchMdbListSources(
  imdbId: string,
  key?: string,
  signal?: AbortSignal
): Promise<MdbListFetchResult> {
  if (mdblistBreaker.isOpen()) return { sources: null, isGenuineMiss: false }

  const qs = key ? `?apikey=${encodeURIComponent(key)}&i=${encodeURIComponent(imdbId)}` : `?i=${encodeURIComponent(imdbId)}`

  try {
    const timeoutSignal = AbortSignal.timeout(MDBLIST_TIMEOUT_MS)
    let combined: AbortSignal = timeoutSignal
    if (signal) {
      if (typeof (AbortSignal as unknown as { any?: unknown }).any === "function") {
        combined = (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any([signal, timeoutSignal])
      } else {
        const ctrl = new AbortController()
        const onAbort = () => ctrl.abort((signal as unknown as { reason?: unknown })?.reason ?? timeoutSignal.reason)
        if (signal.aborted || timeoutSignal.aborted) ctrl.abort()
        else {
          signal.addEventListener("abort", onAbort, { once: true })
          timeoutSignal.addEventListener("abort", onAbort, { once: true })
        }
        combined = ctrl.signal
      }
    }
    const res = await timedFetch(
      `${MDBLIST}/${qs}`,
      { signal: combined }
    )
    if (res.status === 429 || res.status >= 500) {
      mdblistBreaker.recordFailure(parseRetryAfterMs((n) => res.headers.get(n)))
      return { sources: null, isGenuineMiss: false }
    }
    if (!res.ok) {
      return { sources: null, isGenuineMiss: true }
    }
    mdblistBreaker.recordSuccess()
    const raw = await res.json()
    const data = raw?.data ?? raw

    const ratings = data?.ratings
    const sources: Record<string, number> = {}

    // If root data has mdblist score/rating
    const rootScore = typeof data?.score === "number" ? data.score : parseFloat(data?.score)
    if (!isNaN(rootScore) && rootScore > 0) {
      sources.mdblist = Math.round((rootScore > 10 ? rootScore / 10 : rootScore) * 10) / 10
    }

    if (Array.isArray(ratings) && ratings.length > 0) {
      const ALL_SOURCES = new Set<string>(SUPPORTED_RATING_SOURCES)

      for (const item of ratings) {
        let src = (item?.source || item?.name || item?.provider || "").toLowerCase().replace(/[-_]/g, "")
        if (src === "myanimelist") src = "mal"
        if (src === "popcorn" || src === "rtaudience" || src === "audience" || src === "tomatoesaudience") src = "popcorntime"
        if (!ALL_SOURCES.has(src)) continue

        let normalized: number | null = null
        const rawScore = item?.score
        const scoreNum = typeof rawScore === "number" ? rawScore : parseFloat(rawScore)
        if (!isNaN(scoreNum) && scoreNum > 0) {
          normalized = scoreNum > 10 ? scoreNum / 10 : scoreNum
        } else {
          const rawV = item?.value ?? item?.rating
          const v = typeof rawV === "number" ? rawV : parseFloat(rawV)
          if (!isNaN(v) && v > 0) {
            if (src === "letterboxd" && v <= 5) {
              normalized = v * 2
            } else if (src === "rogerebert" && v <= 4) {
              normalized = v * 2.5
            } else {
              normalized = toTen(v)
            }
          }
        }

        if (normalized !== null && !isNaN(normalized) && normalized > 0 && !sources[src]) {
          sources[src] = Math.round(normalized * 10) / 10
        }
      }
    }

    const hasSources = Object.keys(sources).length > 0
    return { sources: hasSources ? sources : null, isGenuineMiss: !hasSources }
  } catch (e) {
    if (!signal?.aborted) mdblistBreaker.recordFailure()
    log.error("MDBList fetch failed", { error: e instanceof Error ? e.message : String(e) })
    return { sources: null, isGenuineMiss: false }
  }
}

export async function fetchAggregatedRating(
  imdbId: string,
  apiKey?: string,
  signal?: AbortSignal,
  opts?: FetchAggregatedOptions
): Promise<AggregatedRatings | null> {
  if (!imdbId) return null

  // Selezione esplicita (rsrc risolta dai caller): guida il routing. Assente
  // = legacy all-source (i flag want* decidono, come prima).
  const selection = normalizeRequestedSources(opts?.requestedSources ?? null)
  const selSet = selection ? new Set(selection) : null

  // Con selezione esplicita la selezione vince sui flag: niente upstream per
  // fonti non richieste (difesa in profondità se un caller passa flag stantii).
  const effWantSimkl = selSet ? selSet.has("simkl") && !!opts?.simklKey?.trim() : !!(opts?.wantSimkl && opts?.simklKey?.trim())
  const effWantAnilist = selSet ? selSet.has("anilist") : !!opts?.wantAnilist
  const effWantKitsu = selSet ? selSet.has("kitsu") : !!opts?.wantKitsu
  const effWantAnime = effWantAnilist || effWantKitsu
  const effWantImdb = selSet ? selSet.has("imdb") : !!opts?.wantImdb

  // Routing: simkl/anilist/kitsu da soli non chiamano mai MDBList (direct
  // provider condizionali); MAL resta MDBList-exclusive. Selezioni senza
  // fonti MDBList-exclusive (solo imdb/tmdb + direct-only) usano Cinemeta
  // primario + join diretto, MDBList solo per gli irrisolti; il resto resta
  // MDBList primario + fallback IMDb sequenziale.
  const needsMdblist = !selSet || selection!.some((s) => !DIRECT_ONLY_SOURCES.has(s))
  const hasMdblistExclusive = !!selSet && needsMdblist && selection!.some((s) => !DIRECT_ONLY_SOURCES.has(s) && s !== "imdb" && s !== "tmdb")
  // Famiglia imdb/tmdb (+ eventuali direct-only): Cinemeta primario + join
  // diretto quando nessuna fonte richiede MDBList in esclusiva.
  const familyDirectOnly = !!selSet && needsMdblist && !hasMdblistExclusive

  // Solo voto TMDB genuino diretto (details.vote_average): mai medie
  // congelate da mapping/query come "nativo". Vale solo dove tmdb è
  // richiesto (legacy) o esplicito in selezione.
  const directVote = isGenuineDirectVote(opts?.tmdbFallbackVote) ? (opts?.tmdbFallbackVote as number) : null
  const allowDirectOverlay = !selSet || selSet.has("tmdb")
  const effectiveDirectVote = allowDirectOverlay ? directVote : null

  const overallMs = clampOverallBudget(opts?.ratingWaitMs)
  const startedAt = Date.now()
  const remainingMs = (): number | undefined =>
    overallMs === null ? undefined : Math.max(0, overallMs - (Date.now() - startedAt))
  // Il primario riceve una share limitata del budget complessivo (60%): il
  // fallback riceve il resto (40%) e resta genuinamente utilizzabile anche
  // a budget minimo (300ms → 180 primario + 120 fallback, nessun floor).
  const primaryShareMs = (): number | undefined => {
    if (overallMs === null) return undefined
    const rem = Math.max(0, overallMs - (Date.now() - startedAt))
    if (rem <= 0) return 0
    return Math.min(rem, Math.floor(overallMs * PRIMARY_BUDGET_SHARE))
  }

  // Solo la chiave esplicita della richiesta: non esiste più chiave d'istanza per MDBList.
  const key = apiKey
  const keyHash = key ? crypto.createHash("sha1").update(key).digest("hex").slice(0, 8) : "nomk"
  const simklHash = effWantSimkl && opts?.simklKey ? crypto.createHash("sha1").update(opts.simklKey.trim()).digest("hex").slice(0, 8) : "nosk"
  // Le fonti anime cambiano i sources → parte del cache key (flag, mai ID).
  // Stesso per wantImdb (Cinemeta): senza, togglare rsrc in editor servirebbe
  // entry con/senza imdb a caso dentro le 6h di TTL.
  // Il lato TMDB entra nella chiave quando le fonti anime sono attive: gli id
  // numerici sono condivisi tra movie e tv e lo stesso imdb non deve servire
  // entry con l'anime dell'altro lato (P1: tv/128 vs movie/128).
  // La selezione (sort/dedupe, mai ordine display) isola la cache per policy;
  // la versione invalida le entry pre-routing (mai vecchia precedenza).
  const animeSide = effWantAnime ? normalizeAnimeSide(opts?.mediaType ?? null) : null
  const animeFlag = `${effWantAnilist ? "al" : "x"}${effWantKitsu ? "ki" : "x"}`
  const selKey = selSet ? [...selSet].sort().join(",") : "all"
  const cacheKey = `mdb:ratings:${RATINGS_CACHE_VERSION}:${imdbId}:${keyHash}${effWantSimkl ? `:${simklHash}` : ""}${effWantAnime ? `:${animeFlag}:${animeSide ?? "x"}` : ""}${effWantImdb ? ":ci" : ""}:sel:${selKey}`

  // Cache hit: overlay diretto su COPIA (mai mutare l'oggetto condiviso).
  const cached = cacheGet<AggregatedRatings>(cacheKey)
  if (cached) return effectiveDirectVote !== null ? withDirectTmdbOverlay(cached, effectiveDirectVote) : cached

  const nulledAt = ratingsNullAt.get(cacheKey)
  if (nulledAt !== undefined) {
    if (Date.now() - nulledAt < RATINGS_NULL_TTL_MS) {
      // Negativa sul provider base: il voto nativo valido resta un risultato
      // da solo, senza refetch provider e senza avvelenare la cache.
      if (effectiveDirectVote !== null) {
        const rounded = roundVote(effectiveDirectVote)
        return { sources: { tmdb: rounded }, average: rounded, count: 1 }
      }
      return null
    }
    ratingsNullAt.delete(cacheKey)
  }

  // TMDB-only con voto diretto genuino: zero upstream di rating (né MDBList
  // né Cinemeta né TMDB: il voto è già in mano al caller). Mai in cache
  // success: congelarlo maschererebbe il recovery del provider.
  if (selSet && selection!.length === 1 && selection![0] === "tmdb" && effectiveDirectVote !== null) {
    const rounded = roundVote(effectiveDirectVote)
    return { sources: { tmdb: rounded }, average: rounded, count: 1 }
  }

  // Budget complessivo: abortisce l'upstream residuo alla scadenza; timer e
  // listener sempre puliti in finally (niente zombie oltre la race caller).
  let budgetTimer: ReturnType<typeof setTimeout> | undefined
  let onCallerAbort: (() => void) | undefined
  const budgetCtrl = overallMs !== null ? new AbortController() : null
  if (budgetCtrl && overallMs !== null) {
    budgetTimer = setTimeout(() => {
      try {
        budgetCtrl.abort(new DOMException("Aborted", "AbortError"))
      } catch { /* noop */ }
    }, Math.max(1, overallMs))
    if (signal) {
      if (signal.aborted) budgetCtrl.abort((signal as unknown as { reason?: unknown }).reason)
      else {
        onCallerAbort = () => budgetCtrl.abort((signal as unknown as { reason?: unknown }).reason)
        signal.addEventListener("abort", onCallerAbort, { once: true })
      }
    }
  }
  const upstream = budgetCtrl ? combineAbortSignals(signal, budgetCtrl.signal) : signal
  const cleanupBudget = () => {
    // Abortisce prima l'owned controller: i join laterali scaduti devono
    // terminare l'upstream anche senza signal esterno (niente side zombie).
    if (budgetCtrl && !budgetCtrl.signal.aborted) {
      try {
        budgetCtrl.abort(new DOMException("Aborted", "AbortError"))
      } catch { /* noop */ }
    }
    if (budgetTimer !== undefined) {
      clearTimeout(budgetTimer)
      budgetTimer = undefined
    }
    if (onCallerAbort && signal) {
      signal.removeEventListener("abort", onCallerAbort)
      onCallerAbort = undefined
    }
  }

  try {
    // Ramo famiglia+diretti (solo imdb/tmdb + simkl/anilist/kitsu, nessuna
    // fonte MDBList-exclusive): Cinemeta primario con share limitata per
    // imdb, join dei direct provider sul residuo, MDBList solo per gli
    // irrisolti imdb/tmdb. Mai chiamate TMDB extra: il tmdb o è diretto
    // (overlay non cachato) o arriva dal fallback MDBList. La cache tiene
    // SOLO la base provider (mai il voto diretto request-specific).
    if (familyDirectOnly) {
      const base: Record<string, number> = {}
      const simklP = effWantSimkl
        ? fetchSimklRating(imdbId, opts!.simklKey!, { tmdbId: opts?.tmdbId, mediaType: opts?.mediaType, signal: upstream }).catch(() => null)
        : null
      const animeP = effWantAnime
        ? fetchAnimeRatings(imdbId, { tmdbId: opts?.tmdbId, mediaType: opts?.mediaType ?? null, wantAnilist: effWantAnilist, wantKitsu: effWantKitsu, signal: upstream }).catch(() => null)
        : null
      if (selSet!.has("imdb") && effWantImdb) {
        const ph = phaseSignal(upstream, primaryShareMs())
        try {
          const cinemetaRating = await fetchCinemetaRating(imdbId, opts?.mediaType, ph.signal).catch(() => null)
          if (typeof cinemetaRating === "number") base.imdb = cinemetaRating
        } finally {
          ph.cleanup()
        }
      }
      let mdbGenuineMiss = false
      // tmdb diretto già risolto via overlay: non richiede fallback MDBList.
      const needFallback =
        (selSet!.has("imdb") && base.imdb === undefined) ||
        (selSet!.has("tmdb") && base.tmdb === undefined && effectiveDirectVote === null)
      if (needFallback) {
        const rem = remainingMs()
        if (rem === undefined || rem > 0) {
          const ph = phaseSignal(upstream, rem)
          try {
            const mdbResult = await fetchMdbListSources(imdbId, key, ph.signal)
            if (mdbResult.sources) {
              for (const s of selection!) {
                if (DIRECT_ONLY_SOURCES.has(s)) continue
                if (base[s] === undefined && typeof mdbResult.sources[s] === "number") {
                  base[s] = mdbResult.sources[s]
                }
              }
            } else {
              mdbGenuineMiss = mdbResult.isGenuineMiss
            }
          } finally {
            ph.cleanup()
          }
        }
      }
      {
        const rem = remainingMs()
        const [simklRating, animeRatings] = await Promise.all([
          joinSide(simklP, rem, null),
          joinSide(animeP, rem, null),
        ])
        if (typeof simklRating === "number" && Number.isFinite(simklRating) && simklRating > 0) {
          base.simkl = simklRating
        }
        if (typeof animeRatings?.anilist === "number") base.anilist = animeRatings.anilist
        if (typeof animeRatings?.kitsu === "number") base.kitsu = animeRatings.kitsu
      }
      if (Object.keys(base).length > 0) {
        // Con voto diretto il fallback MDBList per tmdb è saltato: la base
        // è parziale (manca il tmdb provider). Non cacharla: congelarla
        // servirebbe la parziale anche alle chiamate senza nativo.
        if (effectiveDirectVote !== null && selSet!.has("tmdb")) {
          const uncached: AggregatedRatings = { sources: { ...base }, average: averageFor(base), count: Object.keys(base).length }
          return withDirectTmdbOverlay(uncached, effectiveDirectVote)
        }
        const cachedBase: AggregatedRatings = { sources: { ...base }, average: averageFor(base), count: Object.keys(base).length }
        cacheSet(cacheKey, cachedBase, ["mdb", "simkl", "anime"], RATINGS_SUCCESS_TTL_MS)
        return effectiveDirectVote !== null ? withDirectTmdbOverlay(cachedBase, effectiveDirectVote) : cachedBase
      }
      // Solo voto diretto, nessuna base provider: risultato nativo senza
      // cache success (non deve mascherare il recovery del provider).
      if (effectiveDirectVote !== null && (selSet!.has("tmdb"))) {
        const rounded = roundVote(effectiveDirectVote)
        return { sources: { tmdb: rounded }, average: rounded, count: 1 }
      }
      if (mdbGenuineMiss) ratingsNullSet(cacheKey)
      return null
    }

    // Ramo direct-only (solo simkl/anilist/kitsu): zero MDBList, zero
    // Cinemeta. MAL resta MDBList e non entra mai qui (è covered).
    if (!needsMdblist) {
      const simklP = effWantSimkl
        ? fetchSimklRating(imdbId, opts!.simklKey!, { tmdbId: opts?.tmdbId, mediaType: opts?.mediaType, signal: upstream }).catch(() => null)
        : null
      const animeP = effWantAnime
        ? fetchAnimeRatings(imdbId, { tmdbId: opts?.tmdbId, mediaType: opts?.mediaType ?? null, wantAnilist: effWantAnilist, wantKitsu: effWantKitsu, signal: upstream }).catch(() => null)
        : null
      const rem = remainingMs()
      const [simklRating, animeRatings] = await Promise.all([
        joinSide(simklP, rem, null),
        joinSide(animeP, rem, null),
      ])
      const sources: Record<string, number> = {}
      if (typeof simklRating === "number" && Number.isFinite(simklRating) && simklRating > 0) {
        sources.simkl = simklRating
      }
      if (typeof animeRatings?.anilist === "number") sources.anilist = animeRatings.anilist
      if (typeof animeRatings?.kitsu === "number") sources.kitsu = animeRatings.kitsu
      if (Object.keys(sources).length === 0) return null
      const result: AggregatedRatings = { sources, average: averageFor(sources), count: Object.keys(sources).length }
      cacheSet(cacheKey, result, ["mdb", "simkl", "anime"], RATINGS_SUCCESS_TTL_MS)
      return result
    }

    // Ramo primario MDBList (legacy all-source + selezioni con fonti
    // MDBList-exclusive): side diretti lanciati subito ma joinati DOPO il
    // fallback IMDb — il fallback sequenziale non resta mai dietro la
    // Promise.all dei side provider.
    const simklP = effWantSimkl
      ? fetchSimklRating(imdbId, opts!.simklKey!, { tmdbId: opts?.tmdbId, mediaType: opts?.mediaType, signal: upstream }).catch(() => null)
      : null
    const animeP = effWantAnime
      ? fetchAnimeRatings(imdbId, { tmdbId: opts?.tmdbId, mediaType: opts?.mediaType ?? null, wantAnilist: effWantAnilist, wantKitsu: effWantKitsu, signal: upstream }).catch(() => null)
      : null

    let mdbResult: MdbListFetchResult
    {
      const ph = phaseSignal(upstream, primaryShareMs())
      try {
        mdbResult = await fetchMdbListSources(imdbId, key, ph.signal)
      } catch {
        mdbResult = { sources: null, isGenuineMiss: false }
      } finally {
        ph.cleanup()
      }
    }

    const sources: Record<string, number> = mdbResult.sources ? { ...mdbResult.sources } : {}
    // Fallback IMDb via Cinemeta (gratis, senza chiave): SOLO se MDBList non
    // lo fornisce e solo se richiesto. Sequenziale apposta: a chiave MDBList
    // funzionante zero chiamate extra; sul miss path costa dentro il residuo
    // di budget (fail-open oltre). MDBList vince sempre.
    if (sources.imdb === undefined && effWantImdb) {
      const rem = remainingMs()
      if (rem === undefined || rem > 0) {
        const ph = phaseSignal(upstream, rem)
        try {
          const cinemetaRating = await fetchCinemetaRating(imdbId, opts?.mediaType, ph.signal).catch(() => null)
          if (typeof cinemetaRating === "number") {
            sources.imdb = cinemetaRating
          }
        } finally {
          ph.cleanup()
        }
      }
    }
    {
      const rem = remainingMs()
      const [simklRating, animeRatings] = await Promise.all([
        joinSide(simklP, rem, null),
        joinSide(animeP, rem, null),
      ])
      if (typeof simklRating === "number" && Number.isFinite(simklRating) && simklRating > 0) {
        sources.simkl = simklRating
      }
      if (typeof animeRatings?.anilist === "number") {
        sources.anilist = animeRatings.anilist
      }
      if (typeof animeRatings?.kitsu === "number") {
        sources.kitsu = animeRatings.kitsu
      }
    }

    if (Object.keys(sources).length > 0) {
      // Base cachata SENZA voto diretto (request-specific): l'overlay diretto
      // si applica sulla copia restituita, mai sull'oggetto condiviso.
      const result: AggregatedRatings = {
        sources,
        average: averageFor(sources),
        count: Object.keys(sources).length,
      }
      cacheSet(cacheKey, result, effWantAnime ? ["mdb", "simkl", "anime"] : ["mdb", "simkl"], RATINGS_SUCCESS_TTL_MS)
      return effectiveDirectVote !== null ? withDirectTmdbOverlay(result, effectiveDirectVote) : result
    }
    // Outage totale ma voto diretto genuino: il tmdb diretto resta un
    // risultato valido da solo (legacy gap-fill, mai null che nasconde il
    // voto). Mai in cache success: congelarlo maschererebbe il recovery.
    if (effectiveDirectVote !== null) {
      const rounded = roundVote(effectiveDirectVote)
      return { sources: { tmdb: rounded }, average: rounded, count: 1 }
    }

    if (mdbResult.isGenuineMiss) {
      ratingsNullSet(cacheKey)
    }
    return null
  } catch (e) {
    log.error("Aggregated ratings fetch failed", { error: e instanceof Error ? e.message : String(e) })
    return null
  } finally {
    cleanupBudget()
  }
}
