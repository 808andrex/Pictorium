import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Resolve Pi's own types without adding it to the application's dependencies.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const appRequire = createRequire(path.join(root, "package.json"))
const ts = appRequire("typescript")
if (!process.env.PI_PACKAGE_DIR) throw new Error("Set PI_PACKAGE_DIR to the installed Pi package directory")
const piPackage = path.resolve(process.env.PI_PACKAGE_DIR)
const piRequire = createRequire(path.join(piPackage, "package.json"))
const options = {
  noEmit: true, allowJs: true, skipLibCheck: true, strict: true,
  target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, types: ["node"],
  baseUrl: root, paths: {
    "@earendil-works/pi-coding-agent": [path.join(piPackage, "dist/index.d.ts")],
    typebox: [piRequire.resolve("typebox").replace(/\.mjs$/, ".d.mts")],
  },
}
const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([path.join(root, ".pi/extensions/pictorium.ts")], options))
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (file) => file, getCurrentDirectory: () => root, getNewLine: () => "\n",
  }))
  process.exitCode = 1
} else console.log("Pi extension API typecheck: passed")
