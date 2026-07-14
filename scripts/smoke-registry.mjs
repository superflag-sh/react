import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const packageName = "@superflag-sh/react"
const registry = "https://registry.npmjs.org/"
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = mkdtempSync(join(tmpdir(), "superflag-react-registry-"))
const cache = join(temp, ".npm-cache")
const userConfig = join(temp, "npm-userconfig")
const globalConfig = join(temp, "npm-globalconfig")
writeFileSync(userConfig, "")
writeFileSync(globalConfig, "")

function run(command, args, cwd = temp) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "1",
      NODE_PATH: "",
      npm_config_cache: cache,
      npm_config_registry: registry,
      npm_config_userconfig: userConfig,
      npm_config_globalconfig: globalConfig,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function npmView(spec) {
  return JSON.parse(run("npm", ["view", spec, "--json"]))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function registryMetadata(requestedVersion) {
  if (requestedVersion && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requestedVersion)) {
    throw new Error("SUPERFLAG_PACKAGE_VERSION must be an exact semver version")
  }
  const attempts = requestedVersion ? 12 : 1
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const viewed = npmView(`${packageName}@${requestedVersion || "latest"}`)
      const response = await fetch(`${registry}${packageName.replace("/", "%2f")}/${viewed.version}`)
      if (!response.ok) throw new Error(`Registry metadata returned HTTP ${response.status}`)
      const metadata = await response.json()
      if (requestedVersion && !metadata.dist?.attestations?.url) throw new Error("npm provenance is not available yet")
      return metadata
    } catch (error) {
      if (attempt === attempts) throw error
      console.log(`waiting for ${packageName}@${requestedVersion} in npm (${attempt}/${attempts})`)
      await new Promise((resolve) => setTimeout(resolve, 10_000))
    }
  }
}

