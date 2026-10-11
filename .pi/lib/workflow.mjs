import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)
const hash = (value) => createHash("sha256").update(value).digest("hex")

export function normalizeScope(files) {
  if (!Array.isArray(files)) throw new Error("Scope must be an array of exact repository-relative files")
  return [...new Set(files.map((file) => {
    if (typeof file !== "string") throw new Error("Scope paths must be strings")
    const normalized = file.replaceAll("\\", "/")
    // Brackets are valid literal Next.js path segments; no glob expansion.
    if (!normalized || path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)
      || normalized.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))
      || /[*?{}:\x00-\x1f]/.test(normalized)) throw new Error(`Invalid exact scope path: ${file}`)
    return normalized
  }))]
}

export function protectedFile(file) {
  file = file.toLowerCase()
  return file.split("/").some((part) => part === ".git" || part === "node_modules" || part === ".pi"
    || part === "data" || part.startsWith(".env"))
    || file.startsWith("src/generated/") || file === "src/lib/render-version.ts"
}

export async function writablePath(root, file, scope) {
  const absolute = path.resolve(root, file)
  const relative = path.relative(root, absolute).replaceAll("\\", "/")
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)
    || protectedFile(relative) || !scope.includes(relative)) return false
  // Reject symlinks at every existing component, including the final file.
  let current = root
  for (const part of relative.split("/")) {
    current = path.join(current, part)
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) return false
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }
  return true
}

export async function snapshot(root, extraFiles = []) {
  const options = { cwd: root, maxBuffer: 32 * 1024 * 1024 }
  const [{ stdout: head }, { stdout: listed }, { stdout: status }] = await Promise.all([
    exec("git", ["-c", "core.fsmonitor=false", "rev-parse", "HEAD"], options),
    exec("git", ["-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], options),
    exec("git", ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z"], options),
  ])
  const files = {}
  for (const file of [...new Set([...listed.split("\0").filter(Boolean), ...extraFiles])].sort()) {
    try {
      const stat = await fs.lstat(path.join(root, file))
      if (stat.isDirectory()) continue
      const content = stat.isSymbolicLink() ? await fs.readlink(path.join(root, file)) : await fs.readFile(path.join(root, file))
      files[file] = hash(content) + (stat.mode & 0o111 ? ":executable" : "")
    } catch (error) {
      if (error.code !== "ENOENT") throw error
      files[file] = "missing"
    }
  }
  const dirty = []
  const entries = status.split("\0")
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry) continue
    dirty.push(entry.slice(3))
    if (/^[RC]|^.[RC]/.test(entry)) dirty.push(entries[++i])
  }
  return { head: head.trim(), files, dirty, fingerprint: hash(JSON.stringify([head.trim(), files])) }
}

export function compareSnapshots(before, after, scope) {
  const changed = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter((file) => before.files[file] !== after.files[file])
  return {
    changed,
    outsideScope: changed.filter((file) => !scope.includes(file)),
    preexistingChanged: before.dirty.filter((file) => !scope.includes(file) && before.files[file] !== after.files[file]),
    headChanged: before.head !== after.head,
  }
}

export function verificationStatus(records, fingerprint) {
  return records.map((record) => ({ ...record,
    current: record.exitCode === 0 && record.before === record.after && record.after === fingerprint,
  }))
}

export function forbiddenCommand(command) {
  // A safety tripwire, NOT a shell parser or a sandbox. All commands also
  // require exact allowlisting and human approval before dispatch.
  return /\bgit\s+(?:[^\s]+\s+)*(?:push|commit|reset|clean|checkout|restore|tag)\b/i.test(command)
    || /--update-snapshots\b|\b(?:sudo|deploy)\b|\bnpm\s+(?:install|update|uninstall|publish|audit\s+fix)\b/i.test(command)
}

export function parseChildEvents(lines) {
  let output = ""
  let failed = false
  let error = ""
  const checks = []
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  for (const line of lines) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message
      const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
      if (text) output = text
      if (["error", "aborted"].includes(message.stopReason)) {
        failed = true
        error = message.errorMessage || message.stopReason
      }
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) usage[key] += message.usage?.[key] || 0
      for (const key of Object.keys(usage.cost)) usage.cost[key] += message.usage?.cost?.[key] || 0
    }
    if (event.type === "tool_execution_end" && event.toolName === "pictorium_check" && event.result?.details?.verification) {
      checks.push(event.result.details.verification)
    }
  }
  return { output, failed, error, checks, usage }
}
