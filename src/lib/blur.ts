import sharp from "sharp"
import { STD_W, STD_H } from "./image-utils"

/**
 * Build the bottom-blur RGBA overlay (dual-stage progressive blur + linear scrim + accent tint).
 *
 * ## Performance Contract
 *
 * - Historic baseline (single-stage linear): ~8-15 ms (STD canvas)
 * - Progressive dual-stage, misurato via `npx vitest bench src/__tests__/blur.bench.ts`
 *   (vitest 4.1, 110+ campioni): STD 500x750 mean ~4.4 ms / p99 ~7.0 ms;
 *   landscape 768x432 mean ~3.4 ms / p99 ~6.3 ms — sotto il baseline storico.
 * - Zero intermediate PNG encodes/decodes (restituisce un Buffer RGBA grezzo direttamente a sharp.composite)
 *
 * ## Algorithm
 *
 * 1. Estrazione con bleed (16px sopra gradTop) per eliminare artefatti di cucitura.
 * 2. Doppio passaggio gaussiano concorrente (low-sigma all'inizio zona, high-sigma al fondo).
 * 3. Interpolazione progressiva nel loop raw RGBA:
 *    - Curva opacità: ease-out continuo u(t) = 1-(1-t)^γ, γ da blurFade
 *      (default 80 → γ=1.5, look di riferimento). NESSUN plateau: u tocca 1
 *      solo all'ultima riga — niente "scalino" orizzontale.
 *    - Curva scurimento: shade(u) = 1 - darkAlpha · u (stessa rampa di u,
 *      atterraggio a derivata zero, nessun kink a metà fascia)
 *    - Blend sigma: smoothstep S(t) da sigmaLow a sigmaHigh (diffusione progressiva)
 *    - Tinta accento: lerp cromatico controllato (default 20%) verso accentColor
 *      sulla stessa rampa u (tinta piena solo al fondo)
 *    - Dithering ordinato Bayer 4x4 deterministico (±1 LSB su RGBA): rompe il
 *      banding del gradiente scuro senza cambiare il valor medio locale.
 *      Deterministico per (x, y) — mai Math.random (ETag/snapshot stabili).
 */
export interface BlurParams {
  posterBuf: Buffer
  blurEnabled: boolean
  blurHeight: number
  blurIntensity: number
  blurFade: number
  blurDarkness: number
  /** Dimensioni canvas (default STD portrait; ramo landscape passa LAND_*). */
  canvasW?: number
  canvasH?: number
  /** Colore accento facoltativo (#RRGGBB) per tinta tonale cinematografica al fondo. */
  accentColor?: string
  /** Frazione di miscelazione tinta accento al fondo (default 0.20 = 20%, calibrata per non sovrastare l'artwork). */
  tintStrength?: number
}

export interface BlurOverlay {
  /** Raw RGBA pixels (canvasW × height), da passare a `composite()` con raw. */
  readonly overlay: Buffer
  readonly top: number
  readonly height: number
}

/**
 * Matrice di Bayer 4x4 ordinata (valori 0..15, riga per riga).
 *
 * Dithering DETERMINISTICO dell'overlay: il pattern è funzione pura di (x, y).
 * Mai Math.random() qui: un dither stocastico produrrebbe byte diversi a ogni
 * render dello stesso poster → ETag non deterministici, cache mai convergente
 * e snapshot visivi flaky. Con Bayer lo stesso input dà sempre gli stessi byte.
 */
const BAYER_4X4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
]

/** Ampiezza dither in LSB: ±15/16 ≈ ±0.94, un livello di quantizzazione. */
const DITHER_AMPLITUDE = 15 / 16

function parseHexColor(hex?: string): { r: number; g: number; b: number } | null {
  if (!hex || !hex.startsWith("#") || hex.length !== 7) return null
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null
  return { r, g, b }
}

