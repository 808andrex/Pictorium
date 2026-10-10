# Maintenance record — 2026-10-10

Docs-only record of the stability batch staged in the working tree on 2026-10-10.
No source, test, or config changes are made by this file; it only describes work
already present in the tree plus the one residual risk the user explicitly accepted.

## What this batch fixes

- **Atomic KV quota (4 races):** `savePreset`, mapping `upsert`, mapping
  `importMappings`, and alias `setImdbAlias` now decide quota inside a single
  server-side `EVAL` on both adapters (Redis and Upstash). Concurrent writers
  racing at `max - 1` admit exactly one writer; the loser gets the quota error
  (HTTP 413 per the route contract) and the stored count never exceeds max.
  Verified against a real Redis 7.4.11 standalone backend (36 + 19 actual
  assertions). The historical "20 supplement tests" label elsewhere is an info
  marker, not an assertion count.
- **Wrong top-level JSON shape (cold/warm fallback):** the four file loaders
  (`loadFromDisk`, `loadUserFromDisk`, `loadAliasesFromDisk`,
  `loadUserAliasesFromDisk`) now reject valid-JSON-but-wrong-shape payloads
  (`null`, arrays, scalars) so a poisoned file falls back to the
  last-known-good cache (or `{}` cold) with the usual warning log instead of
  poisoning the in-memory caches.
- **Expired file download-throttle prune:** `incrementDownload` now drops
  expired throttle entries before writing, so the throttle map cannot grow
  without bound.
- **Targeted runtime security patches:** `next`, `sharp`, `undici` plus
  transitives updated in `package.json` / `package-lock.json` (no major
  version moves, no `--force`, no invented fix).
- **Dev brace-expansion / browserslist remediation:** dev-side dependency
  refresh for the brace-expansion chain (see residual risk below).

## Deadline contract (`PICTORIUM_RENDER_TIMEOUT_MS`)

The poster route watchdog answers the **original caller** with a bounded `503`
plus `Retry-After` once the configured remaining deadline
(`RENDER_TIMEOUT_MS` minus preflight time) elapses. Coalesced waiters never
duplicate the render and answer the same bounded `503` after their wait cap.
The late async job keeps slot / inflight / zombie-cleanup ownership until it
really settles, then answers `503` silently: it never caches poster bytes,
never reports a late `200`, and never double-counts or double-writes the `503`
(a single `503` accounting entry plus negative-cache write happens at the
deadline; post-deadline paths only answer). The zombie grace keeps its existing
accounting tradeoff (unchanged). `README.md` documents the variable; the code
in `src/app/api/poster/[type]/[id]/route.ts` is the source of truth.

### Honest limits of this guarantee

- The non-cooperative test injects a never-settling async `Promise` through
  the real route: it proves the caller-side race, watchdog, and accounting,
  not an actual Sharp hang, preemption, or OOM immunity.
- A permanent **synchronous** event-loop block cannot fire a JS deadline timer
  by definition; this fix covers async non-cooperation only.
- Background native work may continue after the timeout / grace; no worker or
  process isolation was introduced.

## Quota asymmetry and adjacent risks (explicitly NOT changed)

- The historical mapping/alias quota **asymmetry is preserved**: mapping
  writes do not count aliases, while a new alias field is gated on the
  combined mappings + aliases count (overwrites bypass the gate in both
  cases). No symmetric aggregate cap is claimed.
- Redis first-use race / read staleness adjacent to the quota paths was not
  fixed here. Not all risks are resolved; this record claims only the four
  races above.

## Dependency audit and accepted residual risk

- Full `npm audit`: 5 HIGH affected package nodes from one underlying advisory, all nodes of one underlying dev-only
  braces chain (`braces` → `micromatch` → `fast-glob` → `@next`
  plugin → `eslint-config-next`, GHSA-vfj7-8cjw-p6xm).
- Runtime `npm audit --omit=dev`: 0 vulnerabilities.
- The newest `braces` release available on the npm registry as of 2026-10-10
  (3.0.3) is still unpatched for this advisory, so no compatible patched
  version exists to adopt. No major Next/eslint-config downgrade (e.g. to the
  Next 14 lint line), no `--force`, and no invented fix were applied; the
  option is reconsidered when upstream ships a patch.
- Per the user's explicit "proceed and document" decision, the residual
  dev-tooling risk is **accepted**: constrain `lint` / `build` to trusted
  patterns, configs, and repositories. This record does **not** claim zero
  total vulnerabilities and does **not** claim an attack is impossible.

## Verification record (read carefully: historical vs current)

- **Historical (2026-10-10, BEFORE the D2 lockfile update and the H2 route
  change):** full unit suite, visual suite (100), and functional suite (18)
  passed. These totals are historical only and are **not** the current final
  gate — the tree changed afterwards (dependency lockfile + route), so the
  result expired by definition.
- **Actual narrow evidence for this batch:** the new H2 non-cooperative
  render tests (4 tests: original-caller 503, no late cache, no late 200 /
  no double 503, deadline + zombie accounting) passed, and the runtime
  poster-render suite (44 tests) passed.
- **Final current gate: PASSED 2026-10-10 on the current tree.** Code, lockfile,
  route, and this file's DOC1 terminology fix were all in place before the
  batch ran; only this gate-record section was written afterwards, which is
  doc-only and does not invalidate code/lock/render verification.
  - `node scripts/write-render-version.mjs` — regenerated via script only
    (exit 0).
  - `npm run verify` — tsc + eslint + full unit suite (421 files / 4757
    tests passed) + `next build` (52/52 static pages) — exit 0.
  - `npm run e2e:visual:clean` — fresh `.next-e2e` rebuild, 100/100 passed
    with snapshots UNCHANGED (no `--update-snapshots`) — exit 0.
  - `npx --no-install playwright test e2e/ --workers=1` — full serial suite
    (23 spec files): first run 212 passed / 1 failed on
    `badge-format-defaults.spec.ts:521` (30 s `nextPreview` predicate timeout
    under a loaded 6-minute run); isolated retry of that spec 6/6 passed;
    second full run **213/213 passed** — exit 0. No code or test change was
    made for the flake; no tests skipped, weakened, or re-snapshotted.
  - `npm audit --json` — 5 HIGH affected package nodes from the single
    dev-only `braces` advisory (GHSA-vfj7-8cjw-p6xm), nothing else;
    `npm audit --omit=dev --json` — 0 vulnerabilities.
- **Truthful remaining limits:** the one full-suite flake above shows the UI
  timing predicate can time out under load; it passed on retry and on the
  clean re-run with no code change. The accepted residual dev-only `braces`
  chain (no upstream patch) still stands. E2E ran against the deterministic
  mock server (no real keys); no Docker verification was performed.

Reproducible narrow commands (from the repository root):

```bash
npx vitest run src/__tests__/quota-concurrency.test.ts
npx vitest run src/__tests__/poster-render-noncooperative.test.ts
npx vitest run src/__tests__/store-shape-guard.test.ts
npm audit
npm audit --omit=dev
```

Canonical final gate (ran here 2026-10-10, all on the current tree):

```bash
npm run verify
npm run e2e:visual:clean
npx playwright test e2e/
```
