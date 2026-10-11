import type { TMDBContentRatingsResponse, TMDBReleaseDatesResponse } from "./tmdb"

/**
 * Age-certification DATA layer (no UI/render badge).
 *
 * Restituisce l'etichetta originale del paese selezionato (PG-13, TV-MA,
 * VM14, ...) senza convertirla in età numeriche e senza fallback
 * cross-country: se il paese selezionato non ha dati, il risultato è null
 * (il renderer nasconde il badge). Il paese è un'impostazione globale
 * indipendente dalla lingua UI.
 *
 * Evidenza TMDB (developer.themoviedb.org, consultato via Context7):
 * - `GET /3/movie/{id}/release_dates` → `{ id, results: [{ iso_3166_1,
 *   release_dates: [{ certification, release_date, type, ... }] }] }`.
 *   `type`: 1 Premiere, 2 Theatrical limited, 3 Theatrical, 4 Digital,
 *   5 Physical, 6 TV. Uno stesso paese può avere VOCI MULTIPLE (es. CH con
 *   due theatrical in lingue diverse, oppure theatrical + digital/physical
 *   con certification diverse o vuote).
 * - `GET /3/tv/{id}/content_ratings` → `{ id, results: [{ iso_3166_1,
 *   rating, descriptors }] }`. Una rating per paese, nessun tipo di release.
 *
 * Ambiguità semantica reale: con più certification per paese, "l'ultima" per
 * data farebbe sì che una riedizione futura (digital/physical) sovrascriva
 * l'originale theatrical. Policy deterministica adottata (stabile, senza
 * orologio così i test restano deterministici e il badge non sfarfalla):
 *  1. match ESATTO sul paese (case-insensitive in ingresso, confronto in
 *     maiuscolo), nessun fallback US/altro paese;
 *  2. solo certification non-vuote dopo trim, etichetta preservata
 *     byte-identica a meno del trim (mai hardcodare label, mai convertire
 *     in numeri — "R" non implica 18+ ovunque);
 *  3. film: precedenza stabile di tipo [3, 2, 1, 4, 5, 6] (theatrical,
 *     limited, premiere, digital, physical, tv); a parità di tipo vince la
 *     release_date più vecchia (lessicografica ISO, stringhe vuote ultime),
 *     poi l'ordine API. Così la theatrical rilasciata vince su una digital
 *     futura e non c'è mai override "newest wins" inatteso;
 *  4. TV: prima rating non-vuota del paese in ordine API (TMDB ne dà una
 *     per paese; eventuali duplicati restano stabili).
 */

export type AgeCertificationMediaType = "movie" | "tv"

/** Paese di certification di default (impostazione globale indipendente). */
export const DEFAULT_AGE_COUNTRY = "IT" as const

/** Lunghezza massima dell'etichetta età resa nel badge (tetto anti-overflow). */
export const MAX_AGE_LABEL_LENGTH = 12 as const

/** Precedenza stabile dei tipi release TMDB per la certification film. */
export const CERTIFICATION_RELEASE_TYPE_PRECEDENCE = [3, 2, 1, 4, 5, 6] as const

/**
 * Normalizza un territorio di certification: ISO 3166-1 alpha-2 maiuscolo.
 * Ritorna null per input mancante/vuoto/non valido. "GLOBAL" (pseudo-codice
 * talvolta presente nei payload) è esplicitamente escluso: non è un
 * territorio di certification.
 */
export function normalizeCertificationCountry(country: unknown): string | null {
  if (typeof country !== "string") return null
  const code = country.trim().toUpperCase()
  if (code === "" || code === "GLOBAL") return null
  if (!/^[A-Z]{2}$/.test(code)) return null
  return code
}

function releaseTypeRank(type: unknown): number {
  const idx = (CERTIFICATION_RELEASE_TYPE_PRECEDENCE as readonly number[]).indexOf(
    typeof type === "number" ? type : NaN,
  )
  return idx === -1 ? CERTIFICATION_RELEASE_TYPE_PRECEDENCE.length : idx
}