export async function applyBlur(params: BlurParams): Promise<BlurOverlay | null> {
  const { posterBuf, blurEnabled, blurHeight, blurIntensity, blurFade, blurDarkness, accentColor, tintStrength: userTintStrength } = params
  if (!blurEnabled) return null
  const canvasW = params.canvasW ?? STD_W
  const canvasH = params.canvasH ?? STD_H

  const gh = Math.min(Math.max(Math.round(canvasH * blurHeight / 100), 100), canvasH)
  const gradTop = canvasH - gh

  // Bleed padding (16px) sopra gradTop per eliminare artefatti di cucitura (seam edge clamping)
  const pad = Math.min(16, gradTop)
  const extTop = gradTop - pad
  const extH = canvasH - extTop

  const fadedPct = Math.min(Math.max(blurFade, 0), 100)
  const darkAlpha = Math.min(Math.max(blurDarkness / 100, 0), 1)
  // Ease-out continuo (anti-"scalino"): γ da blurFade — 80 (default) → 1.5,
  // 100 → 1.0 (rampa lineare su tutta la fascia), 0 → banda piena legacy.
  // u(t) = 1-(1-t)^γ tocca 1 solo a t=1: alpha, shade e tinta condividono
  // un'unica rampa senza clip né plateau (il vecchio min(t/fadeStop,1)
  // appiattiva il 20% inferiore e piega lo shade a metà fascia).
  const gamma = fadedPct <= 0 ? 0 : 1 + (1 - fadedPct / 100) * 2.5

  // Sigmi dual-stage: low-sigma all'inizio zona, high-sigma al fondo
  const clampedIntensity = Math.min(Math.max(blurIntensity, 1), 100)
  const sigmaLow = Math.max(1, Math.round(clampedIntensity * 0.25))
  const sigmaHigh = Math.max(sigmaLow + 1, clampedIntensity)

  // Step 1: un solo decode (extract+resize+raw), poi i due blur dual-stage
  // lavorano in parallelo sullo STESSO raw in memoria (niente secondo decode
  // né PNG intermediate). Le fasi restano le STESSE operazioni del vecchio
  // doppio pipeline — blur con i canali originali (alpha inclusa, che cambia
  // il percorso di convoluzione in libvips) + removeAlpha dopo — col decode
  // fatto una volta sola: output identico su sorgenti a 3, 4 e 1 canale
  // (probe old-vs-new, Fase 2). −1 decode per render.
  const { data: baseRaw, info: baseInfo } = await sharp(posterBuf)
    .extract({ left: 0, top: extTop, width: canvasW, height: extH })
    .resize(canvasW, extH, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const rawInput = { width: baseInfo.width, height: baseInfo.height, channels: baseInfo.channels as 1 | 3 | 4 }
  const [blurLow, blurHigh] = await Promise.all([
    sharp(baseRaw, { raw: rawInput })
      .blur(sigmaLow)
      .removeAlpha()
      .raw()
      .toBuffer(),
    sharp(baseRaw, { raw: rawInput })
      .blur(sigmaHigh)
      .removeAlpha()
      .raw()
      .toBuffer(),
  ])

  // Step 2: composizione RGBA raw con interpolazione progressiva
  const tint = parseHexColor(accentColor)
  // Frazione controllata: 0.20 di default, calibrata per arricchire la base senza sporcare l'artwork
  const tintStrength = tint ? Math.min(Math.max(userTintStrength ?? 0.20, 0), 1) : 0
  const overlay = Buffer.alloc(extH * canvasW * 4)

  for (let y = 0; y < extH; y++) {
    const t = extH <= 1 ? 1 : y / (extH - 1)
    const u = gamma <= 0 ? 1 : 1 - Math.pow(1 - t, gamma)
    const alphaBase = u * 255

    // Scurimento sulla stessa rampa u (atterraggio morbido a t=1 per γ>1)
    const shade = 1 - darkAlpha * u

    // Interpolazione raggio progressivo con curva smoothstep in t (non lineare secca)
    const wHigh = t * t * (3 - 2 * t)
    const wLow = 1 - wHigh

    // Miscelazione tinta progressiva verso il fondo
    const tintMix = tintStrength * u
    const invTint = 1 - tintMix

    const rowOffset = y * canvasW
    // Riga Bayer per il dithering ordinato (solo i 2 bit bassi contano)
    const bayerRow = (y & 3) << 2
    for (let x = 0; x < canvasW; x++) {
      const si = (rowOffset + x) * 3
      const di = (rowOffset + x) * 4

      let r = blurLow[si] * wLow + blurHigh[si] * wHigh
      let g = blurLow[si + 1] * wLow + blurHigh[si + 1] * wHigh
      let b = blurLow[si + 2] * wLow + blurHigh[si + 2] * wHigh

      if (tint) {
        r = r * invTint + tint.r * tintMix
        g = g * invTint + tint.g * tintMix
        b = b * invTint + tint.b * tintMix
      }

      // Dithering ordinato anti-banding: il gradiente scuro ha <1 livello
      // di luminanza per pixel e il JPEG quantizza i blocchi 8x8 allo stesso
      // valore medio → bande orizzontali. Un rumore deterministico di ±1 LSB
      // disperde la quantizzazione senza cambiare il valore medio locale.
      // Stesso valore sui 3 canali (niente speckle cromatico, la tinta resta).
      const dither = (BAYER_4X4[bayerRow | (x & 3)]! - 7.5) / 8 * DITHER_AMPLITUDE

      overlay[di] = Math.min(255, Math.max(0, Math.round(r * shade + dither)))
      overlay[di + 1] = Math.min(255, Math.max(0, Math.round(g * shade + dither)))
      overlay[di + 2] = Math.min(255, Math.max(0, Math.round(b * shade + dither)))
      // L'alpha si dithera solo all'interno del gradiente: agli estremi esatti
      // (0 in alto per il bleed senza cuciture, 255 in basso) non c'è errore di
      // quantizzazione da decorrelare — il rumore lì sarebbe solo rumore.
      const alphaDither = alphaBase > 0 && alphaBase < 255 ? dither : 0
      overlay[di + 3] = Math.min(255, Math.max(0, Math.round(alphaBase + alphaDither)))
    }
  }

  return { overlay, top: extTop, height: extH }
}
