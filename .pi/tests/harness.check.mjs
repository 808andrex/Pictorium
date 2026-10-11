import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { normalizeScope, protectedFile, writablePath, snapshot, compareSnapshots,
  verificationStatus, forbiddenCommand, parseChildEvents } from "../lib/workflow.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const require = createRequire(import.meta.url)

async function repo(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pictorium-harness-test-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" })
  git("init")
  git("config", "user.email", "test@example.invalid")
  git("config", "user.name", "Harness test")
  await fs.writeFile(path.join(dir, "a.txt"), "original")
  await fs.writeFile(path.join(dir, "b.txt"), "preserve")
  await fs.writeFile(path.join(dir, ".gitignore"), "ignored.txt\n")
  git("add", ".")
  git("commit", "-m", "test baseline")
  return dir
}

test("exact scope handles Next.js brackets and Windows separators, rejects escapes/globs", () => {
  assert.deepEqual(normalizeScope(["src\\app\\[id]\\route.ts", "src/app/[id]/route.ts"]), ["src/app/[id]/route.ts"])
  for (const file of ["", "../a", "/a", "C:\\a", "a/../b", "a//b", "a/*", "a?", "./a", "a:stream", "a. ", "a/part.", "a\nfile"]) {
    assert.throws(() => normalizeScope([file]))
  }
})

test("protected/generated paths cannot be edited directly, even in approved scope", async (t) => {
  const dir = await repo(t)
  for (const file of [".git/config", ".GIT/config", ".ENV.local", ".env.local", "node_modules/x", ".pi/settings.json", "data/users/x", "src/generated/x.ts", "src/lib/render-version.ts"]) {
    assert.equal(protectedFile(file), true)
    assert.equal(await writablePath(dir, file, [file]), false)
  }
  assert.equal(await writablePath(dir, "a.txt", ["a.txt"]), true)
  assert.equal(await writablePath(dir, "new/sub.txt", ["new/sub.txt"]), true)
  assert.equal(await writablePath(dir, "b.txt", ["a.txt"]), false)
  assert.equal(await writablePath(dir, "../escape", ["../escape"]), false)
})

test("symlink directory components are not writable", async (t) => {
  const dir = await repo(t)
  await fs.mkdir(path.join(dir, "real"))
  try { await fs.symlink(path.join(dir, "real"), path.join(dir, "link"), "junction") }
  catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) return t.skip("OS denies junction creation")
    throw error
  }
  assert.equal(await writablePath(dir, "link/new.txt", ["link/new.txt"]), false)
})

test("symlink files are not writable", async (t) => {
  const dir = await repo(t)
  try { await fs.symlink(path.join(dir, "a.txt"), path.join(dir, "alias.txt")) }
  catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) return t.skip("OS denies file symlink creation")
    throw error
  }
  assert.equal(await writablePath(dir, "alias.txt", ["alias.txt"]), false)
})

test("snapshots detect content, new files, ignored scoped files and preexisting changes", async (t) => {
  const dir = await repo(t)
  await fs.writeFile(path.join(dir, "b.txt"), "user work")
  await fs.writeFile(path.join(dir, "ignored.txt"), "ignored baseline")
  const before = await snapshot(dir, ["ignored.txt"])
  await fs.writeFile(path.join(dir, "a.txt"), "agent work")
  await fs.writeFile(path.join(dir, "b.txt"), "oops")
  await fs.writeFile(path.join(dir, "new.txt"), "new")
  await fs.writeFile(path.join(dir, "ignored.txt"), "changed")
  const after = await snapshot(dir, ["ignored.txt"])
  const diff = compareSnapshots(before, after, ["a.txt", "ignored.txt"])
  assert.deepEqual(diff.outsideScope.sort(), ["b.txt", "new.txt"])
  assert.deepEqual(diff.preexistingChanged, ["b.txt"])
  assert.equal(diff.headChanged, false)
  assert.notEqual(before.fingerprint, after.fingerprint)
  assert.ok(diff.changed.includes("ignored.txt"))
})