/**
 * Certification originale del film per il paese dato, o null se assente.
 * Nessun fallback cross-country, nessuna conversione numerica.
 */
export function resolveMovieCertification(
  resp: TMDBReleaseDatesResponse | null | undefined,
  country: unknown,
): string | null {
  const code = normalizeCertificationCountry(country)
  if (!code) return null
  const results = resp?.results
  if (!Array.isArray(results) || results.length === 0) return null
  const entry = results.find(
    (r) => typeof r?.iso_3166_1 === "string" && r.iso_3166_1.toUpperCase() === code,
  )
  const list = entry?.release_dates
  if (!Array.isArray(list) || list.length === 0) return null
  const candidates = list
    .map((d, index) => {
      const raw = typeof d?.certification === "string" ? d.certification.trim() : ""
      const date = typeof d?.release_date === "string" ? d.release_date : ""
      return { label: raw, rank: releaseTypeRank(d?.type), date, index }
    })
    .filter((c) => c.label !== "")
  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank
    if (a.date !== b.date) {
      if (a.date === "") return 1
      if (b.date === "") return -1
      return a.date < b.date ? -1 : 1
    }
    return a.index - b.index
  })
  return candidates[0].label
}

/**
 * Rating originale della serie TV per il paese dato, o null se assente.
 * Nessun fallback cross-country, nessuna conversione numerica.
 */
export function resolveTvCertification(
  resp: TMDBContentRatingsResponse | null | undefined,
  country: unknown,
): string | null {
  const code = normalizeCertificationCountry(country)
  if (!code) return null
  const results = resp?.results
  if (!Array.isArray(results) || results.length === 0) return null
  for (const r of results) {
    if (typeof r?.iso_3166_1 !== "string" || r.iso_3166_1.toUpperCase() !== code) continue
    const label = typeof r?.rating === "string" ? r.rating.trim() : ""
    if (label !== "") return label
  }
  return null
}

export interface AgeCertificationPayload {
  releaseDates?: TMDBReleaseDatesResponse | null
  contentRatings?: TMDBContentRatingsResponse | null
}

/**
 * Totale caratteri ammessi nell'etichetta età prima del rendering: lettere e
 * numeri delle classificazioni reali (PG-13, TV-MA, VM14, FSK 16, R18+, U, 12,
 * ...), più i separatori tipografici ("-", "+", " ", ".", "/"). Qualsiasi
 * altro carattere (markup, emoji, CJK ornamentali) invalida l'etichetta →
 * null e il renderer nasconde il badge. Il testo conservato è comunque
 * interpolato solo via escSvg nei builder SVG (mai HTML grezzo).
 */
const AGE_LABEL_RE = /^[\p{L}\p{N}\-+/\\. ]{1,12}$/u

/**
 * Sanifica un'etichetta di certification per il badge: trim, tetto di
 * lunghezza, charset ristretto. Ritorna null quando non c'è niente di
 * rendibile (il chiamante nasconde il badge, fail-open).
 */
export function sanitizeAgeLabel(label: unknown): string | null {
  if (typeof label !== "string") return null
  const text = label.trim()
  // Oltre il tetto: mai troncare una classificazione (un label troncata
  // potrebbe significare altro) — fail-open, il badge si nasconde.
  if (text === "" || text.length > MAX_AGE_LABEL_LENGTH || !AGE_LABEL_RE.test(text)) return null
  return text
}

/**
 * Entry-point condiviso film/TV: smista sul tipo senza fallback tra paesi.
 * Film → releaseDates, TV → contentRatings. Payload mancante del tipo
 * richiesto → null.
 */
export function resolveAgeCertification(
  mediaType: AgeCertificationMediaType,
  country: unknown,
  payload: AgeCertificationPayload | null | undefined,
): string | null {
  if (mediaType === "movie") return resolveMovieCertification(payload?.releaseDates, country)
  if (mediaType === "tv") return resolveTvCertification(payload?.contentRatings, country)
  return null
}
