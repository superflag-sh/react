import { afterEach, describe, expect, test } from "bun:test"
import { conformanceConfig } from "@superflag-sh/core/conformance"
import { CACHE_SCHEMA_VERSION, createCacheKey, createCacheScope, createPersistedCacheBinding } from "@superflag-sh/core"
import { createClient } from "../client.js"
import type { CachedConfig, StorageAdapter, SuperflagDiagnostic, SuperflagState } from "../types.js"

const CONFIG_URL = "https://superflag.sh/api/v1/public-config"
const originalFetch = globalThis.fetch
const originalDocument = globalThis.document
const originalWindow = globalThis.window

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

function delayCapturedRead(storage: TestStorage, delayedKey: string): {
  started: Promise<void>
  release: () => void
} {
  const read = storage.getItem.bind(storage)
  let signalStarted: (() => void) | undefined
  let releaseRead: (() => void) | undefined
  const started = new Promise<void>((resolve) => { signalStarted = resolve })
  const gate = new Promise<void>((resolve) => { releaseRead = resolve })
  storage.getItem = async (key: string) => {
    const captured = await read(key)
    if (key !== delayedKey) return captured
    signalStarted?.()
    await gate
    return captured
  }
  return { started, release: () => releaseRead?.() }
}

function delayRejectedRead(storage: TestStorage, delayedKey: string): {
  started: Promise<void>
  release: () => void
} {
  const read = storage.getItem.bind(storage)
  let signalStarted: (() => void) | undefined
  let releaseRead: (() => void) | undefined
  const started = new Promise<void>((resolve) => { signalStarted = resolve })
  const gate = new Promise<void>((resolve) => { releaseRead = resolve })
  storage.getItem = async (key: string) => {
    if (key !== delayedKey) return read(key)
    signalStarted?.()
    await gate
    throw new Error("delayed storage failure")
  }
  return { started, release: () => releaseRead?.() }
}

class LifecycleTarget {
  readonly listeners = new Map<string, Set<EventListener>>()
  visibilityState = "visible"
  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }
  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener)
  }
  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type))
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }
}

function response(version = 7): Response {
  return Response.json(
    {
      appId: "conformance",
      env: "test",
      version,
      doc: { ...conformanceConfig, configVersion: version },
      ttlSeconds: 60,
    },
    { headers: { ETag: `"${version}"` } },
  )
}

function seedCache(storage: TestStorage, fetchedAt = Date.now()): void {
  const scope = createCacheScope(CONFIG_URL, "pub_test")
  const binding = createPersistedCacheBinding(scope, {
    appId: "conformance",
    environment: "test",
  })
  const cached: CachedConfig = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    endpointFingerprint: scope.endpointFingerprint,
    clientKeyFingerprint: scope.clientKeyFingerprint,
    appId: binding.appId,
    environment: binding.environment,
    flags: conformanceConfig.flags,
    config: conformanceConfig,
    version: conformanceConfig.configVersion,
    etag: `"${conformanceConfig.configVersion}"`,
    fetchedAt,
  }
  storage.values.set(scope.bindingKey, JSON.stringify(binding))
  storage.values.set(createCacheKey(scope, binding), JSON.stringify(cached))
}

function setupClient(
  overrides: Partial<Parameters<typeof createClient>[0]> = {},
): { client: ReturnType<typeof createClient>; states: SuperflagState[]; storage: TestStorage } {
  const states: SuperflagState[] = []
  const storage = (overrides.storage as TestStorage | undefined) ?? new TestStorage()
  const client = createClient({
    clientKey: "pub_test",
    configUrl: CONFIG_URL,
    ttlSeconds: 60,
    maxStaleAgeSeconds: 86_400,
    maxRetries: 0,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 4,
    storage,
    onStateChange: (state) => states.push(state),
    ...overrides,
  })
  return { client, states, storage }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.document = originalDocument
  globalThis.window = originalWindow
})

