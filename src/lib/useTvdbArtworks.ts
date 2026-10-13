"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { TMDBImage } from "@/lib/types"
import { usePSelector } from "@/lib/context"
import { userFetch } from "@/lib/http"
import { currentPathUuid } from "@/lib/user-token"
import {
  isTvdbGalleryPayload,
  tvdbGalleryKindList,
  type TvdbGalleryImage,
  type TvdbGalleryKind,
} from "@/lib/tvdb-gallery-types"

/** Per-tile TVDB metadata carried alongside the TMDB-compatible tile. */
export interface TvdbTileMeta {
  /** Raw 3-letter code (`eng`) or null when neutral/unknown (never textless). */
  readonly language: string | null
  readonly thumbnail: string | null
  /** False = genuinely textless; undefined = unknown, never auto-promoted. */
  readonly includesText: boolean | undefined
  readonly score: number | undefined
  readonly type: number | null
}

export type TvdbStatus = "idle" | "loading" | "ready" | "empty" | "unavailable" | "not_configured"

export interface TvdbKindData {
  readonly status: TvdbStatus
  readonly items: TMDBImage[]
  readonly meta: TvdbTileMeta[]
  readonly reload: () => void
}

type Outcome =
  | { readonly ok: true; readonly gallery: Record<TvdbGalleryKind, TvdbGalleryImage[]> }
  | { readonly ok: false; readonly code: "not_configured" | "unavailable" }

interface SharedEntry {
  readonly promise: Promise<Outcome>
  readonly ctrl: AbortController
  refs: number
}

// One fresh request per title/user: all three galleries (posters/backdrops/
// logos) share the same full-gallery fetch instead of triple-fetching.
// Short resolved cache so tab switches don't refetch; the server route owns
// the long TTLs (6h hits / 10min empty), this is only a coalescing layer.
const sharedInflight = new Map<string, SharedEntry>()
const sharedResolved = new Map<string, { at: number; outcome: Outcome }>()
const RESOLVED_TTL_MS = 5 * 60 * 1000
// Fetch generation per key: reload() bumps it so a late-settling obsolete
// request (same key, so keyRef still matches) can neither poison the
// resolved cache nor clobber fresh UI state. Coalesced consumers of the
// current generation share the generation and are unaffected.
const sharedGeneration = new Map<string, number>()

/** Test-only: drop coalesced state between cases. */
export function __resetTvdbArtworksClientCache(): void {
  for (const entry of sharedInflight.values()) {
    try { entry.ctrl.abort() } catch { /* noop */ }
  }
  sharedInflight.clear()
  sharedResolved.clear()
  sharedGeneration.clear()
}

function requestKey(scope: string | null, mediaType: "movie" | "tv", id: number): string {
  return `${scope ?? "global"}|${mediaType}:${id}`
}

async function fetchGallery(url: string, signal: AbortSignal): Promise<Outcome> {
  let res: Response
  try {
    res = await userFetch(url, { signal, timeout: 15000 })
  } catch {
    if (signal.aborted) throw new DOMException("TVDB gallery aborted", "AbortError")
    return { ok: false, code: "unavailable" }
  }
  const data = (await res.json().catch(() => null)) as unknown
  const code = typeof data === "object" && data !== null
    ? (data as { code?: unknown }).code
    : undefined
  // Missing key is a presence state, not an empty gallery: never pretend
  // "no artworks" when the instance simply isn't keyed.
  if (res.status === 503 || code === "tvdb_not_configured") {
    return { ok: false, code: "not_configured" }
  }
  if (!res.ok || !isTvdbGalleryPayload(data)) {
    return { ok: false, code: "unavailable" }
  }
  return {
    ok: true,
    gallery: {
      posters: tvdbGalleryKindList(data, "posters"),
      backdrops: tvdbGalleryKindList(data, "backdrops"),
      logos: tvdbGalleryKindList(data, "logos"),
    },
  }
}

function toTile(img: TvdbGalleryImage): TMDBImage {
  return {
    // Absolute TVDB URL: `posterUrl()` passes http through, `isCustomPosterUrl`
    // is true, so portrait save flows through the existing customPosterUrl
    // split and logo/backdrop save as absolute paths — no new save schema.
    // Textness drives the tile language flag (never the separate display
    // meta): ONLY genuinely textless portraits (`includesText === false`)
    // read as clean (`iso_639_1: null`) so select/save never overlay an auto
    // logo on baked-in text. With-text or unknown textness stays honestly
    // non-clean: the raw 3-letter code passes through untouched (never an
    // invented 2-letter mapping), unknown/neutral degrades to the "xx"
    // sentinel (image/mapping schemas accept any string). The raw code stays
    // on the parallel display meta either way (never falsely null).
    file_path: img.url,
    iso_639_1: img.includesText === false ? null : (img.language ?? "xx"),
    vote_average: 0,
    width: img.width ?? 0,
    height: img.height ?? 0,
  }
}

function toMeta(img: TvdbGalleryImage): TvdbTileMeta {
  return {
    language: img.language,
    thumbnail: img.thumbnail,
    includesText: img.includesText,
    score: img.score,
    type: img.type,
  }
}

