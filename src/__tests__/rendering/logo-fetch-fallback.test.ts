/**
 * Bounded-size TMDB logo fetch (P2 narrow optimization).
 *
 * `fetchLogoImg` downloads raster logos at the documented `w500` tier FIRST
 * (single request on success) instead of `original`-first: the ordinary
 * poster path never pays the multi-MB original PNG (e.g. Avengers: Endgame
 * ~10.5MB/7795px, rejected by the fetchImg anti-OOM cap only AFTER the
 * download headers arrived). `w780` is not a documented TMDB logo size and
 * is no longer attempted by this routine.
 *
 * Policy:
 * - relative raster path (`.png`/`.jpg`/`.webp`, ...) → `w500`, one fetch,
 *   no fallback. Cap/non-200/abort propagate with no extra network.
 * - relative `.svg` path → `original`, one fetch (vector size semantics:
 *   `w500` would rasterize server-side at TMDB).
 * - absolute http(s) URL → exact URL, one fetch (existing SSRF allowlist in
 *   `imgSrc` still applies).
 * Size cap, cancellation/deadline, timedFetch/body telemetry and the byte
 * LRU (coalescing + reuse) are unchanged: they live in `fetchImg`.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { fetchImg, fetchLogoImg, isImageTooLargeError } from "@/lib/poster-render-helpers"
import { __resetOutboundStatsForTest, outboundStats } from "@/lib/outbound-stats"
import { __resetImageBytesForTest } from "@/lib/image-bytes-cache"

const IMG = "https://image.tmdb.org/t/p"

function okResponse(bytes: number): Response {
  return {
    ok: true,
    headers: { get: (_h: string) => null },
    arrayBuffer: async () => new Uint8Array(bytes).buffer as ArrayBuffer,
  } as unknown as Response
}

function tooLargeResponse(): Response {
  return {
    ok: true,
    // Content-length beyond the 10MB fetchImg cap: rejected before download.
    headers: { get: (h: string) => (h.toLowerCase() === "content-length" ? "10977050" : null) },
    arrayBuffer: async () => new Uint8Array(8).buffer as ArrayBuffer,
  } as unknown as Response
}

afterEach(() => {
  vi.restoreAllMocks()
  __resetOutboundStatsForTest()
  __resetImageBytesForTest()
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
  it("fetches a raster logo at w500 first (single fetch, no original attempt)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse(1024))
    const buf = await fetchLogoImg("/logo-fit.png")
    expect(buf.length).toBe(1024)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe(`${IMG}/w500/logo-fit.png`)
  })

  it("never attempts original or w780 for raster logos", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse(512))
    await fetchLogoImg("/logo-never-original.png")
    const urls = spy.mock.calls.map((c) => String(c[0]))
    expect(urls).toHaveLength(1)
    expect(urls.some((u) => u.includes("/original/"))).toBe(false)
    expect(urls.some((u) => u.includes("/w780/"))).toBe(false)
  })

  it("fetches an SVG logo at original (vector size semantics)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse(2048))
    const buf = await fetchLogoImg("/logo-vector.svg")
    expect(buf.length).toBe(2048)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe(`${IMG}/original/logo-vector.svg`)
  })

  it("propagates the size cap on w500 with no extra network", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(tooLargeResponse())
    await expect(fetchLogoImg("/logo-giant.png")).rejects.toThrow("image too large")
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe(`${IMG}/w500/logo-giant.png`)
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

  it("propagates abort with no extra network", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("aborted", "AbortError"))
    await expect(fetchLogoImg("/logo-aborted.png")).rejects.toThrow()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe(`${IMG}/w500/logo-aborted.png`)
  })

  it("fetches external http URLs once without size fallback", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse(300))
    const url = `${IMG}/original/logo-ext.png`
    const buf = await fetchLogoImg(url)
    expect(buf.length).toBe(300)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe(url)
  })

  it("coalesces and reuses repeated w500 downloads with one body read", async () => {
    __resetOutboundStatsForTest()
    __resetImageBytesForTest()
    const bytes = new Uint8Array(768).fill(9)
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(bytes, { status: 200 }))
    const first = await fetchLogoImg("/logo-reuse.png")
    const second = await fetchLogoImg("/logo-reuse.png")
    expect(first.equals(second)).toBe(true)
    expect(first.length).toBe(768)
    // Byte-LRU reuse: a single real download, hence a single body read.
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe(`${IMG}/w500/logo-reuse.png`)
    const s = outboundStats()["image.tmdb.org"]!
    expect(s.requests).toBe(1)
    expect(s.bodyReads).toBe(1)
    expect(s.bodyBytes).toBe(768)
    expect(s.bodyErrors).toBe(0)
  })
})

describe("fetchImg body telemetry (P3)", () => {
  it("reuses cached bytes with identical output and one body read", async () => {
    __resetOutboundStatsForTest()
    __resetImageBytesForTest()
    const bytes = new Uint8Array(1024).fill(7)
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(bytes, { status: 200 }))
    try {
      const first = await fetchImg(`${IMG}/w500/body-tel-reuse.png`)
      const second = await fetchImg(`${IMG}/w500/body-tel-reuse.png`)
      expect(first.equals(second)).toBe(true)
      expect(first.length).toBe(1024)
      // Byte-LRU reuse: a single real download, hence a single body read.
      expect(spy).toHaveBeenCalledTimes(1)
      const s = outboundStats()["image.tmdb.org"]!
      expect(s.requests).toBe(1)
      expect(s.bodyReads).toBe(1)
      expect(s.bodyBytes).toBe(1024)
      expect(s.bodyErrors).toBe(0)
    } finally {
      __resetOutboundStatsForTest()
      __resetImageBytesForTest()
    }
  })
})
