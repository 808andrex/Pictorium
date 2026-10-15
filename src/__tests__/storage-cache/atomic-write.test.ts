import { describe, expect, it, afterEach } from "vitest"
import { promises as fsp } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { atomicWriteFile } from "@/lib/atomic-write"

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true })
})

async function freshDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "pictorium-atomic-"))
  dirs.push(d)
  return d
}

describe("atomicWriteFile", () => {
  it("scrive il contenuto e non lascia .tmp residui", async () => {
    const dir = await freshDir()
    const file = path.join(dir, "data.json")
    await atomicWriteFile(file, JSON.stringify({ a: 1 }))
    expect(await fsp.readFile(file, "utf-8")).toBe(JSON.stringify({ a: 1 }))
    expect((await fsp.readdir(dir)).filter((f) => f.includes(".tmp"))).toEqual([])
    // Sovrascrittura: mai troncamento visibile, contenuto finale intero.
    await atomicWriteFile(file, JSON.stringify({ a: 2 }))
    expect(await fsp.readFile(file, "utf-8")).toBe(JSON.stringify({ a: 2 }))
    expect((await fsp.readdir(dir)).filter((f) => f.includes(".tmp"))).toEqual([])
  })

  it("preserva mode 0o600 sui segreti", async () => {
    if (process.platform === "win32") return // mode POSIX non verificabile
    const dir = await freshDir()
    const file = path.join(dir, "keys.json")
    await atomicWriteFile(file, "{}", { mode: 0o600 })
    const st = await fsp.stat(file)
    expect(st.mode & 0o777).toBe(0o600)
  })
})