/**
 * TVDB artworks for the selected title (tab "TVDB" in each gallery).
 * Lazy: fetches only with `enabled` (tab open), never on title open.
 * All three kinds share ONE request per title/user via the module cache;
 * each hook derives its own truthful per-kind status (a kind with no items
 * is `empty`, never borrowed from another provider).
 * Stale guards: title/user change resets to idle and late responses for a
 * previous key are discarded — a pending switch never shows old tiles, and a
 * result fetched for another user key is never applied.
 * Credentials never touch the URL: `userFetch` resolves the Space TVDB key
 * server-side via the namespace (Bearer outbound only, route-owned).
 */
export function useTvdbArtworks(enabled: boolean, kind: TvdbGalleryKind): TvdbKindData {
  const selected = usePSelector((v) => v.selected)
  const mediaType = selected ? (selected.media_type === "tv" ? "tv" : "movie") : null
  const scope = currentPathUuid()
  const key = selected && mediaType ? requestKey(scope, mediaType, selected.id) : null
  const url = selected && mediaType ? `/api/tvdb/${selected.id}/artworks?type=${mediaType}` : null

  const [status, setStatus] = useState<TvdbStatus>("idle")
  const [items, setItems] = useState<TMDBImage[]>([])
  const [meta, setMeta] = useState<TvdbTileMeta[]>([])
  const [nonce, setNonce] = useState(0)
  const keyRef = useRef<string | null>(null)
  keyRef.current = key
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const applyOutcome = useCallback((outcome: Outcome) => {
    if (!outcome.ok) {
      setItems([])
      setMeta([])
      setStatus(outcome.code)
      return
    }
    const list = outcome.gallery[kind]
    if (list.length === 0) {
      setItems([])
      setMeta([])
      setStatus("empty")
      return
    }
    setItems(list.map(toTile))
    setMeta(list.map(toMeta))
    setStatus("ready")
  }, [kind])

  const load = useCallback(async () => {
    const current = keyRef.current
    if (!selected || !current || !url) return
    // The generation captured here identifies this load: only the current
    // generation may populate the cache or settle UI state.
    const gen = sharedGeneration.get(current) ?? 0
    // Fresh resolved cache: reopening the tab doesn't refetch.
    const hit = sharedResolved.get(current)
    if (hit && Date.now() - hit.at < RESOLVED_TTL_MS) {
      if (keyRef.current !== current || !mountedRef.current) return
      if ((sharedGeneration.get(current) ?? 0) !== gen) return
      applyOutcome(hit.outcome)
      return
    }
    let entry = sharedInflight.get(current)
    if (!entry) {
      const ctrl = new AbortController()
      const promise = fetchGallery(url, ctrl.signal)
      entry = { promise, ctrl, refs: 0 }
      sharedInflight.set(current, entry)
      const entryGen = gen
      // Settle bookkeeping on the shared entry. Only successes land in the
      // short cache (failures are NEVER cached: a 502 never becomes "empty",
      // and a not_configured never masks a key added while the tab was
      // closed — the next open revalidates honestly). An obsolete generation
      // (reload bumped past entryGen) never writes: a stale success cannot
      // poison the cache for the fresh request.
      void promise.then(
        (outcome) => {
          if (sharedInflight.get(current) === entry) sharedInflight.delete(current)
          if (outcome.ok && (sharedGeneration.get(current) ?? 0) === entryGen) {
            sharedResolved.set(current, { at: Date.now(), outcome })
          }
        },
        () => {
          if (sharedInflight.get(current) === entry) sharedInflight.delete(current)
        },
      )
    }
    entry.refs += 1
    setStatus("loading")
    try {
      const outcome = await entry.promise
      if (!mountedRef.current || keyRef.current !== current) return
      if ((sharedGeneration.get(current) ?? 0) !== gen) return
      applyOutcome(outcome)
    } catch {
      // Shared fetch aborted (all consumers left) or failed to settle:
      // only apply when still ours — a stale abort never wipes new state.
      if (!mountedRef.current || keyRef.current !== current) return
      if ((sharedGeneration.get(current) ?? 0) !== gen) return
      setItems([])
      setMeta([])
      setStatus("unavailable")
    } finally {
      entry.refs -= 1
      if (entry.refs <= 0 && sharedInflight.get(current) === entry) {
        try { entry.ctrl.abort() } catch { /* noop */ }
        sharedInflight.delete(current)
      }
    }
  }, [selected, url, applyOutcome])

  const reload = useCallback(() => {
    const current = keyRef.current
    if (current) {
      // Own the obsolete entry: abort it so its network settles promptly,
      // then drop it (identity-checked) plus the resolved snapshot. The
      // generation bump below disqualifies its late outcome from both the
      // cache write and any UI settle, while coalesced consumers of the new
      // generation fetch and settle normally.
      const obsolete = sharedInflight.get(current)
      if (obsolete) {
        try { obsolete.ctrl.abort() } catch { /* noop */ }
        if (sharedInflight.get(current) === obsolete) sharedInflight.delete(current)
      }
      sharedResolved.delete(current)
      sharedGeneration.set(current, (sharedGeneration.get(current) ?? 0) + 1)
    }
    // Retrigger through idle (the effect below reloads when enabled).
    setStatus("idle")
    setNonce((n) => n + 1)
  }, [])

  // Title/user change: drop previous tiles, never show stale art.
  useEffect(() => {
    setStatus("idle")
    setItems([])
    setMeta([])
  }, [key, nonce])

  useEffect(() => {
    if (enabled && key && url && status === "idle") void load()
  }, [enabled, key, url, status, nonce, load])

  return { status, items, meta, reload }
}
