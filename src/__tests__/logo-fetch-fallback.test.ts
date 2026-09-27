/**
 * Fallback morbido del fetch logo (caso Avengers: Endgame — originale PNG
 * 7795px da ~10.5MB rifiutato dal cap anti-OOM di fetchImg).
 *
 * fetchLogoImg prova `original`, e solo sugli errori di dimensione ripiega
 * su `w780` e poi `w500`. 404/timeout/abort rilanciano subito senza retry.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { fetchLogoImg, isImageTooLargeError } from "@/lib/poster-render-helpers"

const IMG = "https://image.tmdb.org/t/p"

function okResponse(bytes: number): Response {
  return {
    ok: true,
    headers: { get: (h: string) => null },
    arrayBuffer: async () => new Uint8Array(bytes).buffer as ArrayBuffer,
  } as unknown as Response
}

function tooLargeResponse(): Response {
  return {
    ok: true,
    // Come il CDN TMDB per l'originale Endgame: content-length > 10MB,
    // fetchImg rifiuta prima ancora di scaricare.
    headers: { get: (h: string) => (h.toLowerCase() === "content-length" ? "10977050" : null) },
    arrayBuffer: async () => new Uint8Array(8).buffer as ArrayBuffer,
  } as unknown as Response
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("isImageTooLargeError", () => {
  it("matches only the size-cap rejection", () => {
    expect(isImageTooLargeError(new Error("image too large"))).toBe(true)
    expect(isImageTooLargeError(new Error("fetch failed: 404"))).toBe(false)
    expect(isImageTooLargeError(new Error("AbortError: aborted"))).toBe(false)
    expect(isImageTooLargeError(null)).toBe(false)
  })
})

describe("fetchLogoImg", () => {
  it("uses original when it fits the cap (single fetch)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse(1024))
    const buf = await fetchLogoImg("/logo-fit.png")
    expect(buf.length).toBe(1024)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe(`${IMG}/original/logo-fit.png`)
  })

  it("falls back to w780 when original exceeds the cap (Endgame case)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/original/")) return tooLargeResponse()
      return okResponse(2048)
    })
    const buf = await fetchLogoImg("/logo-giant.png")
    expect(buf.length).toBe(2048)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[0][0]).toBe(`${IMG}/original/logo-giant.png`)
    expect(spy.mock.calls[1][0]).toBe(`${IMG}/w780/logo-giant.png`)
  })

  it("falls back to w500 when original and w780 both exceed the cap", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/w500/")) return okResponse(512)
      return tooLargeResponse()
    })
    const buf = await fetchLogoImg("/logo-huge.png")
    expect(buf.length).toBe(512)
    expect(spy).toHaveBeenCalledTimes(3)
    expect(spy.mock.calls[2][0]).toBe(`${IMG}/w500/logo-huge.png`)
  })

  it("does not retry on 404 (fails fast)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
      arrayBuffer: async () => new Uint8Array(0).buffer as ArrayBuffer,
    } as unknown as Response)
    await expect(fetchLogoImg("/logo-missing.png")).rejects.toThrow("fetch failed: 404")
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("fetches external http URLs once without size fallback", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse(300))
    const url = `${IMG}/original/logo-ext.png`
    const buf = await fetchLogoImg(url)
    expect(buf.length).toBe(300)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe(url)
  })
})