describe("web refresh lifecycle", () => {
  test("publishes cache first and then revalidates a 304 as network-fresh", async () => {
    const storage = new TestStorage()
    seedCache(storage)
    let resolveFetch: ((value: Response) => void) | undefined
    globalThis.fetch = () => new Promise((resolve) => { resolveFetch = resolve })
    const { client, states } = setupClient({ storage })

    const initializing = client.initialize()
    while (!resolveFetch) await Promise.resolve()
    expect(states.some((state) => state.source === "cache" && state.status === "ready")).toBe(true)
    resolveFetch(new Response(null, { status: 304 }))
    await initializing
    expect(states.at(-1)).toMatchObject({ source: "network", status: "ready", stale: false })
    client.destroy()
  })

  test("marks TTL-expired cache stale while revalidation is in flight", async () => {
    const storage = new TestStorage()
    seedCache(storage, Date.now() - 2_000)
    let resolveFetch: ((value: Response) => void) | undefined
    globalThis.fetch = () => new Promise((resolve) => { resolveFetch = resolve })
    const { client, states } = setupClient({ storage, ttlSeconds: 1 })

    const initializing = client.initialize()
    while (!resolveFetch) await Promise.resolve()
    expect(states.some((state) => state.source === "cache" && state.stale)).toBe(true)
    expect(states.some((state) => state.status === "refreshing" && state.stale)).toBe(true)
    resolveFetch(new Response(null, { status: 304 }))
    await initializing
    expect(states.at(-1)).toMatchObject({ source: "network", status: "ready", stale: false })
    client.destroy()
  })

  test("deduplicates manual refresh and retries with bounded exponential delays", async () => {
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      if (calls <= 2) throw new Error("offline")
      return response()
    }
    const { client } = setupClient({ maxRetries: 2 })
    const first = client.refresh()
    const duplicate = client.refresh()
    expect(first).toBe(duplicate)
    await first
    expect(calls).toBe(3)
    client.destroy()
  })

  test("keeps the latest accepted config when the server returns a lower version", async () => {
    let calls = 0
    globalThis.fetch = async () => response(calls++ === 0 ? 8 : 7)
    const { client, states, storage } = setupClient()

    await client.initialize()
    await client.refresh()

    expect(states.at(-1)).toMatchObject({
      configVersion: 8,
      status: "ready",
      error: "Rejected config version 7; latest accepted version is 8",
    })
    const scope = createCacheScope(CONFIG_URL, "pub_test")
    const binding = createPersistedCacheBinding(scope, {
      appId: "conformance",
      environment: "test",
    })
    expect(JSON.parse(storage.values.get(createCacheKey(scope, binding)) ?? "{}").version).toBe(8)
    client.destroy()
  })

  test("a stale asynchronous cache read cannot overwrite a fresher refresh", async () => {
    const storage = new TestStorage()
    seedCache(storage)
    const scope = createCacheScope(CONFIG_URL, "pub_test")
    const binding = createPersistedCacheBinding(scope, {
      appId: "conformance",
      environment: "test",
    })
    const delayed = delayCapturedRead(storage, createCacheKey(scope, binding))
    globalThis.fetch = async () => response(8)
    const { client, states } = setupClient({ storage })

    const initializing = client.initialize()
    await delayed.started
    await client.refresh()
    delayed.release()
    await initializing

    const acceptedVersions = states
      .map((entry) => entry.configVersion)
      .filter((version): version is number => version !== null)
    expect(acceptedVersions).not.toContain(conformanceConfig.configVersion)
    expect(states.at(-1)?.configVersion).toBe(8)
    client.destroy()
  })

  test("a delayed malformed cache read cannot delete a fresher published cache", async () => {
    const storage = new TestStorage()
    seedCache(storage)
    const scope = createCacheScope(CONFIG_URL, "pub_test")
    const binding = createPersistedCacheBinding(scope, {
      appId: "conformance",
      environment: "test",
    })
    const cacheKey = createCacheKey(scope, binding)
    storage.values.set(cacheKey, "{malformed")
    const delayed = delayCapturedRead(storage, cacheKey)
    globalThis.fetch = async () => response(8)
    const { client } = setupClient({ storage })

    const initializing = client.initialize()
    await delayed.started
    await client.refresh()
    delayed.release()
    await initializing

    expect(JSON.parse(storage.values.get(scope.bindingKey) ?? "{}")).toEqual(binding)
    expect(JSON.parse(storage.values.get(cacheKey) ?? "{}").version).toBe(8)
    client.destroy()
  })

  test("a delayed failed binding read cannot clear a fresher published binding", async () => {
    const storage = new TestStorage()
    const scope = createCacheScope(CONFIG_URL, "pub_test")
    const binding = createPersistedCacheBinding(scope, {
      appId: "conformance",
      environment: "test",
    })
    const delayed = delayRejectedRead(storage, scope.bindingKey)
    globalThis.fetch = async () => response(8)
    const { client } = setupClient({ storage })

    const initializing = client.initialize()
    await delayed.started
    await client.refresh()
    delayed.release()
    await initializing

    expect(JSON.parse(storage.values.get(scope.bindingKey) ?? "{}")).toEqual(binding)
    expect(JSON.parse(storage.values.get(createCacheKey(scope, binding)) ?? "{}").version).toBe(8)
    client.destroy()
  })

  test("never serves cache beyond maxStaleAgeSeconds", async () => {
    const storage = new TestStorage()
    seedCache(storage, Date.now() - 10_000)
    globalThis.fetch = async () => { throw new Error("offline") }
    const { client, states } = setupClient({ storage, maxStaleAgeSeconds: 1 })
    await client.initialize()
    expect(states.some((state) => state.source === "cache")).toBe(false)
    expect(states.at(-1)).toMatchObject({ source: "default", status: "error", config: null })
    expect(storage.removed.some((key) => key.startsWith("superflag:cache:v3"))).toBe(true)
    client.destroy()
  })

  test("withdraws a served cache when it crosses maxStaleAgeSeconds offline", async () => {
    const storage = new TestStorage()
    seedCache(storage)
    globalThis.fetch = async () => { throw new Error("offline") }
    const { client, states } = setupClient({
      storage,
      ttlSeconds: 60,
      maxStaleAgeSeconds: 0.02,
    })

    await client.initialize()
    expect(states.some((state) => state.source === "cache" && state.config !== null)).toBe(true)
    await Bun.sleep(60)
    expect(states.at(-1)).toMatchObject({ source: "default", status: "error", config: null })
    expect(storage.removed.some((key) => key.startsWith("superflag:cache:v3"))).toBe(true)
    client.destroy()
  })

  test("refreshes on visibility and online, then removes every listener", async () => {
    const documentTarget = new LifecycleTarget()
    const windowTarget = new LifecycleTarget()
    globalThis.document = documentTarget as unknown as Document
    globalThis.window = windowTarget as unknown as Window & typeof globalThis
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return response(calls + 6)
    }
    const { client } = setupClient()
    await client.initialize()
    expect(documentTarget.count("visibilitychange")).toBe(1)
    expect(windowTarget.count("online")).toBe(1)

    documentTarget.dispatch("visibilitychange")
    await Promise.resolve()
    await client.refresh()
    windowTarget.dispatch("online")
    await Promise.resolve()
    await client.refresh()
    expect(calls).toBeGreaterThanOrEqual(3)

    client.destroy()
    expect(documentTarget.count("visibilitychange")).toBe(0)
    expect(windowTarget.count("online")).toBe(0)
  })

  test("updates targetingKey, attributes, and the userId compatibility alias without refetching", async () => {
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return response()
    }
    const { client, states } = setupClient({ userId: "legacy-user" })
    await client.initialize()
    expect(states.at(-1)?.targetingKey).toBe("legacy-user")
    client.setContext({ targetingKey: "target", attributes: { plan: "pro" } })
    expect(states.at(-1)).toMatchObject({ targetingKey: "target", attributes: { plan: "pro" } })
    expect(calls).toBe(1)
    client.destroy()
  })

  test("isolates callback failures and reports them diagnostically", async () => {
    globalThis.fetch = async () => response()
    const diagnostics: SuperflagDiagnostic[] = []
    const client = createClient({
      clientKey: "pub_test",
      configUrl: CONFIG_URL,
      ttlSeconds: 60,
      maxStaleAgeSeconds: 60,
      maxRetries: 0,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
      storage: new TestStorage(),
      onStateChange: () => { throw new Error("state callback") },
      onReady: () => { throw new Error("ready callback") },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    await expect(client.initialize()).resolves.toBeUndefined()
    expect(diagnostics.filter((entry) => entry.code === "CALLBACK_ERROR").length).toBeGreaterThanOrEqual(2)
    client.destroy()
  })
})
