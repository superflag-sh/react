import { execFileSync } from "node:child_process"
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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

function verifyDeclarations(label, reactVersion, reactTypesVersion) {
  const fixture = join(temp, `types-react-${label}`)
  mkdirSync(fixture)
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ private: true, type: "module" }))
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "--cache",
      join(temp, ".npm-cache"),
      `react@${reactVersion}`,
      `@types/react@${reactTypesVersion}`,
      coreTarball,
      tarball,
    ],
    fixture,
  )
  writeFileSync(
    join(fixture, "consumer.tsx"),
    'import { SuperflagProvider, createTypedHooks, useFlag, type StorageAdapter, type SuperflagTelemetryOptions } from "@superflag-sh/react";\n' +
      'declare const storage: StorageAdapter;\n' +
      'declare const telemetry: SuperflagTelemetryOptions;\n' +
      'interface FlagValues { enabled: boolean }\n' +
      'const typed = createTypedHooks<FlagValues>();\n' +
      'const Child = () => <span>{String(useFlag("enabled", false))}</span>;\n' +
      'const TypedChild = () => { const client = typed.useClient(); void client.track("enabled", "conversion"); void client.track("enabled", "revenue", 1); void client.flush(); return <span>{String(typed.useFlag("enabled", client.getFlag("enabled", false)))}</span> };\n' +
      'export const App = () => <SuperflagProvider clientKey="pub_prod_smoke" targetingKey="user-1" storage={storage} telemetry={telemetry}><Child /><TypedChild /></SuperflagProvider>;\n',
  )
  run(
    join(root, "node_modules", ".bin", "tsc"),
    ["--noEmit", "--strict", "--jsx", "react-jsx", "--target", "ES2019", "--module", "ESNext", "--moduleResolution", "Bundler", "consumer.tsx"],
    fixture,
  )
  for (const name of ["react", "core"]) {
    const installed = realpathSync(join(fixture, "node_modules", "@superflag-sh", name))
    if (!installed.startsWith(realpathSync(fixture))) throw new Error(`${name} resolved outside the packed consumer fixture`)
  }
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
    ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-package-lock", "--no-audit", "--no-fund", "--cache", join(temp, ".npm-cache"), "react@19.2.0", "react-test-renderer@19.2.0", coreTarball, tarball],
    temp,
  )

  writeFileSync(
    join(temp, "smoke-esm.mjs"),
    'import { SuperflagProvider, createHostedTelemetryTransport, createTypedHooks, useFlag, useFlagDetails, useFlags } from "@superflag-sh/react";\n' +
      'if (![SuperflagProvider, createHostedTelemetryTransport, createTypedHooks, useFlag, useFlagDetails, useFlags].every((value) => typeof value === "function")) throw new Error("ESM exports missing");\n',
  )
  writeFileSync(
    join(temp, "smoke-cjs.cjs"),
    'const { SuperflagProvider, createHostedTelemetryTransport, createTypedHooks, useFlag, useFlagDetails, useFlags } = require("@superflag-sh/react");\n' +
      'if (![SuperflagProvider, createHostedTelemetryTransport, createTypedHooks, useFlag, useFlagDetails, useFlags].every((value) => typeof value === "function")) throw new Error("CJS exports missing");\n',
  )
  writeFileSync(
    join(temp, "smoke-behavior.mjs"),
    `import React from "react"\n` +
      `import { act, create } from "react-test-renderer"\n` +
      `import { SuperflagProvider, useBooleanFlag, useFlags, useSuperflagClient } from "@superflag-sh/react"\n` +
      `globalThis.IS_REACT_ACT_ENVIRONMENT = true\n` +
      `const config = { schemaVersion: 1, source: { app: "smoke", environment: "test" }, configVersion: 1, flags: { checkout: { type: "boolean", description: "smoke", tags: [], owner: "sdk", lifecycle: "active", enabled: true, visibility: "client", variations: { off: { value: false }, on: { value: true } }, offVariation: "off", fallthrough: { variation: "on" } } } }\n` +
      `globalThis.fetch = async () => Response.json({ appId: "smoke", env: "test", version: 1, doc: config, ttlSeconds: 60 }, { headers: { ETag: "\\\"1\\\"" } })\n` +
      `const events = []; const exposures = []; let client; let value = false\n` +
      `function Feature() { useFlags(); value = useBooleanFlag("checkout", false); client = useSuperflagClient(); return React.createElement("span", null, String(value)) }\n` +
      `function renderApp() { return React.createElement(SuperflagProvider, { clientKey: "pub_never_emit", targetingKey: "raw-user@example.com", attributes: { email: "raw-user@example.com" }, onExposure: (event) => exposures.push(event), telemetry: { transport: { send: async () => { throw new Error("offline") } }, maxAttempts: 1, flushIntervalMs: 60000, allowedAttributes: ["plan"], onEvent: (event) => events.push(event), pseudonymize: ({ namespace, state }) => ({ id: "psn_0123456789abcdef", namespace, revision: 1, state }) } }, React.createElement(Feature)) }\n` +
      `let root\n` +
      `await act(async () => { root = create(renderApp())\n` +
      `  for (let index = 0; index < 8; index += 1) await Promise.resolve()\n` +
      `})\n` +
      `if (value !== true) throw new Error("packed provider did not evaluate fetched config")\n` +
      `await Promise.resolve()\n` +
      `if (events.filter((event) => event.kind === "exposure").length !== 1 || exposures.length !== 1) throw new Error("provider init or bulk reads created false exposures")\n` +
      `await act(async () => root.update(renderApp()))\n` +
      `const tracked = await client.track("checkout", "revenue", 3.5, { attributes: { plan: "pro", email: "raw-user@example.com" } })\n` +
      `if (tracked.status !== "queued") throw new Error("inline telemetry options reset exposure state")\n` +
      `const converted = await client.track("checkout", "converted")\n` +
      `if (converted.status !== "queued") throw new Error("binary outcome was not queued")\n` +
      `const outcomes = events.filter((event) => event.kind === "outcome")\n` +
      `const outcome = outcomes.find((event) => event.metric.key === "revenue")\n` +
      `if (!outcome || outcome.dimensions?.plan !== "pro" || "email" in (outcome.dimensions || {})) throw new Error("outcome allow-list projection failed")\n` +
      `if (!outcomes.some((event) => event.metric.key === "converted" && event.value === true)) throw new Error("binary outcome contract failed")\n` +
      `const serialized = JSON.stringify(events)\n` +
      `if (serialized.includes("raw-user@example.com") || serialized.includes("pub_never_emit")) throw new Error("raw telemetry identity leaked")\n` +
      `await client.flush()\n` +
      `await act(async () => root.unmount())\n`,
  )
  run("node", ["smoke-esm.mjs"], temp)
  run("node", ["smoke-cjs.cjs"], temp)
  run("node", ["smoke-behavior.mjs"], temp)
  verifyDeclarations("18", "18.3.1", "18.3.27")
  verifyDeclarations("19", "19.2.0", "19.2.17")

  const manifest = JSON.parse(readFileSync(join(temp, "node_modules", "@superflag-sh", "react", "package.json"), "utf8"))
  if (manifest.dependencies?.["@superflag-sh/core"] !== "^0.2.1") {
    throw new Error("Published core dependency must remain ^0.2.1")
  }
  if (/\b(?:file|link):/.test(JSON.stringify(manifest.dependencies ?? {}))) {
    throw new Error("Published dependencies contain a local file/link locator")
  }
  console.log(`tarball: ${entries.length} files, source-only entries: 0`)
  console.log(`runtime imports: ESM and CommonJS ok (${manifest.name}@${manifest.version})`)
  console.log("core dependency: ^0.2.1 manifest range, local packed resolution ok")
  console.log("packed React behavior: exposure privacy, offline fail-open, binary/numeric outcome allow-list ok")
  console.log("consumer declarations: React 18 and React 19 bundler TSX ok (skipLibCheck disabled)")
} finally {
  rmSync(temp, { recursive: true, force: true })
}
