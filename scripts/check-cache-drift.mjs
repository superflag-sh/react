import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const contractPath = join(root, "scripts", "cache-contract.json")
const contract = JSON.parse(readFileSync(contractPath, "utf8"))

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex")
}

for (const [relativePath, expectedDigest] of Object.entries(contract)) {
  const actualDigest = digest(readFileSync(join(root, relativePath)))
  if (actualDigest !== expectedDigest) {
    throw new Error(`${relativePath} drifted from the shared cache contract: ${actualDigest}`)
  }
}

const packageName = basename(root)
const peerName = packageName === "superflag-react" ? "superflag-react-native" : "superflag-react"
const peerRoot = process.env.SUPERFLAG_CACHE_PEER_DIR
  ? resolve(root, process.env.SUPERFLAG_CACHE_PEER_DIR)
  : join(dirname(root), peerName)
const peerIsRequired = process.env.CI === "true" || process.env.SUPERFLAG_CACHE_PEER_DIR !== undefined

if (existsSync(peerRoot)) {
  const peerContract = readFileSync(join(peerRoot, "scripts", "cache-contract.json"))
  if (!readFileSync(contractPath).equals(peerContract)) {
    throw new Error(`Shared cache digest contract differs from ${peerRoot}`)
  }

  for (const relativePath of Object.keys(contract)) {
    const local = readFileSync(join(root, relativePath))
    const peer = readFileSync(join(peerRoot, relativePath))
    if (!local.equals(peer)) throw new Error(`${relativePath} differs from ${peerRoot}`)
  }

  console.log(`shared cache implementation and vectors: byte-identical to ${peerName}`)
} else {
  if (peerIsRequired) {
    throw new Error(`Shared cache peer is required but unavailable: ${peerRoot}`)
  }
  console.log("shared cache implementation and vectors: canonical digests verified")
}
