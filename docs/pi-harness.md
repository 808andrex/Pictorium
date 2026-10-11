# Pictorium Pi workflow

Pi is an optional coordinator/executor workflow, not a replacement for OpenCode.
Both reuse `AGENTS.md`, `.agents/*.md` and `.agents/skills/`. No global settings,
credentials, MCP services, application renderer or dependencies are changed.

## Start

Requires a Pi version with the extension APIs used here (developed against 1.1.0),
Node supported by that Pi installation, Git and Bash on PATH (Git Bash on Windows).
From the repository root:

```sh
pi --offline --no-mcp
```

Review/trust the project when asked. Project settings select
`openai/gpt-6.1-sol` as coordinator; the executor uses
`opencode-go/muse-spark-1.3-contributor`. The reviewer uses Sol. These IDs must
exist and have usable credentials in Pi. Use `/login` and `/model` to configure
providers; there is no silent fallback. Resuming an old session can restore its
old model: select Sol explicitly before using it as coordinator.

Commands:

- `/pictorium-work <task>`: inspect, plan, approve scope/commands, delegate, review.
- `/pictorium-audit <question>`: read-only analysis/reviewer, no command execution.
- `/pictorium-status`: independent scope and verification evidence.
- `/reload`: reload project resources after changes (or restart Pi).

Ordinary natural-language tasks work too. The templates only make intent explicit.
To run stock Pi without this workflow, use `--no-approve --no-extensions`;
project context files still load, as documented by Pi.

## Roles and controls

`.pi/extensions/pictorium.ts` supplies serial delegation and guards in BOTH parent
and child. Child processes load only this extension and no MCP servers; personal
extensions cannot accidentally expand the child's tool surface.

| Role | Model-facing tools |
|---|---|
| Coordinator | read, grep, find, ls, pictorium_delegate, pictorium_status |
| Worker | read, grep, find, ls, edit, write, pictorium_check |
| Reviewer | read, grep, find, ls |

A worker delegation requires interactive confirmation of the task, exact file
scope, skill names and exact commands. No UI means no worker dispatch. Additional
files or commands require a new approved delegation; nested/concurrent delegation
is blocked. The child has an independent context: include the goal, acceptance
criteria, necessary findings and constraints in the task. It reads the same repo
instructions and the named canonical skills; it does not inherit chat history.

Direct writes reject out-of-scope paths, symlink components and protected paths
(`.git`, `.env*`, `node_modules`, `.pi`, runtime `data`, generated outputs).
Include generated outputs in scope when needed, but write them only through an
approved generator command. The worker has no arbitrary shell tool: exact approved
commands run through `pictorium_check`, using Bash with a ten-minute cap. Commands
that mutate Git, install packages, deploy or update snapshots trip a deny check;
these operations belong outside this workflow and need separate authorization.
Shell shortcuts (`!`/`!!`) are disabled in harness sessions.

**This is NOT a sandbox.** Approved commands can execute scripts, access network,
read secrets, modify ignored/build/test files, or affect services. The command
tripwire is not a shell parser. Review commands before approval. Extensions and
child processes have the OS user's permissions; ambient credentials remain
accessible to approved processes. Read tools also retain OS-level access. Use OS
isolation and narrowly scoped credentials when a security boundary is needed.

No MCP configuration is copied from OpenCode/Claude. Parent tool calls to MCP,
codemode, shell and other non-allowlisted tools are blocked by the guard. To add
an integration later, review its permissions and explicitly change the workflow.

## Evidence, scope and verification

Before/after delegation, the harness hashes tracked and non-ignored untracked
files plus explicitly scoped ignored files, and records HEAD and dirty paths.
Git fsmonitor is disabled only for the snapshot commands, without changing Git
configuration, so newly created files are not hidden by a stale daemon cache.
The report detects changed paths outside scope, preexisting out-of-scope edits
changed during delegation, and HEAD changes. It does not roll back or overwrite
anything automatically. Unexpected changes make the delegation result an error.

Each approved check records command, actual exit code, timestamp, duration and
before/after content fingerprints. `current: true` means exit zero on a stable
state that still matches the current fingerprint; any subsequent change makes
that evidence non-current. A command that changes files while running is kept as
exit-code evidence but conservatively not reusable as current verification.

