import { afterEach, describe, expect, test } from "bun:test"
import { migrateLegacyFlags } from "@superflag-sh/core"
import {
  CACHE_SCHEMA_VERSION,
  LEGACY_CACHE_KEYS,
  createCacheKey,
  createCacheScope,
  createPersistedCacheBinding,
  sha256,
} from "@superflag-sh/core"
import { createClient } from "../client.js"
import type { CachedConfig, StorageAdapter, SuperflagState } from "../types.js"
import { SHA256_TEST_VECTORS } from "./cache-vectors.js"

const CONFIG_URL = "https://superflag.sh/api/v1/public-config"
const originalFetch = globalThis.fetch

class TestStorage implements StorageAdapter {
  readonly values = new Map<string, string>()
  readonly removed: string[] = []

  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null
  }

  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }

  async removeItem(key: string): Promise<void> {
    this.removed.push(key)
    this.values.delete(key)
  }
}

function makeResponse(appId: string, environment: string, version: number, enabled = true): Response {
  const body = {
    appId,
    env: environment,
    version,
    doc: {
      flags: { enabled: { type: "bool", value: enabled } },
      overrides: {},
      rules: {},
    },
    ttlSeconds: 60,
  }
  return Response.json(body, { headers: { ETag: `"${version}"` } })
}

function makeConfig(appId: string, environment: string, version: number, enabled = true) {
  return migrateLegacyFlags(
    { enabled: { type: "bool", value: enabled, clientEnabled: true } },
    {
      source: { app: appId, environment },
      configVersion: version,
    },
  )
}

function makeCached(clientKey: string, appId = "app-a", environment = "prod"): CachedConfig {
  const scope = createCacheScope(CONFIG_URL, clientKey)
  const config = makeConfig(appId, environment, 7)
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    endpointFingerprint: scope.endpointFingerprint,
    clientKeyFingerprint: scope.clientKeyFingerprint,
    appId,
    environment,
    flags: config.flags,
    config,
    version: 7,
    etag: '"7"',
    fetchedAt: Date.now(),
  }
}

function seedBoundCache(
  storage: TestStorage,
  clientKey: string,
  appId = "app-a",
  environment = "prod",
): { bindingKey: string; cacheKey: string } {
  const scope = createCacheScope(CONFIG_URL, clientKey)
  const binding = createPersistedCacheBinding(scope, { appId, environment })
  const cacheKey = createCacheKey(scope, binding)
  storage.values.set(scope.bindingKey, JSON.stringify(binding))
  storage.values.set(cacheKey, JSON.stringify(makeCached(clientKey, appId, environment)))
  return { bindingKey: scope.bindingKey, cacheKey }
}

