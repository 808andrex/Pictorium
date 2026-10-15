import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { normalizePosterCacheParams } from "@/lib/poster-runtime-cache"
import {
  BENCH_MAX_N,
  BENCH_PHASE_A_BASE_ID,
  BENCH_PHASE_B_BASE_ID,
  BENCH_REQUEST_TIMEOUT_MS,
  BENCH_STATUS_TIMEOUT_MS,
  assertUniqueSamples,
  buildPhaseAUrl,
  buildPhaseBUrl,
  buildWarmupAUrl,
  buildWarmupBUrl,
  evaluatePhaseDelta,
  fetchStatusSnapshot,
  isHttpPortOccupied,
  isLoopbackBaseUrl,
  isValidStatusSnapshot,
  parseBenchN,
  posterDelta,
  stats,
  waitForExit,
} from "../../scripts/bench-image-cache.mjs"

const BASE = "http://127.0.0.1:3102"
const N = 5

function normalizedKey(u: string): string {
  // Mirrors the real route key (route.ts): mediaType + tmdbId from the path
  // PLUS normalized params — the id is not part of the searchParams.
  const url = new URL(u)
  const m = url.pathname.match(/^\/api\/poster\/([^/]+)\/([^/]+)$/)
  const identity = m ? `${m[1]}:${m[2]}` : url.pathname
  return `${identity}:${normalizePosterCacheParams(url.searchParams).toString()}`
}

function movieId(u: string): string {
  const m = new URL(u).pathname.match(/^\/api\/poster\/([^/]+)\/([^/]+)$/)
  return m ? m[2] : ""
}

function fakeSnapshot(over: Record<string, number>) {
  return {
    poster: {
      requests: 0,
      hits: 0,
      renders: 0,
      errors: 0,
      staleHits: 0,
      coalescedHits: 0,
      ...over,
    },
  }
}

