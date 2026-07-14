import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dist = join(root, "dist")
const cjs = join(dist, "cjs")
const bundledCjs = join(dist, "index.cjs")

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit" })
}

rmSync(dist, { recursive: true, force: true })
run(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.esm.json"])
run(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.cjs.json"])
run("bun", [
  "build",
  join(cjs, "index.js"),
  "--outfile",
  bundledCjs,
  "--format",
  "cjs",
  "--target",
  "node",
  "--external",
  "react",
  "--reject-unresolved",
])
rmSync(cjs, { recursive: true, force: true })
mkdirSync(cjs, { recursive: true })
renameSync(bundledCjs, join(cjs, "index.js"))
copyFileSync(join(root, "scripts", "cjs-package.json"), join(cjs, "package.json"))
run(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.types.json"])
