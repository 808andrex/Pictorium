import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import {
  normalizeScope, protectedFile, writablePath, snapshot, compareSnapshots,
  verificationStatus, forbiddenCommand, parseChildEvents,
} from "../lib/workflow.mjs"

const READ_TOOLS = ["read", "grep", "find", "ls"]
const MODEL = { worker: "opencode-go/muse-spark-1.3-contributor", reviewer: "openai/gpt-6.1-sol" }
const textResult = (text: string, details: unknown = undefined, isError = false) => ({
  content: [{ type: "text" as const, text }], details, isError,
})

export default function pictorium(pi: ExtensionAPI) {
  // Only the launcher supplies this contract. This is workflow enforcement,
  // not a security boundary against hostile code/extensions in this process.
  const contract = process.env.PICTORIUM_PI_CONTRACT ? JSON.parse(process.env.PICTORIUM_PI_CONTRACT) : null
  let busy = false
  let lastReport: any = null
  let baseline: any = null
  const checks: any[] = []
  const role = contract?.role || "coordinator"
  const active = role === "worker" ? [...READ_TOOLS, "edit", "write", "pictorium_check"]
    : role === "reviewer" ? READ_TOOLS : [...READ_TOOLS, "pictorium_delegate", "pictorium_status"]

  pi.on("session_start", async (_event, ctx) => {
    pi.setActiveTools(active)
    if (!contract) {
      // Restore reports only from the active branch, not abandoned histories.
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "custom" && entry.customType === "pictorium-report") lastReport = entry.data
      }
      baseline = await snapshot(ctx.cwd)
    }
  })

  pi.on("tool_call", async (event, ctx) => {
    if (!active.includes(event.toolName)) return { block: true, reason: `${role}: tool not permitted` }
    if (event.toolName === "edit" || event.toolName === "write") {
      if (!contract || path.resolve(ctx.cwd) !== path.resolve(contract.root)
        || !await writablePath(ctx.cwd, String(event.input.path || ""), contract.scope)) {
        return { block: true, reason: "Protected path or outside approved exact scope; request a new delegation" }
      }
    }
  })
  pi.on("user_bash", async () => ({
    result: { output: "Shell shortcuts are disabled in this harness. Use a separate terminal deliberately.", exitCode: 1, cancelled: false, truncated: false },
  }))

  pi.registerTool({
    name: "pictorium_check", label: "Approved check",
    description: "Run an EXACT human-approved verification/generator command and record its exit code and code fingerprint. Worker only.",
    parameters: Type.Object({ command: Type.String() }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (role !== "worker" || !contract.commands.includes(params.command) || forbiddenCommand(params.command)) {
        return textResult("Command not approved; request a new delegation", undefined, true)
      }
      if (busy) return textResult("Another check is running; run serially", undefined, true)
      busy = true
      try {
        const before = await snapshot(ctx.cwd, contract.scope)
        const start = Date.now()
        const result = await pi.exec("bash", ["-lc", params.command], { cwd: ctx.cwd, signal, timeout: 600_000 })
        const after = await snapshot(ctx.cwd, contract.scope)
        const output = result.stdout + "\n" + result.stderr
        let logPath: string | undefined
        if (output.length > 20_000) {
          const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "pictorium-check-"))
          logPath = path.join(logDir, "output.log")
          await fs.writeFile(logPath, output, { mode: 0o600 })
        }
        const interrupted = Boolean(result.killed || signal?.aborted)
        const exitCode = interrupted ? 1 : result.code
        const verification = { command: params.command, exitCode, interrupted,
          before: before.fingerprint, after: after.fingerprint, durationMs: Date.now() - start,
          timestamp: new Date().toISOString(), outputTail: output.slice(-8000), logPath }
        checks.push(verification)
        return textResult(`Exit ${exitCode}\n${output.slice(-20_000)}${logPath ? `\nOutput truncated; full log: ${logPath}` : ""}`,
          { verification }, exitCode !== 0)
      } finally { busy = false }
    },
  })

  pi.registerTool({
    name: "pictorium_delegate", label: "Pictorium delegation",
    description: "Delegate serially to worker (Spark) or read-only reviewer (Sol). Supply objective, exact files, skills and commands; worker requires human confirmation. No automatic full gate.",
    parameters: Type.Object({
      agent: Type.Union([Type.Literal("worker"), Type.Literal("reviewer")]),
      task: Type.String({ minLength: 1 }),
      scope: Type.Array(Type.String()),
      skills: Type.Array(Type.String()),
      commands: Type.Array(Type.String()),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (role !== "coordinator" || busy) return textResult("Nested/concurrent delegation is not allowed", undefined, true)
      busy = true
      try {
        if (!ctx.isProjectTrusted()) return textResult("Trust this project before delegation", undefined, true)
        const scope = normalizeScope(params.scope)
        if (params.agent === "worker" && !scope.length) throw new Error("Worker requires an explicit file scope")
        if (params.agent === "reviewer" && params.commands.length) throw new Error("Reviewer cannot execute commands")
        for (const name of params.skills) {
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`Invalid skill: ${name}`)
          await fs.access(path.join(ctx.cwd, ".agents", "skills", name, "SKILL.md"))
        }
        if (params.commands.some(forbiddenCommand)) throw new Error("Git mutations, installs, deploys and snapshot updates are outside this workflow")
        const model = MODEL[params.agent]
        if (!ctx.modelRegistry.getAvailable().some((item) => `${item.provider}/${item.id}` === model)) {
          throw new Error(`Model unavailable/authentication missing: ${model}. Configure it with /login; no silent fallback.`)
        }
        if (params.agent === "worker") {
          if (!ctx.hasUI) throw new Error("Worker dispatch requires interactive approval; headless mode fails closed")
          const protectedScope = scope.filter(protectedFile)
          const approved = await ctx.ui.confirm("Approve executor scope and commands?",
            `Task: ${params.task}\nFiles: ${scope.join(", ")}\nSkills: ${params.skills.join(", ")}\nCommands: ${params.commands.join("\n") || "none"}\n`
            + (protectedScope.length ? `Protected outputs (generators only): ${protectedScope.join(", ")}\n` : "")
            + "Commands may write generated/build/test files. This is not a sandbox; no commit/push/deploy is authorized.")
          if (!approved) return textResult("Delegation cancelled")
        }
        const before = await snapshot(ctx.cwd, scope)
        const prompt = await fs.readFile(path.join(ctx.cwd, ".pi", "agents", `${params.agent}.md`), "utf8")
        const childContract = { role: params.agent, root: ctx.cwd, scope, commands: params.commands }
        const args = ["--offline", "--mode", "json", "--print", "--no-session", "--approve",
          "--no-mcp", "--no-extensions", "-e", path.join(ctx.cwd, ".pi", "extensions", "pictorium.ts"),
          "--model", model, "--tools", (params.agent === "worker" ? [...READ_TOOLS, "edit", "write", "pictorium_check"] : READ_TOOLS).join(","),
          "--append-system-prompt", `${prompt}\nDelegation contract:\n${JSON.stringify({ ...childContract, skills: params.skills })}`,
          "--", params.task]
        // Same invocation strategy as Pi's official subagent example: reuse
        // the current CLI, including standalone binaries, without shell:true.
        const script = process.argv[1]
        const useScript = script && !script.startsWith("/$bunfs/") && await fs.access(script).then(() => true, () => false)
        const genericRuntime = /^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath))
        const command = useScript || !genericRuntime ? process.execPath : "pi"
        const childArgs = useScript ? [script, ...args] : args
        const lines: string[] = []
        let stderr = ""
        let buffer = ""
        let overflow = false
        let outputBytes = 0
        const exitCode = await new Promise<number>((resolve, reject) => {
          if (signal?.aborted) return reject(new Error("Delegation aborted before launch"))
          const child = spawn(command, childArgs, { cwd: ctx.cwd, shell: false,
            detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, PICTORIUM_PI_CONTRACT: JSON.stringify(childContract) } })
          let killTimer: ReturnType<typeof setTimeout> | undefined
          const abort = () => {
            if (process.platform === "win32") {
              if (child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => child.kill())
            } else if (child.pid) {
              try { process.kill(-child.pid, "SIGTERM") } catch { /* already exited */ }
              killTimer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL") } catch { /* already exited */ } }, 5000)
              killTimer.unref()
            }
          }
          signal?.addEventListener("abort", abort, { once: true })
          child.stdout.on("data", (chunk) => {
            outputBytes += chunk.length
            if (outputBytes > 8 * 1024 * 1024) { overflow = true; abort(); return }
            buffer += chunk.toString()
            const complete = buffer.split("\n")
            buffer = complete.pop() || ""
            for (const line of complete) {
              lines.push(line)
              try {
                const event = JSON.parse(line)
                if (event.type === "tool_execution_start") onUpdate?.(textResult(`${params.agent}: ${event.toolName}`))
              } catch { /* startup diagnostics are not protocol events */ }
            }
          })
          child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-20_000) })
          const cleanup = () => {
            signal?.removeEventListener("abort", abort)
            if (killTimer) {
              clearTimeout(killTimer)
              // The CLI may exit before a stubborn descendant; finish killing
              // the owned group rather than cancelling escalation on close.
              if (child.pid) try { process.kill(-child.pid, "SIGKILL") } catch { /* already exited */ }
            }
          }
          child.on("error", (error) => { cleanup(); reject(error) })
          child.on("close", (code) => { cleanup(); if (buffer.trim()) lines.push(buffer); resolve(code ?? 1) })
        })
        const child = parseChildEvents(lines)
        const after = await snapshot(ctx.cwd, scope)
        const diff = compareSnapshots(before, after, params.agent === "reviewer" ? [] : scope)
        const report = { agent: params.agent, model, exitCode, timestamp: new Date().toISOString(),
          fingerprint: after.fingerprint, scope, ...diff, checks: verificationStatus(child.checks, after.fingerprint),
          fullGate: "pending unless separately evidenced by recorded commands", output: child.output,
          error: overflow ? "Child output exceeded 8 MiB; process terminated" : child.error,
          failed: child.failed || overflow, aborted: Boolean(signal?.aborted) }
        lastReport = report
        pi.appendEntry("pictorium-report", report)
        const failed = exitCode !== 0 || report.failed || report.aborted || !child.output
          || diff.outsideScope.length > 0 || diff.headChanged
        return { ...textResult(`${child.output || child.error || stderr || "No final output"}\n\nIndependent report:\n${JSON.stringify(report, null, 2)}`,
          report, failed), usage: child.usage }
      } finally { busy = false }
    },
  })

  const status = async (ctx: any) => {
    const current = await snapshot(ctx.cwd, lastReport?.scope || [])
    return { role, baseline: baseline ? compareSnapshots(baseline, current, []) : null,
      lastReport: lastReport ? { ...lastReport, checks: verificationStatus(lastReport.checks, current.fingerprint),
        currentStateMatchesReport: lastReport.fingerprint === current.fingerprint } : null,
      localChecks: verificationStatus(checks, current.fingerprint),
      note: "Exit 0 is command evidence, not a declaration that every required gate ran. No automatic full/E2E/visual gate." }
  }
  pi.registerTool({ name: "pictorium_status", label: "Pictorium status",
    description: "Inspect baseline, scope deviations and verification freshness without running tests.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) { const result = await status(ctx); return textResult(JSON.stringify(result, null, 2), result) },
  })
  pi.registerCommand("pictorium-status", { description: "Show scope/verification evidence",
    handler: async (_args, ctx) => { const result = await status(ctx); pi.sendMessage({ customType: "pictorium-status", content: JSON.stringify(result, null, 2), display: true }) },
  })
}