describe("bench-image-cache harness (validity regression)", () => {
  it("old B design (same id, only ?x=i) collapsed onto ONE key (documented bug)", () => {
    const keys = Array.from({ length: N }, (_, k) => {
      const u = new URL(`${BASE}/api/poster/movie/424242`)
      u.searchParams.set("poster", "/bench/p.jpg")
      u.searchParams.set("logo", "/bench/l.png")
      u.searchParams.set("backdrop", "/bench/b.jpg")
      u.searchParams.set("ranking", "0")
      u.searchParams.set("x", String(k + 1))
      return normalizedKey(u.toString())
    })
    // `x` is not allowlisted: every sample shared the final key — warmup
    // turned them into HITs and the bench measured the final cache, not the
    // image-level caches.
    expect(new Set(keys).size).toBe(1)
  })

  it("phase A: N distinct final identities with distinct source URLs", () => {
    const urls = Array.from({ length: N }, (_, k) => buildPhaseAUrl(BASE, k + 1))
    expect(new Set(urls).size).toBe(N)
    expect(new Set(urls.map(normalizedKey)).size).toBe(N)
    const srcs = urls.map((u) => new URL(u).searchParams.get("poster"))
    expect(new Set(srcs).size).toBe(N)
  })

  it("phase B: N distinct final identities with IDENTICAL source URLs (no ?x)", () => {
    const urls = Array.from({ length: N }, (_, k) => buildPhaseBUrl(BASE, k + 1))
    expect(new Set(urls).size).toBe(N)
    expect(new Set(urls.map(normalizedKey)).size).toBe(N)
    for (const key of ["poster", "logo", "backdrop"] as const) {
      expect(new Set(urls.map((u) => new URL(u).searchParams.get(key))).size).toBe(1)
    }
    for (const u of urls) {
      expect(new URL(u).searchParams.has("x")).toBe(false)
    }
  })

  it("symmetric identity policy: fresh disjoint ids per sample in BOTH phases", () => {
    const urlsA = Array.from({ length: N }, (_, k) => buildPhaseAUrl(BASE, k + 1))
    const urlsB = Array.from({ length: N }, (_, k) => buildPhaseBUrl(BASE, k + 1))
    const idsA = urlsA.map(movieId)
    const idsB = urlsB.map(movieId)
    // Per-sample fresh identity on both sides: same metadata/data-cache
    // workload shape, so only source-URL reuse differs by design.
    expect(new Set(idsA).size).toBe(N)
    expect(new Set(idsB).size).toBe(N)
    expect(idsA).not.toContain(String(BENCH_PHASE_B_BASE_ID))
    const overlap = idsA.filter((id) => idsB.includes(id))
    expect(overlap).toEqual([])
    // Base ranges stay disjoint within the supported sample bound.
    expect(Math.abs(BENCH_PHASE_A_BASE_ID - BENCH_PHASE_B_BASE_ID)).toBeGreaterThanOrEqual(BENCH_MAX_N + 1)
  })

  it("normalized keys disjoint across phases and warmups (no warmup HIT)", () => {
    const keys = [
      ...Array.from({ length: N }, (_, k) => normalizedKey(buildPhaseAUrl(BASE, k + 1))),
      ...Array.from({ length: N }, (_, k) => normalizedKey(buildPhaseBUrl(BASE, k + 1))),
      normalizedKey(buildWarmupAUrl(BASE)),
      normalizedKey(buildWarmupBUrl(BASE)),
    ]
    expect(new Set(keys).size).toBe(2 * N + 2)
  })

  it("warmup disjoint from measured samples (never a warmup HIT)", () => {
    const measured = new Set([
      ...Array.from({ length: N }, (_, k) => buildPhaseAUrl(BASE, k + 1)),
      ...Array.from({ length: N }, (_, k) => buildPhaseBUrl(BASE, k + 1)),
    ])
    expect(measured.has(buildWarmupAUrl(BASE))).toBe(false)
    expect(measured.has(buildWarmupBUrl(BASE))).toBe(false)
  })

  it("assertUniqueSamples fails closed on duplicates", () => {
    const urls = [buildPhaseBUrl(BASE, 1), buildPhaseBUrl(BASE, 1)]
    expect(() => assertUniqueSamples(urls, "phase B")).toThrow(/duplicat/)
  })

  it("evaluatePhaseDelta: GREEN with N real renders and zero HITs", () => {
    const before = fakeSnapshot({ requests: 10, renders: 10 })
    const after = fakeSnapshot({ requests: 15, renders: 15 })
    const res = evaluatePhaseDelta(before, after, 5, "phase A")
    expect(res.ok).toBe(true)
    expect(res.delta).toMatchObject({ requests: 5, renders: 5, hits: 0, coalescedHits: 0, staleHits: 0 })
  })

  it("evaluatePhaseDelta: RED when the phase measures final-cache HITs", () => {
    const before = fakeSnapshot({ requests: 10, renders: 10, hits: 0 })
    // Same request count but served from HITs: renders frozen, hits at N.
    const after = fakeSnapshot({ requests: 15, renders: 10, hits: 5 })
    const res = evaluatePhaseDelta(before, after, 5, "phase B")
    expect(res.ok).toBe(false)
  })

  it("evaluatePhaseDelta: RED when requests delta != expectedN", () => {
    // Renders match but the request count does not (lost/extra traffic).
    const before = fakeSnapshot({ requests: 10, renders: 10 })
    const after = fakeSnapshot({ requests: 17, renders: 15 })
    expect(evaluatePhaseDelta(before, after, 5, "phase A").ok).toBe(false)
  })

  it("evaluatePhaseDelta: RED on unreadable snapshots (fail-closed, never best-effort)", () => {
    expect(evaluatePhaseDelta(null, fakeSnapshot({}), 5, "phase A").ok).toBe(false)
    expect(evaluatePhaseDelta(fakeSnapshot({}), null, 5, "phase A").ok).toBe(false)
    expect(evaluatePhaseDelta(fakeSnapshot({}), { poster: undefined }, 5, "phase A").ok).toBe(false)
  })

  it("evaluatePhaseDelta: RED on invalid expectedN", () => {
    const before = fakeSnapshot({ requests: 0, renders: 0 })
    const after = fakeSnapshot({ requests: 5, renders: 5 })
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, BENCH_MAX_N + 1]) {
      expect(evaluatePhaseDelta(before, after, bad, "phase A").ok).toBe(false)
    }
  })

  it("posterDelta returns null without poster counters (no silent NaN)", () => {
    expect(posterDelta(null, fakeSnapshot({}))).toBeNull()
    expect(posterDelta({ outbound: {} }, fakeSnapshot({}))).toBeNull()
    const d = posterDelta(fakeSnapshot({ renders: 1 }), fakeSnapshot({ renders: 3 }))
    expect(d).toMatchObject({ renders: 2 })
    expect(numIsFinite(d)).toBe(true)
  })

  it("posterDelta fails closed on malformed counters", () => {
    const good = fakeSnapshot({ requests: 10, renders: 10 })
    const malformed = [
      { poster: { ...good.poster, renders: Number.NaN } },
      { poster: { ...good.poster, renders: 1.5 } },
      { poster: { ...good.poster, renders: -1 } },
      { poster: { ...good.poster, renders: "10" } },
      { poster: { ...good.poster, hits: undefined } },
      { poster: {} },
    ]
    for (const bad of malformed) {
      expect(posterDelta(good, bad)).toBeNull()
      expect(posterDelta(bad, good)).toBeNull()
    }
  })

  it("posterDelta fails closed on counter reset (after < before)", () => {
    const before = fakeSnapshot({ requests: 10, renders: 10 })
    const after = fakeSnapshot({ requests: 15, renders: 9 })
    expect(posterDelta(before, after)).toBeNull()
    expect(evaluatePhaseDelta(before, after, 5, "phase A").ok).toBe(false)
  })

  it("parseBenchN validates the sample count before spawning", () => {
    expect(parseBenchN(undefined, 25)).toBe(25)
    expect(parseBenchN("", 25)).toBe(25)
    expect(parseBenchN("5", 25)).toBe(5)
    expect(parseBenchN(5, 25)).toBe(5)
    for (const bad of ["0", "-3", "2.5", "abc", "Infinity", "NaN", String(BENCH_MAX_N + 1), 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseBenchN(bad, 25)).toThrow()
    }
  })

  it("isLoopbackBaseUrl only allows local scope", () => {
    expect(isLoopbackBaseUrl("http://127.0.0.1:3102")).toBe(true)
    expect(isLoopbackBaseUrl("http://localhost:3102")).toBe(true)
    expect(isLoopbackBaseUrl("http://[::1]:3102")).toBe(true)
    expect(isLoopbackBaseUrl("https://example.com")).toBe(false)
    expect(isLoopbackBaseUrl("http://192.168.1.10:3102")).toBe(false)
    expect(isLoopbackBaseUrl("not-a-url")).toBe(false)
    expect(isLoopbackBaseUrl("")).toBe(false)
  })

  it("isValidStatusSnapshot rejects missing/malformed status", () => {
    expect(isValidStatusSnapshot(fakeSnapshot({ requests: 1 }))).toBe(true)
    expect(isValidStatusSnapshot(null)).toBe(false)
    expect(isValidStatusSnapshot({})).toBe(false)
    expect(isValidStatusSnapshot({ poster: {} })).toBe(false)
    expect(isValidStatusSnapshot({ poster: { requests: 1, hits: 0, renders: 1, errors: 0, staleHits: 0 } })).toBe(false)
    expect(isValidStatusSnapshot({ poster: { requests: Number.NaN, hits: 0, renders: 1, errors: 0, staleHits: 0, coalescedHits: 0 } })).toBe(false)
    expect(isValidStatusSnapshot({ poster: { requests: -1, hits: 0, renders: 1, errors: 0, staleHits: 0, coalescedHits: 0 } })).toBe(false)
  })

  it("isLoopbackBaseUrl requires http(s) with no userinfo, path, query, or fragment", () => {
    for (const ok of [
      "http://127.0.0.1:3102",
      "http://127.0.0.1:3102/",
      "http://localhost:3102",
      "http://localhost:3102/",
      "http://[::1]:3102",
      "https://127.0.0.1:3102",
    ]) {
      expect(isLoopbackBaseUrl(ok)).toBe(true)
    }
    for (const bad of [
      "ftp://127.0.0.1:3102/",
      "file:///etc/passwd",
      "http://user@127.0.0.1:3102",
      "http://user:pass@127.0.0.1:3102",
      "http://127.0.0.1:3102/base",
      "http://127.0.0.1:3102/api/health",
      "http://127.0.0.1:3102/?x=1",
      "http://127.0.0.1:3102/#frag",
      "http://127.0.0.1:3102/?x=1#frag",
    ]) {
      expect(isLoopbackBaseUrl(bad)).toBe(false)
    }
  })

  it("fetchStatusSnapshot refuses redirects: token-bearing request never reaches the redirect target", async () => {
    let sinkCalls = 0
    const sink = createServer((_req, res) => {
      sinkCalls++
      res.setHeader("content-type", "application/json")
      res.statusCode = 200
      res.end(JSON.stringify(fakeSnapshot({ requests: 1, renders: 1 })))
    })
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve))
    const sinkPort = (sink.address() as AddressInfo).port
    const redirector = createServer((_req, res) => {
      res.statusCode = 302
      res.setHeader("location", `http://127.0.0.1:${sinkPort}/api/cache/status`)
      res.end()
    })
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve))
    const redirectPort = (redirector.address() as AddressInfo).port
    try {
      const snap = await fetchStatusSnapshot(`http://127.0.0.1:${redirectPort}`, { "x-admin-token": "secret-token" })
      expect(snap).toBeNull()
      expect(sinkCalls).toBe(0)
    } finally {
      await new Promise<void>((resolve, reject) => redirector.close((e) => (e ? reject(e) : resolve())))
      await new Promise<void>((resolve, reject) => sink.close((e) => (e ? reject(e) : resolve())))
    }
  })

  it("fetchStatusSnapshot returns parsed JSON on a direct 200 (normal path)", async () => {
    const body = fakeSnapshot({ requests: 1, renders: 1 })
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json")
      res.statusCode = 200
      res.end(JSON.stringify(body))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    try {
      await expect(fetchStatusSnapshot(`http://127.0.0.1:${port}`, {})).resolves.toEqual(body)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
    }
  })

  it("isHttpPortOccupied reports a redirect response as occupied without following it", async () => {
    let sinkCalls = 0
    const sink = createServer((_req, res) => {
      sinkCalls++
      res.statusCode = 200
      res.end("ok")
    })
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve))
    const sinkPort = (sink.address() as AddressInfo).port
    const redirector = createServer((_req, res) => {
      res.statusCode = 301
      res.setHeader("location", `http://127.0.0.1:${sinkPort}/healthz`)
      res.end()
    })
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve))
    const redirectPort = (redirector.address() as AddressInfo).port
    try {
      // A 301/302 response proves a listener owns the port: occupied, and the
      // redirect target must never be fetched.
      await expect(isHttpPortOccupied(`http://127.0.0.1:${redirectPort}/healthz`)).resolves.toBe(true)
      expect(sinkCalls).toBe(0)
    } finally {
      await new Promise<void>((resolve, reject) => redirector.close((e) => (e ? reject(e) : resolve())))
      await new Promise<void>((resolve, reject) => sink.close((e) => (e ? reject(e) : resolve())))
    }
  })

  it("isHttpPortOccupied detects a listener and a free port", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 200
      res.end("ok")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    try {
      await expect(isHttpPortOccupied(`http://127.0.0.1:${port}/healthz`)).resolves.toBe(true)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
    }
    await expect(isHttpPortOccupied(`http://127.0.0.1:${port}/healthz`)).resolves.toBe(false)
  })

  it("waitForExit observes an owned child exiting", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" })
    await expect(waitForExit(child, 10000)).resolves.toBe(true)
    expect(child.exitCode).not.toBeNull()
  })

  it("harness fetch timeouts are finite and positive", () => {
    expect(Number.isFinite(BENCH_STATUS_TIMEOUT_MS)).toBe(true)
    expect(BENCH_STATUS_TIMEOUT_MS).toBeGreaterThan(0)
    expect(Number.isFinite(BENCH_REQUEST_TIMEOUT_MS)).toBe(true)
    expect(BENCH_REQUEST_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it("stats: honest avg/p50/p95 over samples", () => {
    const s = stats([{ ms: 10 }, { ms: 20 }, { ms: 30 }, { ms: 40 }, { ms: 100 }].map((x) => ({ ...x })))
    expect(Math.round(s.avg)).toBe(40)
    expect(s.p50).toBe(30)
    expect(s.p95).toBe(100)
  })
})

function numIsFinite(d: ReturnType<typeof posterDelta>): boolean {
  if (!d) return false
  return Object.values(d).every((v) => Number.isFinite(v))
}
