// Targeted benchmark: image-level cache payoff (badge colors, logo resize,
// backdrop resize, byte LRU) on repeated renders of the same title.
//
// The poster cache is keyed on ALL params, so two requests for one title under
// different keys re-run the whole sharp pipeline, including steps that only
// depend on the source image (skipped after the first render via the
// image-level caches in poster-service.ts / image-bytes-cache.ts).
//
// Design (both phases use a fresh disjoint id per sample — symmetric identity
// policy — so ONLY source-URL reuse differs; never vary just `x` in phase B,
// it is stripped by normalization and collapses all samples onto one key):
//   Phase A (baseline): fresh id + unique poster/logo/backdrop paths per
//     sample → different final keys AND sources: extraction/resize/download
//     repeat every time.
//   Phase B (cached): fresh id per sample, SAME paths → different final keys
//     (id is part of the key) but identical sources: bytes/analysis/resize
//     come from image-level caches after the first render. The mock is
//     deterministic per numeric id, so all bodies stay byte-identical
//     (sha256-checked).
// Self-spawned app = private throwaway instance on loopback (explicit child
// env), so anonymous image overrides survive and separate the keys — verified
// fail-closed by the renders=N gates. Warmup uses index 0 of each id range,
// measured samples 1..N: warming a measured identity would turn it into a HIT.
// Every phase MUST yield exactly N real renders (requests/renders deltas == N,
// zero hits/coalesced/stale): any HIT is a fail-closed FAIL, not data.
// `ranking=0` isolates pure image work. Timing (avg/p50/p95) is INFORMATIONAL:
// timings may be affected by dev/JIT/GC, so no clock gate — correctness gates
// decide, and no speedup is established from the clock alone. Outbound host counts show network work only, not CPU cost.
//
// Usage:
//   node scripts/bench-image-cache.mjs
//   PICTORIUM_BASE_URL=http://127.0.0.1:3100 node scripts/bench-image-cache.mjs
//   BENCH_N=25 node scripts/bench-image-cache.mjs
//   BENCH_ADMIN_TOKEN=<token> node scripts/bench-image-cache.mjs  # existing instance

import { spawn, spawnSync } from "node:child_process"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const BASE_URL = process.env.PICTORIUM_BASE_URL || process.env.POSTERIUM_BASE_URL || ""
const PORT = Number(process.env.BENCH_PORT) || 3102
const MOCK_PORT = Number(process.env.BENCH_MOCK_PORT) || 8792

// Sample identities: fresh disjoint id per sample in EACH phase (symmetric
// policy). Ranges stay disjoint within the supported sample bound. Warmup uses
// index 0 of each range; measured samples use 1..N.
export const BENCH_PHASE_A_BASE_ID = 424000
export const BENCH_PHASE_B_BASE_ID = 425000
export const BENCH_MAX_N = 100

/** Validated sample count (throws before anything is spawned). */
export function parseBenchN(raw, fallback = 25) {
  if (raw === undefined || raw === null || raw === "") return fallback
  const n = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > BENCH_MAX_N) {
    throw new Error(`Invalid BENCH_N ${JSON.stringify(raw)}: expected an integer 1..${BENCH_MAX_N}`)
  }
  return n
}

const N = parseBenchN(process.env.BENCH_N, 25)
const appUrl = BASE_URL || `http://127.0.0.1:${PORT}`

/** Local-only scope: loopback http(s) root origins only — no embedded
 *  credentials, path, query, or fragment, so request paths stay unambiguous.
 *  Harness fetches additionally never follow redirects, so the admin token
 *  cannot be forwarded to a redirect target. */
export function isLoopbackBaseUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  if (url.username || url.password) return false
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return false
  const raw = url.hostname.toLowerCase()
  const host = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "::ffff:127.0.0.1"
}

/** True when an HTTP response arrives (any status, incl 3xx): the port is owned.
 *  Redirects are never followed (manual), only observed. */
export async function isHttpPortOccupied(url, timeoutMs = 2000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "manual" })
    try {
      await res.body?.cancel()
    } catch {
      // body already consumed/closed — response already proves occupancy
    }
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Resolves true once the owned child has exited (false on timeout). */
export function waitForExit(child, timeoutMs = 10000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(true)
      return
    }
    const timer = setTimeout(() => {
      child.off?.("exit", onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once?.("exit", onExit)
  })
}

function log(msg) {
  console.log(`[bench-image-cache] ${msg}`)
}