function createTestClient(clientKey: string, storage: TestStorage, configUrl = CONFIG_URL) {
  const states: SuperflagState[] = []
  const client = createClient({
    clientKey,
    configUrl,
    ttlSeconds: 60,
    storage,
    onStateChange: (state) => states.push(state),
  })
  return { client, states }
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("cache identity", () => {
  for (const [input, expected] of SHA256_TEST_VECTORS) {
    test(`matches SHA-256 vector for ${JSON.stringify(input)}`, () => {
      expect(sha256(input)).toBe(expected)
    })
  }

  test("namespaces bindings and caches without storing the raw key", () => {
    const clientKey = "pub_prod_super-secret"
    const first = createCacheScope(CONFIG_URL, clientKey)
    const rotated = createCacheScope(CONFIG_URL, `${clientKey}-rotated`)
    const otherEndpoint = createCacheScope("https://staging.superflag.sh/api/v1/public-config", clientKey)
    const prod = createPersistedCacheBinding(first, { appId: "app-a", environment: "prod" })
    const staging = createPersistedCacheBinding(first, { appId: "app-a", environment: "staging" })

    expect(first.bindingKey).not.toBe(rotated.bindingKey)
    expect(first.bindingKey).not.toBe(otherEndpoint.bindingKey)
    expect(createCacheKey(first, prod)).not.toBe(createCacheKey(first, staging))
    expect(first.bindingKey).not.toContain(clientKey)
    expect(createCacheKey(first, prod)).not.toContain(clientKey)
    expect(first.clientKeyFingerprint).toHaveLength(64)
  })

  test("establishes and persists a separate binding only after an authenticated 200", async () => {
    const clientKey = "pub_prod_first-200"
    const storage = new TestStorage()
    const scope = createCacheScope(CONFIG_URL, clientKey)
    globalThis.fetch = async () => makeResponse("app-a", "prod", 1)

    const { client } = createTestClient(clientKey, storage)
    await client.initialize()

    const binding = createPersistedCacheBinding(scope, { appId: "app-a", environment: "prod" })
    expect(JSON.parse(storage.values.get(scope.bindingKey) ?? "{}")).toEqual(binding)
    expect(storage.values.has(createCacheKey(scope, binding))).toBe(true)
    expect(JSON.stringify([...storage.values])).not.toContain(clientKey)
  })

  test("uses 304 only with a matching persisted binding and config cache", async () => {
    const clientKey = "pub_prod_active"
    const storage = new TestStorage()
    seedBoundCache(storage, clientKey)
    let conditionalHeader: string | null = null
    globalThis.fetch = async (_input, init) => {
      conditionalHeader = new Headers(init?.headers).get("If-None-Match")
      return new Response(null, { status: 304 })
    }

    const { client, states } = createTestClient(clientKey, storage)
    await client.initialize()

    expect(conditionalHeader).toBe('"7"')
    expect(states.at(-1)?.status).toBe("ready")
    expect(states.at(-1)?.appId).toBe("app-a")
    expect(states.at(-1)?.environment).toBe("prod")
  })

  test("ignores a poisoned config cache that has no successful-200 binding", async () => {
    const clientKey = "pub_prod_unbound-poison"
    const storage = new TestStorage()
    const scope = createCacheScope(CONFIG_URL, clientKey)
    const forgedBinding = createPersistedCacheBinding(scope, { appId: "attacker", environment: "prod" })
    storage.values.set(createCacheKey(scope, forgedBinding), JSON.stringify(makeCached(clientKey, "attacker", "prod")))
    const headers: Array<string | null> = []
    globalThis.fetch = async (_input, init) => {
      headers.push(new Headers(init?.headers).get("If-None-Match"))
      return makeResponse("app-a", "prod", 1)
    }

    const { client, states } = createTestClient(clientKey, storage)
    await client.initialize()

    expect(headers).toEqual([null])
    expect(states.at(-1)?.appId).toBe("app-a")
    expect(states.at(-1)?.flags.enabled?.variations.default?.value).toBe(true)
  })

  test("clears a cache poisoned with an identity that conflicts with its binding", async () => {
    const clientKey = "pub_prod_poisoned"
    const storage = new TestStorage()
    const scope = createCacheScope(CONFIG_URL, clientKey)
    const binding = createPersistedCacheBinding(scope, { appId: "app-a", environment: "prod" })
    const cacheKey = createCacheKey(scope, binding)
    storage.values.set(scope.bindingKey, JSON.stringify(binding))
    storage.values.set(cacheKey, JSON.stringify(makeCached(clientKey, "attacker", "dev")))
    const headers: Array<string | null> = []
    globalThis.fetch = async (_input, init) => {
      headers.push(new Headers(init?.headers).get("If-None-Match"))
      return makeResponse("app-a", "prod", 8)
    }

    const { client, states } = createTestClient(clientKey, storage)
    await client.initialize()

    expect(headers).toEqual([null])
    expect(storage.removed).toContain(cacheKey)
    expect(states.at(-1)?.appId).toBe("app-a")
    expect(JSON.parse(storage.values.get(cacheKey) ?? "{}").version).toBe(8)
  })

  test("rejects a cache whose nested config metadata conflicts with its envelope", async () => {
    const clientKey = "pub_prod_nested-poison"
    const storage = new TestStorage()
    const keys = seedBoundCache(storage, clientKey)
    const cached = JSON.parse(storage.values.get(keys.cacheKey) ?? "{}")
    cached.config.source.app = "attacker"
    storage.values.set(keys.cacheKey, JSON.stringify(cached))
    const headers: Array<string | null> = []
    globalThis.fetch = async (_input, init) => {
      headers.push(new Headers(init?.headers).get("If-None-Match"))
      return makeResponse("app-a", "prod", 8)
    }

    const { client, states } = createTestClient(clientKey, storage)
    await client.initialize()

    expect(headers).toEqual([null])
    expect(storage.removed).toContain(keys.cacheKey)
    expect(states.at(-1)).toMatchObject({ appId: "app-a", configVersion: 8 })
  })

  test("does not reuse cache across client keys or endpoints", async () => {
    const oldKey = "pub_prod_old"
    const newKey = "pub_stage_new"
    const storage = new TestStorage()
    const oldKeys = seedBoundCache(storage, oldKey)
    const headers: Array<string | null> = []
    globalThis.fetch = async (_input, init) => {
      headers.push(new Headers(init?.headers).get("If-None-Match"))
      return makeResponse("app-b", "staging", 1, false)
    }

    const { client, states } = createTestClient(newKey, storage)
    await client.initialize()
    const otherEndpoint = createCacheScope("https://edge.example/public-config", newKey)

    expect(headers).toEqual([null])
    expect(states.at(-1)?.flags.enabled?.variations.default?.value).toBe(false)
    expect(states.at(-1)?.appId).toBe("app-b")
    expect(states.at(-1)?.environment).toBe("staging")
    expect(storage.values.has(oldKeys.cacheKey)).toBe(true)
    expect(storage.values.has(otherEndpoint.bindingKey)).toBe(false)
  })

  test("invalidates legacy caches and malformed bindings deterministically", async () => {
    const clientKey = "pub_prod_upgrade"
    const storage = new TestStorage()
    const scope = createCacheScope(CONFIG_URL, clientKey)
    storage.values.set(LEGACY_CACHE_KEYS[0], JSON.stringify({ flags: { stale: true } }))
    storage.values.set(scope.legacyCacheKey, JSON.stringify(makeCached(clientKey)))
    storage.values.set(scope.bindingKey, JSON.stringify({ schemaVersion: 2, appId: "attacker", environment: "prod" }))
    globalThis.fetch = async () => makeResponse("app-a", "prod", 8)

    const { client } = createTestClient(clientKey, storage)
    await client.initialize()

    expect(storage.removed).toContain(LEGACY_CACHE_KEYS[0])
    expect(storage.removed).toContain(scope.legacyCacheKey)
    expect(storage.removed).toContain(scope.bindingKey)
    expect(JSON.parse(storage.values.get(scope.bindingKey) ?? "{}").schemaVersion).toBe(3)
  })

  test("clears the binding, cache, and flags when the client key is invalid", async () => {
    const clientKey = "pub_prod_revoked"
    const storage = new TestStorage()
    const keys = seedBoundCache(storage, clientKey)
    globalThis.fetch = async () => Response.json({ error: "Invalid or revoked client key" }, { status: 401 })

    const { client, states } = createTestClient(clientKey, storage)
    await client.initialize()

    expect(storage.values.has(keys.bindingKey)).toBe(false)
    expect(storage.values.has(keys.cacheKey)).toBe(false)
    expect(states.at(-1)?.flags).toEqual({})
    expect(states.at(-1)?.appId).toBeNull()
    expect(states.at(-1)?.status).toBe("error")
  })

  test("rejects and clears an authenticated identity change instead of rebinding", async () => {
    const clientKey = "pub_prod_rebound"
    const storage = new TestStorage()
    const keys = seedBoundCache(storage, clientKey)
    globalThis.fetch = async () => makeResponse("app-b", "dev", 2, false)

    const { client, states } = createTestClient(clientKey, storage)
    await client.initialize()

    expect(storage.values.has(keys.bindingKey)).toBe(false)
    expect(storage.values.has(keys.cacheKey)).toBe(false)
    expect(states.at(-1)?.appId).toBeNull()
    expect(states.at(-1)?.flags).toEqual({})
    expect(states.at(-1)?.status).toBe("error")
    expect(states.at(-1)?.error).toContain("identity changed")
  })

  test("rejects 304 responses when a binding has no valid matching cache", async () => {
    const clientKey = "pub_prod_uncached"
    const storage = new TestStorage()
    const scope = createCacheScope(CONFIG_URL, clientKey)
    const binding = createPersistedCacheBinding(scope, { appId: "app-a", environment: "prod" })
    storage.values.set(scope.bindingKey, JSON.stringify(binding))
    const requestHeaders: Array<string | null> = []
    globalThis.fetch = async (_input, init) => {
      requestHeaders.push(new Headers(init?.headers).get("If-None-Match"))
      return new Response(null, { status: 304 })
    }

    const { client, states } = createTestClient(clientKey, storage)
    await client.initialize()

    expect(requestHeaders).toEqual([null, null])
    expect(states.at(-1)?.status).toBe("error")
    expect(states.at(-1)?.flags).toEqual({})
  })
})
