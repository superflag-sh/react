import { execFileSync } from "node:child_process"
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const coreRoot = process.env.SUPERFLAG_CORE_DIR
  ? resolve(root, process.env.SUPERFLAG_CORE_DIR)
  : join(root, "node_modules", "@superflag-sh", "core")
const temp = mkdtempSync(join(tmpdir(), "superflag-react-smoke-"))
const tarball = join(temp, "package.tgz")
const coreTarball = join(temp, "core.tgz")
const stagedCore = join(temp, "core-package")

function run(command, args, cwd = root) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

function linkDependency(name) {
  const source = join(root, "node_modules", ...name.split("/"))
  const destination = join(temp, "node_modules", ...name.split("/"))
  mkdirSync(dirname(destination), { recursive: true })
  if (!existsSync(destination)) symlinkSync(source, destination, "junction")
}

try {
  run("bun", ["pm", "pack", "--ignore-scripts", "--filename", tarball])
  mkdirSync(stagedCore)
  copyFileSync(join(coreRoot, "package.json"), join(stagedCore, "package.json"))
  copyFileSync(join(coreRoot, "README.md"), join(stagedCore, "README.md"))
  cpSync(join(coreRoot, "dist"), join(stagedCore, "dist"), { recursive: true })
  run("bun", ["pm", "pack", "--ignore-scripts", "--filename", coreTarball], stagedCore)
  const entries = run("tar", ["-tzf", tarball]).trim().split("\n")
  const forbidden = entries.filter((entry) => /\/(src|scripts|smoke|__tests__)\//.test(entry))
  if (forbidden.length > 0) throw new Error(`Source-only files leaked into tarball: ${forbidden.join(", ")}`)

  for (const required of [
    "package/dist/esm/index.js",
    "package/dist/cjs/index.js",
    "package/dist/cjs/package.json",
    "package/dist/types/index.d.ts",
  ]) {
    if (!entries.includes(required)) throw new Error(`Missing tarball entry: ${required}`)
  }

  writeFileSync(join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }))
  run(
    "npm",
    ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-package-lock", "--no-audit", "--no-fund", "--cache", join(temp, ".npm-cache"), coreTarball, tarball],
    temp,
  )
  linkDependency("react")
  linkDependency("@types/react")

  writeFileSync(
    join(temp, "smoke-esm.mjs"),
    'import { SuperflagProvider, createTypedHooks, useFlag, useFlagDetails, useFlags } from "@superflag-sh/react";\n' +
      'if (![SuperflagProvider, createTypedHooks, useFlag, useFlagDetails, useFlags].every((value) => typeof value === "function")) throw new Error("ESM exports missing");\n',
  )
  writeFileSync(
    join(temp, "smoke-cjs.cjs"),
    'const { SuperflagProvider, createTypedHooks, useFlag, useFlagDetails, useFlags } = require("@superflag-sh/react");\n' +
      'if (![SuperflagProvider, createTypedHooks, useFlag, useFlagDetails, useFlags].every((value) => typeof value === "function")) throw new Error("CJS exports missing");\n',
  )
  writeFileSync(
    join(temp, "consumer.tsx"),
    'import { SuperflagProvider, createTypedHooks, useFlag, type StorageAdapter } from "@superflag-sh/react";\n' +
      'declare const storage: StorageAdapter;\n' +
      'interface FlagValues { enabled: boolean }\n' +
      'const typed = createTypedHooks<FlagValues>();\n' +
      'const Child = () => <span>{String(useFlag("enabled", false))}</span>;\n' +
    'const TypedChild = () => { const client = typed.useClient(); return <span>{String(typed.useFlag("enabled", client.getFlag("enabled", false)))}</span> };\n' +
      'export const App = () => <SuperflagProvider clientKey="pub_prod_smoke" targetingKey="user-1" storage={storage}><Child /><TypedChild /></SuperflagProvider>;\n',
  )

  run("node", ["smoke-esm.mjs"], temp)
  run("node", ["smoke-cjs.cjs"], temp)
  run(
    join(root, "node_modules", ".bin", "tsc"),
    ["--noEmit", "--skipLibCheck", "--jsx", "react-jsx", "--target", "ES2019", "--module", "NodeNext", "--moduleResolution", "NodeNext", "consumer.tsx"],
    temp,
  )

  const manifest = JSON.parse(readFileSync(join(temp, "node_modules", "@superflag-sh", "react", "package.json"), "utf8"))
  if (manifest.dependencies?.["@superflag-sh/core"] !== "^0.1.0") {
    throw new Error("Published core dependency must remain ^0.1.0")
  }
  if (/\b(?:file|link):/.test(JSON.stringify(manifest.dependencies ?? {}))) {
    throw new Error("Published dependencies contain a local file/link locator")
  }
  console.log(`tarball: ${entries.length} files, source-only entries: 0`)
  console.log(`runtime imports: ESM and CommonJS ok (${manifest.name}@${manifest.version})`)
  console.log("core dependency: ^0.1.0 manifest range, local packed resolution ok")
  console.log("consumer declarations: NodeNext TSX ok")
} finally {
  rmSync(temp, { recursive: true, force: true })
}