test("snapshot bypasses an enabled fsmonitor without changing repository configuration", async (t) => {
  const dir = await repo(t)
  execFileSync('git', ['config', 'core.fsmonitor', 'true'], { cwd: dir })
  await fs.writeFile(path.join(dir, 'fresh.txt'), 'new file')
  const state = await snapshot(dir)
  assert.ok(state.files['fresh.txt'])
  assert.ok(state.dirty.includes('fresh.txt'))
  assert.equal(execFileSync('git', ['config', '--get', 'core.fsmonitor'], { cwd: dir, encoding: 'utf8' }).trim(), 'true')
})

test("failed, stale and mutating commands never become current verification", () => {
  const records = [
    { command: "pass", exitCode: 0, before: "a", after: "a" },
    { command: "fail", exitCode: 1, before: "a", after: "a" },
    { command: "mutating", exitCode: 0, before: "b", after: "a" },
  ]
  assert.deepEqual(verificationStatus(records, "a").map((r) => r.current), [true, false, false])
  assert.deepEqual(verificationStatus(records, "new").map((r) => r.current), [false, false, false])
})

test("command tripwires block git mutation/install/snapshot updates, allow narrow checks", () => {
  for (const command of ["git push", "git -C . commit -m x", "git reset --hard", "npm install x", "npm audit fix", "npx playwright test --update-snapshots", "sudo bash", "npm run deploy"]) assert.equal(forbiddenCommand(command), true, command)
  for (const command of ["git diff --check", "npx vitest run src/__tests__/cache.test.ts", "npm run typecheck", "node scripts/write-render-version.mjs"]) assert.equal(forbiddenCommand(command), false, command)
})

test("JSON events retain error despite later text, collect actual check evidence and usage", () => {
  const result = parseChildEvents([
    "startup noise",
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed", usage: { input: 10, cost: { total: 0.1 } } } }),
    JSON.stringify({ type: "tool_execution_end", toolName: "pictorium_check", result: { details: { verification: { command: "test", exitCode: 1 } } } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { output: 5 } } }),
  ])
  assert.equal(result.failed, true)
  assert.equal(result.error, "provider failed")
  assert.equal(result.output, "done")
  assert.equal(result.checks[0].exitCode, 1)
  assert.equal(result.usage.input, 10)
  assert.equal(result.usage.output, 5)
  assert.equal(result.usage.cost.total, 0.1)
})

