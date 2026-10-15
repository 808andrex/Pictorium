import { afterEach, describe, expect, it, vi } from "vitest"
import {
  __resetOutboundStatsForTest,
  outboundStats,
  readResponseBody,
  timedFetch,
} from "@/lib/outbound-stats"

afterEach(() => {
  __resetOutboundStatsForTest()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("timedFetch", () => {
  it("counts requests per hostname with latency", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
    await timedFetch("https://api.example.com/x")
    await timedFetch("https://api.example.com/y")
    const s = outboundStats()
    expect(s["api.example.com"]?.requests).toBe(2)
    expect(s["api.example.com"]?.errors).toBe(0)
    expect(s["api.example.com"]?.lastMs).toBeGreaterThanOrEqual(0)
    expect(s["api.example.com"]?.avgMs).toBeGreaterThanOrEqual(0)
  })

  it("counts rejections as errors and rethrows", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"))
    await expect(timedFetch("https://down.example.com/")).rejects.toThrow("down")
    const s = outboundStats()
    expect(s["down.example.com"]).toMatchObject({ requests: 1, errors: 1 })
  })

  it("falls back to unknown on invalid URL without throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
    await timedFetch("not a url [[[")
    expect(outboundStats()["unknown"]?.requests).toBe(1)
  })

  it("returns the original response untouched (1:1 delegation)", async () => {
    const body = '{"a":1}'
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 201 }))
    const res = await timedFetch("https://api.example.com/z")
    expect(res.status).toBe(201)
    expect(await res.text()).toBe(body)
  })

  it("bounds the host map", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
    for (let i = 0; i < 80; i++) await timedFetch(`https://h${i}.example.com/`)
    expect(Object.keys(outboundStats()).length).toBeLessThanOrEqual(64)
  })
})

describe("timedFetch HTTP vs transport errors", () => {
  it("200 keeps legacy errors at 0 and reports no http/transport errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
    await timedFetch("https://api.example.com/ok")
    expect(outboundStats()["api.example.com"]).toMatchObject({
      requests: 1,
      errors: 0,
      httpErrors: 0,
      transportErrors: 0,
    })
  })

  it("429/500 count as HTTP errors without touching legacy transport errors", async () => {
    const spy = vi.spyOn(globalThis, "fetch")
    spy.mockResolvedValueOnce(new Response("limited", { status: 429 }))
    spy.mockResolvedValueOnce(new Response("boom", { status: 500 }))
    await timedFetch("https://cdn.example.com/a")
    await timedFetch("https://cdn.example.com/b")
    expect(outboundStats()["cdn.example.com"]).toMatchObject({
      requests: 2,
      errors: 0,
      httpErrors: 2,
      transportErrors: 0,
    })
  })

  it("sync throw counts as transport error only", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("sync down")
    })
    expect(() => timedFetch("https://sync.example.com/")).toThrow("sync down")
    expect(outboundStats()["sync.example.com"]).toMatchObject({
      requests: 1,
      errors: 1,
      httpErrors: 0,
      transportErrors: 1,
    })
  })

  it("async rejection counts as transport error only", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("async down"))
    await expect(timedFetch("https://rej.example.com/")).rejects.toThrow("async down")
    expect(outboundStats()["rej.example.com"]).toMatchObject({
      requests: 1,
      errors: 1,
      httpErrors: 0,
      transportErrors: 1,
    })
  })

  it("returns the identical Response object (identity preserved)", async () => {
    const original = new Response("same", { status: 200 })
    vi.spyOn(globalThis, "fetch").mockResolvedValue(original)
    const res = await timedFetch("https://id.example.com/")
    expect(res).toBe(original)
  })

  it("stays safe on nonstandard mock resolutions", async () => {
    const spy = vi.spyOn(globalThis, "fetch")
    spy.mockResolvedValueOnce(undefined as unknown as Response)
    spy.mockResolvedValueOnce({ ok: true, status: "weird" } as unknown as Response)
    await timedFetch("https://odd.example.com/a")
    await timedFetch("https://odd.example.com/b")
    const s = outboundStats()["odd.example.com"]
    expect(s.requests).toBe(2)
    // Nonstandard shapes must never be misclassified as HTTP failures.
    expect(s.httpErrors).toBe(0)
  })

  it("exposes header-timing aliases equal to header latency (not full-body TTFB)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
    await timedFetch("https://hdr.example.com/")
    const s = outboundStats()["hdr.example.com"]!
    expect(s.avgHeaderMs).toBe(s.avgMs)
    expect(s.lastHeaderMs).toBe(s.lastMs)
  })

  it("reset clears HTTP/transport/body counters too", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x", { status: 500 }))
    await timedFetch("https://rst.example.com/")
    __resetOutboundStatsForTest()
    expect(outboundStats()).toEqual({})
  })
})