async function waitFor(url, timeoutMs, label, headers = {}) {
  const deadline = Date.now() + timeoutMs
  let lastBody = ""
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers, redirect: "error" })
      if (res.ok) return
      lastBody = (await res.text()).slice(0, 400)
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Timeout waiting for ${label} (${url}) — last response: ${lastBody || "no response"}`)
}

const children = []
function spawnNode(args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit"],
  })
  children.push(child)
  return child
}

function terminateTree(child) {
  try {
    if (child.exitCode !== null || child.pid === undefined) return
    if (process.platform === "win32") {
      // Includes the Next child process tree (dev server workers).
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
    } else {
      child.kill("SIGTERM")
    }
  } catch {
    // already exited
  }
}

async function shutdown(exitCode) {
  try {
    for (const child of children) terminateTree(child)
    await Promise.allSettled(children.map((c) => waitForExit(c, 10000)))
    for (const child of children) {
      if (child.exitCode === null) {
        try {
          if (process.platform === "win32" && child.pid !== undefined) {
            spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
          } else {
            child.kill("SIGKILL")
          }
        } catch {
          // already exited
        }
      }
    }
    await Promise.allSettled(children.map((c) => waitForExit(c, 5000)))
    children.length = 0
  } finally {
    process.exit(exitCode)
  }
}

// Same health key as the load smoke test: /api/health is 503 without a key.
// Admin token for /api/cache/status (fail-closed without one). In
// self-spawned mode an ephemeral token is generated when the user provides
// none and forwarded ONLY to the loopback child (never logged, never sent
// elsewhere). In existing-app mode an explicit BENCH_ADMIN_TOKEN is required.
let adminToken = process.env.BENCH_ADMIN_TOKEN || ""
const healthKey = process.env.BENCH_HEALTH_KEY || "mock-key"
let ephemeralAdminToken = false
if (!adminToken && !BASE_URL) {
  adminToken = crypto.randomBytes(24).toString("hex")
  ephemeralAdminToken = true
}
const adminHeaders = adminToken ? { "x-admin-token": adminToken } : {}

/** Finite per-attempt ceilings so harness fetches can never hang forever. */
export const BENCH_STATUS_TIMEOUT_MS = 10000
export const BENCH_REQUEST_TIMEOUT_MS = 120000

/** Raw /api/cache/status snapshot (null = unreadable or redirect, fail-closed).
 *  Redirects are refused, never followed, so the admin token cannot be
 *  forwarded to a redirect target. */
export async function fetchStatusSnapshot(base, headers) {
  try {
    const res = await fetch(`${base}/api/cache/status`, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(BENCH_STATUS_TIMEOUT_MS),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function statusSnapshot() {
  return fetchStatusSnapshot(appUrl, adminHeaders)
}

function outboundDelta(before, after) {
  const rows = []
  for (const [host, a] of Object.entries(after || {})) {
    const b = (before || {})[host] || { requests: 0, errors: 0 }
    rows.push({ host, req: a.requests - b.requests, err: a.errors - b.errors, avgMs: a.avgMs })
  }
  return rows.sort((x, y) => y.req - x.req)
}

const POSTER_COUNTER_KEYS = ["requests", "hits", "renders", "errors", "staleHits", "coalescedHits"]

function isCounter(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 0
}

/** Snapshot carries readable, well-formed poster counters (observability gate). */
export function isValidStatusSnapshot(snap) {
  if (!snap || !snap.poster) return false
  return POSTER_COUNTER_KEYS.every((k) => isCounter(snap.poster[k]))
}

/**
 * Poster counter delta between two snapshots. Returns null on
 * missing/malformed counters or counter resets — malformed stats must never
 * look like a clean phase.
 */
export function posterDelta(before, after) {
  if (!isValidStatusSnapshot(before) || !isValidStatusSnapshot(after)) return null
  const a = before.poster
  const b = after.poster
  const d = {}
  for (const k of POSTER_COUNTER_KEYS) {
    d[k] = b[k] - a[k]
    if (d[k] < 0) return null
  }
  return d
}

/**
 * Correctness gate for one phase: every measured sample MUST be a real render
 * (requests and renders deltas == expectedN, zero hits/coalesced/stale).
 * Returns { ok, lines } — never throws on missing snapshots: ok:false.
 */
export function evaluatePhaseDelta(before, after, expectedN, label) {
  const lines = []
  if (!Number.isInteger(expectedN) || expectedN < 1 || expectedN > BENCH_MAX_N) {
    lines.push(`${label}: invalid expectedN ${JSON.stringify(expectedN)} (fail-closed)`)
    return { ok: false, lines, delta: null }
  }
  const d = posterDelta(before, after)
  if (!d) {
    lines.push(`${label}: /api/cache/status snapshot unreadable or malformed (fail-closed)`)
    return { ok: false, lines, delta: null }
  }
  lines.push(
    `${label}: Δrequests=${d.requests} Δrenders=${d.renders} Δhits=${d.hits} Δcoalesced=${d.coalescedHits} Δstale=${d.staleHits} Δerrors=${d.errors} (expected requests=renders=${expectedN}, rest 0)`,
  )
  const ok =
    d.requests === expectedN &&
    d.renders === expectedN &&
    d.hits === 0 &&
    d.coalescedHits === 0 &&
    d.staleHits === 0 &&
    d.errors === 0
  if (!ok) {
    lines.push(`${label}: FAIL — expected exactly ${expectedN} real renders without HITs/coalesced/stale/errors`)
  }
  return { ok, lines, delta: d }
}

/** Fail fast on duplicate sample identities (a reused URL is a certain HIT). */
export function assertUniqueSamples(urls, label) {
  const seen = new Set()
  for (const u of urls) {
    if (seen.has(u)) throw new Error(`${label}: duplicate sample identity: ${u}`)
    seen.add(u)
  }
  return urls
}

export function buildPhaseAUrl(base, i) {
  // Fresh id + unique paths per sample: color extraction + resize repeat.
  const u = new URL(`${base}/api/poster/movie/${BENCH_PHASE_A_BASE_ID + i}`)
  u.searchParams.set("poster", `/bench/p${i}.jpg`)
  u.searchParams.set("logo", `/bench/l${i}.png`)
  u.searchParams.set("backdrop", `/bench/b${i}.jpg`)
  u.searchParams.set("ranking", "0")
  u.searchParams.set("voteAverage", "7.5")
  u.searchParams.set("genreName", "Action")
  u.searchParams.set("tl", "0")
  return u.toString()
}

export function buildPhaseBUrl(base, i) {
  // Fixed paths (same sources → image-level caches help) + a DIFFERENT id per
  // sample: the id is part of the poster cache key, so every sample really
  // renders. No `x`: it would be stripped by normalization and collapse all
  // samples onto one key (the original bug).
  const u = new URL(`${base}/api/poster/movie/${BENCH_PHASE_B_BASE_ID + i}`)
  u.searchParams.set("poster", "/bench/p.jpg")
  u.searchParams.set("logo", "/bench/l.png")
  u.searchParams.set("backdrop", "/bench/b.jpg")
  u.searchParams.set("ranking", "0")
  u.searchParams.set("voteAverage", "7.5")
  u.searchParams.set("genreName", "Action")
  u.searchParams.set("tl", "0")
  return u.toString()
}

export function buildWarmupAUrl(base) {
  // Index 0 is never used by measured samples (1..N): warmup cannot poison A.
  return buildPhaseAUrl(base, 0)
}

export function buildWarmupBUrl(base) {
  // Index 0 is never used by measured samples (1..N): warmup cannot poison B.
  return buildPhaseBUrl(base, 0)
}

function posterUrl(i, phase) {
  return phase === "A" ? buildPhaseAUrl(appUrl, i) : buildPhaseBUrl(appUrl, i)
}

async function request(url) {
  const t0 = Date.now()
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(BENCH_REQUEST_TIMEOUT_MS) })
  const buf = Buffer.from(await res.arrayBuffer())
  return {
    ms: Date.now() - t0,
    status: res.status,
    hash: crypto.createHash("sha256").update(buf).digest("hex"),
    serverTiming: res.headers.get("server-timing") || "",
  }
}

export function stats(samples) {
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b)
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length
  const p50 = sorted[Math.floor(sorted.length * 0.5)]
  const p95 = sorted[Math.floor(sorted.length * 0.95)]
  return { avg, p50, p95 }
}

async function run() {
  // Fail fast: duplicates are certain HITs, no point starting the app.
  assertUniqueSamples(Array.from({ length: N }, (_, k) => posterUrl(k + 1, "A")), "phase A")
  assertUniqueSamples(Array.from({ length: N }, (_, k) => posterUrl(k + 1, "B")), "phase B")
  const warmA = buildWarmupAUrl(appUrl)
  const warmB = buildWarmupBUrl(appUrl)
  const measured = new Set([
    ...Array.from({ length: N }, (_, k) => posterUrl(k + 1, "A")),
    ...Array.from({ length: N }, (_, k) => posterUrl(k + 1, "B")),
  ])
  if (measured.has(warmA) || measured.has(warmB)) {
    throw new Error("Warmup collides with a measured sample (certain HIT)")
  }

  if (!BASE_URL) {
    const mockUrl = `http://127.0.0.1:${MOCK_PORT}`
    // Refuse to measure another process: a port that already answers belongs
    // to someone else, and readiness would succeed against the wrong server.
    if (await isHttpPortOccupied(`${mockUrl}/healthz`)) {
      throw new Error(`Mock port ${MOCK_PORT} already serves traffic — refusing to measure another process`)
    }
    if (await isHttpPortOccupied(`${appUrl}/api/health`)) {
      throw new Error(`App port ${PORT} already serves traffic — refusing to measure another process (set PICTORIUM_BASE_URL for existing-app mode)`)
    }
    log(`Starting mock server on :${MOCK_PORT}`)
    spawnNode([path.join(rootDir, "e2e", "mock-server.mjs")], { MOCK_PORT: String(MOCK_PORT) })
    await waitFor(`${mockUrl}/healthz`, 15000, "mock server")

    log(`Starting app on :${PORT} (heap capped at 384MB)`)
    spawnNode(
      [path.join(rootDir, "node_modules", "next", "dist", "bin", "next"), "dev", "-H", "127.0.0.1", "-p", String(PORT)],
      {
        NEXT_DIST_DIR: ".next-bench",
        POSTERIUM_DATA_DIR: path.join(rootDir, ".next-bench", "data"),
        PICTORIUM_DATA_DIR: path.join(rootDir, ".next-bench", "data"),
        NODE_OPTIONS: "--max-old-space-size=384",
        // Private throwaway instance on loopback: anonymous image overrides
        // survive and separate the sample keys (fail-closed via renders=N).
        PICTORIUM_MULTI_USER: "0",
        PICTORIUM_HOSTED_BY: "",
        PICTORIUM_POSTER_PARAMS: "free",
        // Explicit PORT: background self-fetch targets 127.0.0.1:${PORT}
        // instead of the default 3000 (same as load-smoke).
        PORT: String(PORT),
        TMDB_BASE_URL: `${mockUrl}/3`,
        TMDB_IMG_URL: `${mockUrl}/t/p`,
        NEXT_PUBLIC_TMDB_IMG_URL: `${mockUrl}/t/p`,
        JUSTWATCH_API_URL: `${mockUrl}/graphql`,
        WIKIDATA_SPARQL_URL: `${mockUrl}/sparql`,
        WIKIDATA_API_URL: `${mockUrl}/w/api.php`,
        IMDB_CHART_URL: `${mockUrl}/chart/top`,
        MDBLIST_API_URL: `${mockUrl}/mdblist/api`,
        PICTORIUM_ADMIN_TOKEN: adminToken,
      },
    )
    await waitFor(`${appUrl}/api/health`, 120000, "app", { "x-api-key": healthKey })
  } else {
    log(`Using existing app: ${appUrl}`)
    // Fail BEFORE any network: snapshots are unreadable without a token and
    // credentials must never go to an external origin (local-only scope).
    if (!process.env.BENCH_ADMIN_TOKEN) {
      throw new Error("Existing-app mode requires BENCH_ADMIN_TOKEN — refusing to run samples without observability (token never logged)")
    }
    if (!isLoopbackBaseUrl(appUrl)) {
      throw new Error(`Refusing non-loopback BASE_URL ${appUrl} (local-only scope: no auth to external origins)`)
    }
    await waitFor(`${appUrl}/api/health`, 10000, "app", { "x-api-key": healthKey })
  }

  if (ephemeralAdminToken) {
    log("Ephemeral admin token issued for snapshots (loopback only, never logged)")
  }

  // Observability gate BEFORE warmup/load: without a valid snapshot the phase
  // gates cannot distinguish renders from HITs, so refuse to run blind.
  const preWarm = await statusSnapshot()
  if (!isValidStatusSnapshot(preWarm)) {
    throw new Error(
      "Unusable /api/cache/status snapshot before warmup — refusing to run samples without observability (self-spawned: automatic; existing app: BENCH_ADMIN_TOKEN)",
    )
  }

  // Warmup on identities DISJOINT from samples (compiles routes, fills badge
  // PNG cache and other one-shot caches) — excluded from measured keys/stats.
  log(`Warmup (1 request per phase on disjoint identities, then ${N} measured per phase)`)
  await request(warmA)
  await request(warmB)
  const out0 = await statusSnapshot()

  // Sequential (await in loop): no coalescing between samples — every request
  // must resolve its own render.
  const phaseA = []
  for (let i = 1; i <= N; i++) phaseA.push(await request(posterUrl(i, "A")))
  const outA = await statusSnapshot()
  const phaseB = []
  for (let i = 1; i <= N; i++) phaseB.push(await request(posterUrl(i, "B")))
  const outB = await statusSnapshot()

  const aStats = stats(phaseA)
  const bStats = stats(phaseB)
  const fmt = (s) => `${Math.round(s.avg)}ms avg | p50 ${Math.round(s.p50)}ms | p95 ${Math.round(s.p95)}ms`
  const delta = (a, b) => `${(((a - b) / a) * 100).toFixed(1)}%`

  log("--- Results (timing INFORMATIONAL: timings may be affected by dev/JIT/GC; no speedup established) ---")
  log(`Phase A (unique paths, image-level caches useless): ${fmt(aStats)}`)
  log(`Phase B (same sources, different ids, caches warm): ${fmt(bStats)}`)
  log(`Delta: p50 ${delta(aStats.p50, bStats.p50)} | p95 ${delta(aStats.p95, bStats.p95)} | avg ${delta(aStats.avg, bStats.avg)}`)

  const allSamples = [...phaseA, ...phaseB]
  const allOk = allSamples.every((s) => s.status === 200)
  const allSameHash = new Set(allSamples.map((s) => s.hash)).size === 1
  log(`Status: all 200 = ${allOk ? "yes" : "NO"} (${allSamples.map((s) => s.status).join(",")})`)
  log(`Body sha256: identical output = ${allSameHash ? "yes" : "NO!"}`)
  const hitMarkers = allSamples.filter((s) => s.serverTiming.includes('cache";desc="HIT') || s.serverTiming.includes('cache;desc="HIT'))
  log(`Server-Timing HIT on measured samples: ${hitMarkers.length} (expected 0)`)

  // Outbound per phase: where the network really went (outbound requests per
  // host). Network counts only — they cannot isolate CPU/render savings.
  const printOutbound = (label, before, after) => {
    if (!before || !after) {
      log(`Outbound ${label}: snapshot unavailable (status route unreachable? set BENCH_ADMIN_TOKEN on existing apps)`)
      return
    }
    const rows = outboundDelta(before.outbound || {}, after.outbound || {})
    if (rows.length === 0) {
      log(`Outbound ${label}: snapshot unavailable (status route unreachable?)`)
      return
    }
    log(`Outbound ${label} (outbound requests per host in phase):`)
    for (const r of rows) log(`  ${r.host}: ${r.req} req, ${r.err} err, avg ${r.avgMs}ms`)
  }
  printOutbound("phase A", out0, outA)
  printOutbound("phase B", outA, outB)

  let exitCode = 0
  const fail = (msg) => {
    log(`FAIL: ${msg}`)
    exitCode = 1
  }
  if (!allOk) fail("non-200 status in requests")
  if (!allSameHash) fail("bodies differ — identity variation changed the output!")
  if (hitMarkers.length > 0) fail(`${hitMarkers.length} samples served from final-cache HIT instead of a real render`)
  for (const { label, before, after } of [
    { label: "phase A", before: out0, after: outA },
    { label: "phase B", before: outA, after: outB },
  ]) {
    const evalRes = evaluatePhaseDelta(before, after, N, label)
    for (const line of evalRes.lines) log(line)
    if (!evalRes.ok) {
      exitCode = 1
      if (!isValidStatusSnapshot(before) || !isValidStatusSnapshot(after)) {
        log("Detail: /api/cache/status needs the admin token (self-spawned: automatic; existing app: BENCH_ADMIN_TOKEN)")
      }
    }
  }
  if (bStats.p50 < aStats.p50) {
    log("Timing only: phase B p50 lower (informational — timings may be affected by dev/JIT/GC; no speedup established from the clock alone)")
  } else {
    log("Timing only: no speedup established (timings may be affected by dev/JIT/GC); verdict comes from the correctness gates")
  }

  log(exitCode === 0 ? "PASS: N real renders per phase, zero HITs, identical output" : `EXIT ${exitCode}`)
  await shutdown(exitCode)
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  run().catch(async (e) => {
    console.error("[bench-image-cache] Error:", e)
    await shutdown(1)
  })
}