// Pi resolves its own dependencies for extensions. Test with the local Pi
// package path without installing it into the application or copying secrets.
const piPackage = process.env.PI_PACKAGE_DIR
if (piPackage) {
  const { createJiti } = require("jiti")
  const piRequire = createRequire(path.join(piPackage, "package.json"))
  const jiti = createJiti(import.meta.url, { alias: { typebox: piRequire.resolve("typebox") }, moduleCache: false })
  const { default: extension } = await jiti.import(path.join(root, ".pi/extensions/pictorium.ts"))
  function setup(contract) {
    const original = process.env.PICTORIUM_PI_CONTRACT
    if (contract) process.env.PICTORIUM_PI_CONTRACT = JSON.stringify(contract)
    else delete process.env.PICTORIUM_PI_CONTRACT
    const tools = {}, handlers = {}
    const api = { registerTool: (tool) => { tools[tool.name] = tool },
      registerCommand: () => {}, on: (name, handler) => { handlers[name] = handler },
      setActiveTools: () => {}, appendEntry: () => {}, sendMessage: () => {},
      exec: async () => ({ code: 1, stdout: "failed assertion", stderr: "" }) }
    extension(api)
    if (original === undefined) delete process.env.PICTORIUM_PI_CONTRACT
    else process.env.PICTORIUM_PI_CONTRACT = original
    return { tools, handlers, api }
  }
  const ctx = (cwd) => ({ cwd, hasUI: true, isProjectTrusted: () => true,
    modelRegistry: { getAvailable: () => [{ provider: "opencode-go", id: "muse-spark-1.3-contributor" }] },
    ui: { confirm: async () => false } })
  const task = { agent: "worker", task: "Scoped task", scope: ["a.txt"], skills: [], commands: [] }

  test("coordinator blocks write, shell, MCP and codemode irrespective of tool activation", async (t) => {
    const dir = await repo(t)
    const { handlers } = setup()
    for (const toolName of ["edit", "write", "bash", "powershell", "mcp__redis__set", "codemode", "pictorium_check"]) {
      assert.equal((await handlers.tool_call({ toolName, input: {} }, ctx(dir))).block, true)
    }
    assert.equal(await handlers.tool_call({ toolName: "read", input: {} }, ctx(dir)), undefined)
    assert.equal((await handlers.user_bash()).result.exitCode, 1)
  })

  test("session startup restores only active-branch reports and records the preexisting baseline", async (t) => {
    const dir = await repo(t)
    await fs.writeFile(path.join(dir, 'b.txt'), 'preexisting work')
    const { tools, handlers, api } = setup()
    let active
    api.setActiveTools = (tools) => { active = tools }
    const context = { ...ctx(dir), sessionManager: { getBranch: () => [
      { type: 'custom', customType: 'unrelated', data: { ignored: true } },
      { type: 'custom', customType: 'pictorium-report', data: { scope: [], checks: [], fingerprint: 'old-state', agent: 'worker' } },
    ] } }
    await handlers.session_start({}, context)
    assert.deepEqual(active, ['read', 'grep', 'find', 'ls', 'pictorium_delegate', 'pictorium_status'])
    await fs.writeFile(path.join(dir, 'b.txt'), 'changed elsewhere')
    const status = await tools.pictorium_status.execute('id', {}, undefined, undefined, context)
    assert.deepEqual(status.details.baseline.preexistingChanged, ['b.txt'])
    assert.equal(status.details.lastReport.agent, 'worker')
    assert.equal(status.details.lastReport.currentStateMatchesReport, false)
  })

  test("worker dispatch fails closed without UI, missing model, or denied approval", async (t) => {
    const dir = await repo(t)
    const { tools } = setup()
    const execute = (context) => tools.pictorium_delegate.execute("id", task, undefined, undefined, context)
    await assert.rejects(execute({ ...ctx(dir), hasUI: false }), /interactive approval/)
    await assert.rejects(execute({ ...ctx(dir), modelRegistry: { getAvailable: () => [] } }), /Model unavailable/)
    assert.match((await execute(ctx(dir))).content[0].text, /cancelled/)
    assert.match((await execute({ ...ctx(dir), isProjectTrusted: () => false })).content[0].text, /Trust/)
  })

  test("worker guards apply in child and approved failed checks record non-passing evidence", async (t) => {
    const dir = await repo(t)
    const { tools, handlers } = setup({ role: "worker", root: dir, scope: ["a.txt"], commands: ["test command"] })
    assert.equal(await handlers.tool_call({ toolName: "edit", input: { path: "a.txt" } }, ctx(dir)), undefined)
    assert.equal((await handlers.tool_call({ toolName: "edit", input: { path: "b.txt" } }, ctx(dir))).block, true)
    assert.equal((await handlers.tool_call({ toolName: "pictorium_delegate", input: {} }, ctx(dir))).block, true)
    const denied = await tools.pictorium_check.execute("id", { command: "other" }, undefined, undefined, ctx(dir))
    assert.equal(denied.isError, true)
    const failed = await tools.pictorium_check.execute("id", { command: "test command" }, undefined, undefined, ctx(dir))
    assert.equal(failed.isError, true)
    assert.equal(failed.details.verification.exitCode, 1)
    assert.equal(verificationStatus([failed.details.verification], failed.details.verification.after)[0].current, false)
  })

  test("interrupted checks cannot pass and long failures retain a full private log", async (t) => {
    const dir = await repo(t)
    const { tools, api } = setup({ role: 'worker', root: dir, scope: ['a.txt'], commands: ['check'] })
    api.exec = async () => ({ code: 0, killed: true, stdout: 'partial', stderr: '' })
    const interrupted = await tools.pictorium_check.execute('id', { command: 'check' }, undefined, undefined, ctx(dir))
    assert.equal(interrupted.isError, true)
    assert.equal(interrupted.details.verification.exitCode, 1)
    assert.equal(interrupted.details.verification.interrupted, true)
    api.exec = async () => ({ code: 1, killed: false, stdout: 'x'.repeat(25_000), stderr: 'full error' })
    const failed = await tools.pictorium_check.execute('id', { command: 'check' }, undefined, undefined, ctx(dir))
    const log = failed.details.verification.logPath
    t.after(() => fs.rm(path.dirname(log), { recursive: true, force: true }))
    assert.match(await fs.readFile(log, 'utf8'), /full error$/)
    assert.match(failed.content[0].text, /Output truncated; full log/)
    assert.equal(failed.isError, true)
  })

  test("serial delegation launches child with inherited guards, records evidence and detects scope violations", async (t) => {
    const dir = await repo(t)
    await fs.mkdir(path.join(dir, ".pi/agents"), { recursive: true })
    await fs.copyFile(path.join(root, ".pi/agents/worker.md"), path.join(dir, ".pi/agents/worker.md"))
    const fixture = path.join(dir, "fake-pi.mjs")
    await fs.writeFile(fixture, `
      import fs from 'node:fs/promises';
      import assert from 'node:assert/strict';
      const args = process.argv.slice(2);
      assert.ok(args.includes('--no-mcp') && args.includes('--no-extensions') && args.includes('-e'));
      const c = JSON.parse(process.env.PICTORIUM_PI_CONTRACT);
      assert.equal(c.role, 'worker');
      const task = args.at(-1);
      if (task === 'hang') {
        console.log(JSON.stringify({ type: 'tool_execution_start', toolName: 'fixture-hang' }));
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      }
      await fs.writeFile(task === 'escape' ? 'b.txt' : 'a.txt', 'fixture work');
      console.log(JSON.stringify({ type: 'tool_execution_end', toolName: 'pictorium_check', result: { details: { verification: { command: 'fixture test', exitCode: 1, before: 'x', after: 'x' } } } }));
      console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'fixture completed' }], stopReason: 'stop', usage: { input: 3, output: 2, cost: { total: 0.01 } } } }));
    `)
    const saved = process.argv[1]
    process.argv[1] = fixture
    t.after(() => { process.argv[1] = saved })
    const { tools, api } = setup()
    const reports = []
    api.appendEntry = (_name, report) => reports.push(report)
    const approved = { ...ctx(dir), ui: { confirm: async () => true } }
    const result = await tools.pictorium_delegate.execute('id', { ...task, task: 'success' }, undefined, undefined, approved)
    assert.equal(result.isError, false)
    assert.deepEqual(result.details.changed, ['a.txt'])
    assert.equal(result.details.checks[0].current, false)
    assert.equal(result.usage.input, 3)
    assert.equal(reports.length, 1)
    const escaped = await tools.pictorium_delegate.execute('id', { ...task, task: 'escape' }, undefined, undefined, approved)
    assert.equal(escaped.isError, true)
    assert.deepEqual(escaped.details.outsideScope, ['b.txt'])
    const status = await tools.pictorium_status.execute('id', {}, undefined, undefined, approved)
    assert.equal(status.details.lastReport.currentStateMatchesReport, true)
    await fs.writeFile(path.join(dir, 'a.txt'), 'later edit')
    const stale = await tools.pictorium_status.execute('id', {}, undefined, undefined, approved)
    assert.equal(stale.details.lastReport.currentStateMatchesReport, false)
    const abort = new AbortController()
    const hung = await tools.pictorium_delegate.execute('id', { ...task, task: 'hang' }, abort.signal, () => abort.abort(), approved)
    assert.equal(hung.isError, true)
    assert.equal(hung.details.aborted, true)
  })

  test("reviewer cannot write, check, or delegate", async (t) => {
    const dir = await repo(t)
    const { handlers } = setup({ role: "reviewer", root: dir, scope: [], commands: [] })
    for (const toolName of ["write", "edit", "bash", "pictorium_check", "pictorium_delegate"]) {
      assert.equal((await handlers.tool_call({ toolName, input: {} }, ctx(dir))).block, true)
    }
  })
} else {
  test("extension guard checks require PI_PACKAGE_DIR", (t) => t.skip("Set PI_PACKAGE_DIR to the installed Pi package directory"))
}