describe("readResponseBody (opt-in image body telemetry)", () => {
  function trackedResponse(body: string, status = 200): Promise<Response> {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status }))
    return timedFetch("https://img.example.com/pic")
  }

  it("returns exact bytes and records body success without inflating requests", async () => {
    const res = await trackedResponse("imagedata")
    const before = outboundStats()["img.example.com"]!
    const buf = await readResponseBody(res)
    expect(Buffer.from(buf).toString()).toBe("imagedata")
    const after = outboundStats()["img.example.com"]!
    expect(after.requests).toBe(before.requests)
    expect(after.errors).toBe(before.errors)
    expect(after.httpErrors).toBe(before.httpErrors)
    expect(after.bodyReads).toBe(1)
    expect(after.bodyErrors).toBe(0)
    expect(after.bodyBytes).toBe("imagedata".length)
  })

  it("measures body completion separately from header latency on delayed bodies", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const payload = "slow-bytes"
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        // Fixed clock: advance mocked time by exactly 250ms inside the body
        // phase, so header and body timings are asserted exactly.
        arrayBuffer: async () => {
          vi.setSystemTime(Date.now() + 250)
          return new TextEncoder().encode(payload).buffer as ArrayBuffer
        },
      } as unknown as Response)
      const res = await timedFetch("https://slow.example.com/pic")
      const headerMs = outboundStats()["slow.example.com"]!.lastHeaderMs
      const buf = await readResponseBody(res)
      expect(Buffer.from(buf).toString()).toBe(payload)
      const s = outboundStats()["slow.example.com"]!
      expect(s.bodyReads).toBe(1)
      expect(s.bodyBytes).toBe(payload.length)
      // Header latency is the instant resolve; body completion took exactly 250ms.
      expect(headerMs).toBe(0)
      expect(s.lastBodyReadMs).toBe(250)
      expect(s.avgBodyReadMs).toBe(250)
    } finally {
      vi.useRealTimers()
    }
  })

  it("body failure rethrows the same error and counts bodyErrors only", async () => {
    const failure = new Error("body exploded")
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: () => Promise.reject(failure),
    } as unknown as Response)
    const res = await timedFetch("https://fail.example.com/pic")
    await expect(readResponseBody(res)).rejects.toBe(failure)
    const s = outboundStats()["fail.example.com"]!
    expect(s.requests).toBe(1)
    expect(s.errors).toBe(0)
    expect(s.httpErrors).toBe(0)
    expect(s.bodyReads).toBe(0)
    expect(s.bodyErrors).toBe(1)
  })

  it("preserves cancellation: abort rejection propagates unchanged", async () => {
    const abortErr = new DOMException("aborted", "AbortError")
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: () => Promise.reject(abortErr),
    } as unknown as Response)
    const res = await timedFetch("https://cancel.example.com/pic")
    await expect(readResponseBody(res)).rejects.toBe(abortErr)
    expect(outboundStats()["cancel.example.com"]).toMatchObject({ bodyErrors: 1, requests: 1 })
  })

  it("leaves untracked responses alone (no fabricated stats)", async () => {
    const res = new Response("direct", { status: 200 })
    const buf = await readResponseBody(res)
    expect(Buffer.from(buf).toString()).toBe("direct")
    expect(outboundStats()).toEqual({})
  })

  it("reset before a body read drops the pending observation (no repopulation)", async () => {
    const res = await trackedResponse("stale-bytes")
    __resetOutboundStatsForTest()
    const buf = await readResponseBody(res)
    expect(Buffer.from(buf).toString()).toBe("stale-bytes")
    // The pre-reset tracked Response must not repopulate fresh counters.
    expect(outboundStats()).toEqual({})
  })
})