try {
  if (resolve(temp).startsWith(`${resolve(root)}/`)) throw new Error("Fixture must be outside the repository")

  const requested = process.env.SUPERFLAG_PACKAGE_VERSION?.trim()
  const metadata = await registryMetadata(requested)
  const version = metadata.version
  if (!version || (requested && version !== requested)) throw new Error(`Registry did not resolve ${packageName}@${requested}`)
  if (!metadata.dist?.integrity?.startsWith("sha512-")) throw new Error("Registry metadata is missing sha512 integrity")
  const expectedTarballPrefix = `${registry}${packageName}/-/`
  if (!metadata.dist?.tarball?.startsWith(expectedTarballPrefix)) {
    throw new Error(`Unexpected registry tarball URL: ${metadata.dist?.tarball}`)
  }
  if (!metadata.dist?.attestations?.provenance?.predicateType?.includes("slsa.dev/provenance")) {
    throw new Error("Published package is missing npm provenance metadata")
  }
  if (metadata._npmUser?.trustedPublisher?.id !== "github") {
    throw new Error("Published package was not produced by the trusted GitHub publisher")
  }
  assert(metadata.repository?.url === "git+https://github.com/superflag-sh/react.git", `Unexpected repository metadata: ${metadata.repository?.url}`)
  const attestationResponse = await fetch(metadata.dist.attestations.url)
  assert(attestationResponse.ok, `npm attestation endpoint returned ${attestationResponse.status}`)
  const attestations = (await attestationResponse.json()).attestations
  assert(Array.isArray(attestations) && attestations.some((entry) => entry.predicateType === "https://slsa.dev/provenance/v1"), "npm attestation bundle is missing SLSA provenance")
  assert(attestations.every((entry) => entry.bundle?.mediaType?.startsWith("application/vnd.dev.sigstore.bundle")), "npm returned an unexpected attestation bundle format")
  const provenance = attestations.find((entry) => entry.predicateType === "https://slsa.dev/provenance/v1")
  const statement = JSON.parse(Buffer.from(provenance.bundle.dsseEnvelope.payload, "base64").toString("utf8"))
  const subject = statement.subject?.find((entry) => entry.name === `pkg:npm/%40superflag-sh/react@${version}`)
  const expectedSha512 = Buffer.from(metadata.dist.integrity.slice("sha512-".length), "base64").toString("hex")
  assert(subject?.digest?.sha512 === expectedSha512, "SLSA subject does not match the published tarball integrity")
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow
  assert(workflow?.repository === "https://github.com/superflag-sh/react", `Unexpected provenance repository: ${workflow?.repository}`)
  assert(workflow?.path === ".github/workflows/publish.yml", `Unexpected provenance workflow: ${workflow?.path}`)
  assert(workflow?.ref === `refs/tags/v${version}`, `Unexpected provenance ref: ${workflow?.ref}`)

  writeFileSync(join(temp, "package.json"), JSON.stringify({ name: "registry-consumer", private: true, type: "module" }, null, 2))
  run("npm", [
    "install", "--ignore-scripts", "--save-exact", "--no-audit", "--no-fund",
    `${packageName}@${version}`,
    "react@19.2.0", "react-dom@19.2.0",
    "@types/react@19.2.17", "@types/react-dom@19.2.3",
    "@vitejs/plugin-react@5.1.1", "vite@7.2.4", "typescript@5.9.3",
  ])

  const lockPath = join(temp, "package-lock.json")
  const lockText = readFileSync(lockPath, "utf8")
  if (/\b(?:file|link|workspace):/.test(lockText)) throw new Error("Lockfile contains a local dependency locator")
  const lock = JSON.parse(lockText)
  const reactEntry = lock.packages?.[`node_modules/${packageName}`]
  const coreEntry = lock.packages?.["node_modules/@superflag-sh/core"]
  for (const [name, entry] of [[packageName, reactEntry], ["@superflag-sh/core", coreEntry]]) {
    if (!entry?.version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.version)) throw new Error(`${name} did not resolve to an exact version`)
    if (!entry.resolved?.startsWith(registry)) throw new Error(`${name} did not resolve from npmjs.org`)
    if (!entry.integrity?.startsWith("sha512-")) throw new Error(`${name} lock entry is missing sha512 integrity`)
  }
  if (reactEntry.version !== version || reactEntry.integrity !== metadata.dist.integrity) {
    throw new Error("Installed React SDK does not match registry metadata")
  }
  const installedPath = realpathSync(join(temp, "node_modules", "@superflag-sh", "react"))
  if (!installedPath.startsWith(realpathSync(temp))) throw new Error("React SDK escaped the isolated fixture")
  const corePath = realpathSync(join(temp, "node_modules", "@superflag-sh", "core"))
  if (!corePath.startsWith(realpathSync(temp))) throw new Error("Core SDK escaped the isolated fixture")

  const packDir = join(temp, "registry-pack")
  mkdirSync(packDir)
  const packed = JSON.parse(run("npm", ["pack", `${packageName}@${version}`, "--ignore-scripts", "--pack-destination", packDir, "--json"]))[0]
  if (packed.integrity !== metadata.dist.integrity) throw new Error("Packed artifact integrity differs from registry metadata")
  const tarball = join(packDir, packed.filename)
  const tarballIntegrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`
  if (tarballIntegrity !== metadata.dist.integrity) throw new Error("Downloaded tarball bytes differ from registry integrity metadata")
  const entries = run("tar", ["-tzf", tarball]).trim().split("\n")
  const forbidden = entries.filter((entry) => /^package\/(?:src|scripts|test|tests|__tests__|smoke)(?:\/|$)/.test(entry))
  if (forbidden.length) throw new Error(`Source-only files leaked into the registry artifact: ${forbidden.join(", ")}`)
  for (const required of [
    "package/dist/esm/index.js",
    "package/dist/cjs/index.js",
    "package/dist/cjs/package.json",
    "package/dist/types/index.d.ts",
  ]) {
    if (!entries.includes(required)) throw new Error(`Registry artifact is missing ${required}`)
  }
  const exportTargets = new Set([
    metadata.main,
    metadata.module,
    metadata.types,
    ...Object.values(metadata.exports?.["."] ?? {}),
  ].filter((value) => typeof value === "string"))
  for (const target of exportTargets) {
    const entry = `package/${target.replace(/^\.\//, "")}`
    if (!entries.includes(entry)) throw new Error(`Package export target is missing from the registry artifact: ${target}`)
  }

  const expectedExports = ["SuperflagProvider", "createTypedHooks", "useBooleanFlag", "useBooleanFlagDetails", "useFlag", "useFlagDetails", "useFlags", "useNumberFlag", "useNumberFlagDetails", "useObjectFlag", "useObjectFlagDetails", "useStringFlag", "useStringFlagDetails", "useSuperflagClient"]
  writeFileSync(join(temp, "expected-exports.json"), JSON.stringify(expectedExports))
  writeFileSync(join(temp, "smoke-esm.mjs"), 'import * as sdk from "@superflag-sh/react";\nimport expected from "./expected-exports.json" with { type: "json" };\nif (JSON.stringify(Object.keys(sdk).sort()) !== JSON.stringify(expected.sort())) throw new Error(`ESM exports differ: ${Object.keys(sdk)}`);\n')
  writeFileSync(join(temp, "smoke-cjs.cjs"), 'const sdk = require("@superflag-sh/react");\nconst expected = require("./expected-exports.json");\nif (JSON.stringify(Object.keys(sdk).sort()) !== JSON.stringify(expected.sort())) throw new Error(`CJS exports differ: ${Object.keys(sdk)}`);\n')
  writeFileSync(join(temp, "index.html"), '<div id="root"></div><script type="module" src="/src/main.tsx"></script>\n')
  mkdirSync(join(temp, "src"))
  writeFileSync(join(temp, "src", "main.tsx"), `import React from "react"\nimport { createRoot } from "react-dom/client"\nimport { SuperflagProvider, useBooleanFlag } from "${packageName}"\n\nfunction Feature() {\n  const enabled: boolean = useBooleanFlag("registry-smoke", false)\n  return <main>{enabled ? "enabled" : "disabled"}</main>\n}\n\ncreateRoot(document.getElementById("root")!).render(\n  <React.StrictMode><SuperflagProvider clientKey="pub_registry_smoke"><Feature /></SuperflagProvider></React.StrictMode>,\n)\n`)
  writeFileSync(join(temp, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", useDefineForClassFields: true, lib: ["ES2022", "DOM", "DOM.Iterable"], module: "ESNext", skipLibCheck: false, moduleResolution: "Bundler", allowImportingTsExtensions: true, isolatedModules: true, moduleDetection: "force", noEmit: true, jsx: "react-jsx", strict: true }, include: ["src"] }, null, 2))
  writeFileSync(join(temp, "vite.config.ts"), 'import { defineConfig } from "vite"\nimport react from "@vitejs/plugin-react"\nexport default defineConfig({ plugins: [react()] })\n')

  run("node", ["smoke-esm.mjs"])
  run("node", ["smoke-cjs.cjs"])
  run("npm", ["exec", "--", "tsc", "--noEmit"])
  run("npm", ["exec", "--", "vite", "build"])
  if (!existsSync(join(temp, "dist", "index.html"))) throw new Error("Vite did not produce a production build")

  console.log(`${packageName}@${version}: npm registry integrity and trusted provenance ok`)
  console.log(`@superflag-sh/core@${coreEntry.version}: exact npm registry resolution and integrity ok`)
  console.log(`artifact: ${entries.length} files, required exports present, source-only entries: 0`)
  console.log("consumer: ESM, CommonJS, declarations, and Vite production build ok")
} finally {
  rmSync(temp, { recursive: true, force: true })
}