Reports include the actual command output tail. Output exceeding the tool limit
is saved in a private OS-temp log whose path is returned; inspect that log before
diagnosing a truncated failure. Logs/sessions may contain command output with
sensitive data: keep them private and review before sharing. Temp logs are not
repository files and are not automatically deleted by this workflow.

Reports persist in Pi's session entries, not repository files. Status restores
reports from the active branch only. A child's exit zero or claim in prose never
marks the final gate passed. The ledger does not infer which checks satisfy every
acceptance criterion: the coordinator must review commands and outcomes. Status
reports full/visual/parity pending unless explicitly supported by actual evidence.

Limits: ignored files outside explicit scope (including runtime data and build
artifacts), submodule internals and external services are not content-audited.
Changes from another terminal during delegation are indistinguishable from agent
changes. Do not concurrently edit the same working tree. Cancellation terminates
the child process group on POSIX / process tree on Windows; this is best-effort,
not cancellation of already-issued external operations. Interrupting commands
produces no passing verification record.

**Scheduling is defined only by `AGENTS.md` → Verification Strategy.** Narrow
checks during work; the full/relevant E2E/visual batch before push/integration,
not at intermediate commits or chat closure. The harness never starts that batch
by itself. URL/mapping/precedence changes also need URL unit tests and the parity
spec in the final batch. No automatic commit, push, deploy or learning-policy edit.

## Select skills and checks by affected area

Use multiple rows when a task crosses boundaries; do not classify exclusively.
Read actual consumers and existing tests before selecting commands.

| Area / risk | Existing guidance | Candidate narrow tests |
|---|---|---|
| Rendering / URL precedence | poster-sync, poster-visual, render-params.md | render-version-files, badge-cache-key, relevant URL tests |
| Deadlines / accounting | perf, testing | poster-render-deadline, poster-render-noncooperative, limiter/queue |
| Persistent quotas / uncertain writes | testing; store.ts, kv.ts | quota-concurrency, store-shape-guard, kv-command-timeout |
| Namespace / credentials | tmdb-api; user-auth.ts, user-keys.ts | user-keys, user-namespacing, multi-user-hardening |
| Catalog / metadata contracts | stremio-protocol, catalog.md | catalog/meta tests; relevant final catalog E2E |
| Provider failure vs genuine miss | metadata-sources, tmdb-api | justwatch-resilience, circuit-breaker, trending-deadline |
| Next.js / deployment | nextjs-docs, deploy | task-specific checks; final build per AGENTS.md |

This is a navigation aid, not a second source for runtime constants. Keep facts
in code and existing canonical docs. Review policy changes after demonstrated
errors; prefer regression tests and approved small instruction updates.

## Local harness checks

No provider calls or application build needed:

```sh
PI_PACKAGE_DIR=/path/to/installed/pi-package node --test .pi/tests/harness.check.mjs
PI_PACKAGE_DIR=/path/to/installed/pi-package node .pi/scripts/check-extension.mjs
pi --offline --approve --no-mcp --help
PI_OFFLINE=1 pi auth check --provider openai --no-refresh --json
PI_OFFLINE=1 pi auth check --provider opencode-go --no-refresh --json
```

Set `PI_PACKAGE_DIR` to the installed `@earendil-works/pi-coding-agent` package
folder (not the agent settings directory). Without it, extension tests are skipped;
core checks still run. On PowerShell set `$env:PI_PACKAGE_DIR` / `$env:PI_OFFLINE`
before the commands instead of using Bash's inline environment syntax.

The unit checks use temporary Git repositories, mocked extension APIs and a fake
CLI child process. They exercise scope, freshness, failure parsing, approval,
child invocation and tool guards, not the quality of Sol/Spark or live inference. File-symlink checks may be skipped on
Windows when the OS denies creating symlinks; junction checks still run. The help command checks extension
loading; auth checks do not prove a successful model inference. A real approved
pilot remains necessary before trusting this workflow for high-risk changes.

`.pi` is excluded from application TypeScript/lint; its checks are separate and
its Node test filename deliberately avoids Vitest's application test glob.
