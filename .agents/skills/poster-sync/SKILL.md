---
name: poster-sync
description: >
  Synchronize client/server visual render parameters in Pictorium. The poster is
  served by a single shared renderer (`/api/poster/{type}/{id}`): parameters
  that travel in the preview URL have a client counterpart (EditView, context,
  poster-url) and a server counterpart (route.ts, svg-badge.ts, badges.ts).
  When one side of such a pair changes, inspect the shared implementation and
  update only the affected consumers so the WYSIWYG preview stays aligned with
  the Stremio poster. Also handles RENDER_VERSION regeneration and the visual
  regression check. Trigger: "sync render params", "update badge style",
  "modifica parametro di resa", "change gradient/logo/blur/ranking", or any edit
  to a rendering file.
---

Pictorium renders ONE poster: the client preview is a single `<img src={previewUrl}>`
that loads `/api/poster/{type}/{id}` — the same endpoint Stremio uses. There is no
separate client renderer. "Client" here means the URL params the client builds
(`src/lib/context.tsx`, `src/lib/poster-url.ts`); "server" means what the route reads
(`src/app/api/poster/[type]/[id]/route.ts`) and how SVG badges are drawn
(`src/lib/svg-badge.ts`, `src/lib/badge-svg-shared.ts`, `src/lib/logo-layout.ts`).

## When this skill triggers

When you modify any visual rendering parameter: badge geometry/colors/styles,
ranking/extra badges, bottom gradient, blur, logo size/position, font sizes,
paddings/gaps, accent color extraction, ribbon side, overflow protection formulas.

## Sync checklist (do ALL of these)

1. **Locate the server counterpart.** Grep the parameter name across `src/lib/*.ts`
   and `src/app/api/poster/[type]/[id]/route.ts`. Server-side-only constants in
   the shared renderer may have no client-side usage or query param — inspect
   the shared implementation and the client URL/server consumers, and update
   only the affected consumers. The canonical param map lives in
   `.agents/render-params.md` (URL query params + badge geometry tables).
   When descriptive docs and code disagree on current behavior, CODE WINS —
   update `.agents/render-params.md`. It never overrides user requirements,
   public contracts, or security policies.

2. **Shared geometry lives in shared modules.** If the change is geometry (logo box,
   badge dims, text flow), the function likely already exists in `src/lib/logo-layout.ts`
   or `src/lib/badge-svg-shared.ts` and is used by BOTH sides. Change it once there,
   never fork the formula. Check `computeLogoBox`, `buildGenreTextFlow`,
   `genreBadgeDims`, `estimateTextWidth`.

3. **Regenerate RENDER_VERSION** — never hand-edit `src/lib/render-version.ts`
   (it is auto-generated). Run:
   ```
   node scripts/write-render-version.mjs
   ```
   It hashes the render files listed in `scripts/write-render-version.mjs`
   (`RENDER_FILES`). If your file is not in that list and it affects visual output,
   add it, then regenerate. The `predev`/`prebuild`/`pretest` scripts already do
   this automatically — the manual run is for immediate verification.

4. **Keep generated values out of documentation.** Read the generated files;
   never copy `rv` or app-version values into `AGENTS.md` or skill files.

5. **Run the visual regression suite at the final batch before push/integration**
   according to `AGENTS.md` → Verification Strategy:
   ```
   npx playwright test e2e/pictorium-visual.spec.ts
   ```
   No external dependencies: `playwright.config.ts` starts `e2e/mock-server.mjs`
   automatically (dedicated port + `.next-e2e` distDir), so it works even with
   `npm run dev` running.

6. **Intentional appearance change?** Update snapshots deliberately:
   ```
   npx playwright test e2e/pictorium-visual.spec.ts --update-snapshots
   ```
   Review the `.png` diffs before committing them.

## Query params quick reference

The canonical client → server query param map lives in
[`.agents/render-params.md`](../../render-params.md) (section "Parametri URL
(query string)"). Consult it whenever a param pair changes. Do NOT duplicate the
table here — update the canonical file instead.

Dead params: `gradColor`, `gradOpacity`, `gradFade`, `gradDir` are not read by the
server anymore. Do not reintroduce them.

## Hard rules

- Never edit `src/lib/render-version.ts` by hand.
- Never duplicate a shared geometry formula in client and server.
- Never change one side of a param pair without checking the other; server-only
  shared-renderer changes need no mirrored client edit.
- After any render-affecting change, the final visual pass is required before
  push/integration. Scheduling is defined by `AGENTS.md Verification Strategy`;
  visual during work is only for requested diagnosis or demonstrated need.
- For URL/mapping/precedence changes, include the relevant URL unit tests and
  `e2e/pictorium-parity.spec.ts` in the final batch. No duplicated renderer.
