import { useState, useRef, useEffect, useCallback } from "react"
import { usePSelector } from "@/lib/context"
import { t } from "@/lib/i18n"
import { toast } from "sonner"
import { ACCENT_META_HEADER, parseEffectiveAccentHeader } from "@/lib/effective-accent"
import { publishEffectiveAccentDisplay } from "@/lib/effective-accent-display"

export function usePosterPreview() {
  // B2: selettore slice — prima useP() ri-renderizzava il hook (e chi lo usa)
  // a OGNI aggiornamento del context Pictorium, non solo al cambio previewUrl.
  const previewUrl = usePSelector((v) => v.previewUrl)
  // Rank-source save bump: la preview va rifetchata anche a URL identico
  // (la selezione vive server-side e non entra nell'URL); le risposte
  // preview sono no-store, quindi il reload rilegge sempre il render nuovo.
  const rankSourceNonce = usePSelector((v) => v.rankSourceNonce)
  const catalogsSyncNonce = usePSelector((v) => v.catalogsSyncNonce)

  const [imageError, setImageError] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [loadProgress, setLoadProgress] = useState(0)
  const [imgSrc, setImgSrc] = useState("")
  // Bump per far ripartire la fetch: il Retry del preview non può dipendere
  // solo da previewUrl (invariato dopo un errore), serve un nonce.
  const [retryNonce, setRetryNonce] = useState(0)
  
  const xhrRef = useRef<XMLHttpRequest | null>(null)
  const loadDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevObjUrlRef = useRef("")
  // Effective-accent display sync (header transport): monotonic generation so
  // a superseded XHR whose onload fires late (e.g. manually after abort())
  // can never publish over the latest image + metadata pair.
  const accentGenerationRef = useRef(0)
  // D6: throttle del progress — gli eventi onprogress di XHR arrivano a decine
  // al secondo; setLoadProgress a ogni evento ri-renderizza la preview senza
  // beneficio visivo. Aggiorna solo a step ≥5% (il 100% arriva in onload).
  const lastProgressRef = useRef(-1)

  useEffect(() => {
    setImageError(false)
    setLoadProgress(0)
    lastProgressRef.current = 0
    if (!previewUrl) {
      if (prevObjUrlRef.current) {
        URL.revokeObjectURL(prevObjUrlRef.current)
        prevObjUrlRef.current = ""
      }
      setImgSrc("")
      setPreviewLoading(false)
      // No preview displayed: drop any previous record (never show a stale
      // hex for the next title before its own load publishes).
      const generation = accentGenerationRef.current + 1
      accentGenerationRef.current = generation
      publishEffectiveAccentDisplay({ status: "unknown", meta: null, previewUrl: "", generation })
      return
    }

    // Show loading bar only if request takes >200ms
    loadDelayRef.current = setTimeout(() => setPreviewLoading(true), 200)

    // Keep old img visible while new one loads — no flicker
    const url = previewUrl
    // New load (URL/shape change or rank-source/catalog/retry nonce refetch
    // at the SAME url): publish loading FIRST so the accent picker can never
    // claim a stale hex as the new preview. The old object URL stays valid
    // on screen (crossfade) until THIS generation succeeds.
    const generation = accentGenerationRef.current + 1
    accentGenerationRef.current = generation
    publishEffectiveAccentDisplay({ status: "loading", meta: null, previewUrl: url, generation })
    const xhr = new XMLHttpRequest()
    xhrRef.current = xhr
    xhr.open("GET", url, true)
    xhr.responseType = "blob"
    // Senza timeout la barra percentuale resta ferma per sempre su render
    // appeso (Bugonia): peggio dei casi server = slot-wait 15s + watchdog 30s,
    // quindi 45s lascia arrivare il 503 del server prima di dichiarare errore.
    xhr.timeout = 45000
    
    xhr.onprogress = (e) => {
      // Eligibility first: a superseded XHR must never move the new progress.
      if (xhrRef.current !== xhr || accentGenerationRef.current !== generation) return
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100)
        if (lastProgressRef.current < 0 || pct - lastProgressRef.current >= 5 || pct >= 100) {
          lastProgressRef.current = pct
          setLoadProgress(pct)
        }
      }
    }
    
    xhr.onload = () => {
      // Generation guard FIRST: a superseded XHR (aborted by a newer load,
      // then firing onload late) must not clear the NEW spinner timer, touch
      // image state, or publish bytes/metadata.
      if (xhrRef.current !== xhr || accentGenerationRef.current !== generation) return
      if (loadDelayRef.current) {
        clearTimeout(loadDelayRef.current)
        loadDelayRef.current = null
      }
      if (xhr.status === 200) {
        const blob = xhr.response
        const objUrl = URL.createObjectURL(blob)
        if (prevObjUrlRef.current) URL.revokeObjectURL(prevObjUrlRef.current)
        prevObjUrlRef.current = objUrl
        setImgSrc(objUrl)
        setLoadProgress(100)
        setPreviewLoading(false)
        // Primary accent transport: validated metadata parsed from the SAME
        // response that carried these bytes. Absent/malformed (legacy cache,
        // stripped CDN header) → honest unknown, never a guessed color; the
        // manual chooser stays available and nothing is re-rendered.
        let meta: ReturnType<typeof parseEffectiveAccentHeader> = null
        try {
          meta = parseEffectiveAccentHeader(xhr.getResponseHeader(ACCENT_META_HEADER))
        } catch {
          meta = null
        }
        publishEffectiveAccentDisplay({
          status: meta ? "ready" : "unknown",
          meta,
          previewUrl: url,
          generation,
        })
      } else {
        setImageError(true)
        setPreviewLoading(false)
        publishEffectiveAccentDisplay({ status: "unknown", meta: null, previewUrl: url, generation })
      }
    }

    xhr.onerror = () => {
      // Eligibility first: a stale error must set no error state, clear no
      // timer, publish nothing and toast nothing on the new generation.
      if (xhrRef.current !== xhr || accentGenerationRef.current !== generation) return
      if (loadDelayRef.current) {
        clearTimeout(loadDelayRef.current)
        loadDelayRef.current = null
      }
      setImageError(true)
      setPreviewLoading(false)
      publishEffectiveAccentDisplay({ status: "unknown", meta: null, previewUrl: url, generation })
      toast.error(t("ui.posterLoadError"))
    }

    xhr.ontimeout = () => {
      // Eligibility first: same as onerror — a stale timeout is fully ignored.
      if (xhrRef.current !== xhr || accentGenerationRef.current !== generation) return
      if (loadDelayRef.current) {
        clearTimeout(loadDelayRef.current)
        loadDelayRef.current = null
      }
      setImageError(true)
      setPreviewLoading(false)
      publishEffectiveAccentDisplay({ status: "unknown", meta: null, previewUrl: url, generation })
      toast.error(t("ui.posterLoadError"))
    }
    
    xhr.send()
    
    return () => {
      // Invalidate BEFORE abort: abort() may synchronously re-enter
      // xhr.onerror while this XHR is still registered as current, which
      // would poison the next generation (error state + toast + cleared
      // timer). No record is published here — the next effect owns it.
      xhrRef.current = null
      xhr.abort()
      if (loadDelayRef.current) {
        clearTimeout(loadDelayRef.current)
        loadDelayRef.current = null
      }
    }
  }, [previewUrl, retryNonce, rankSourceNonce, catalogsSyncNonce])

  // Rifà la fetch della preview corrente (usato dal pulsante Retry dopo un errore).
  const retry = useCallback(() => {
    setRetryNonce((n) => n + 1)
  }, [])

  // Revoca l'object URL residuo SOLO allo smontaggio. La cleanup dell'effetto
  // sopra non può revocare: durante il caricamento della nuova preview l'immagine
  // vecchia deve restare valida (no-flicker).
  useEffect(() => {
    return () => {
      if (prevObjUrlRef.current) {
        URL.revokeObjectURL(prevObjUrlRef.current)
        prevObjUrlRef.current = ""
      }
    }
  }, [])

  return {
    imageError,
    setImageError,
    previewLoading,
    loadProgress,
    imgSrc,
    retry,
  }
}
