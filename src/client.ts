import { migrateLegacyFlags, parseConfig } from "@superflag-sh/core"
import type { LegacyFlagValue } from "@superflag-sh/core"
import type { EvaluationContext, FlagConfig } from "@superflag-sh/core"
import type {
  CachedConfig,
  ClientConfig,
  RefreshReason,
  StorageAdapter,
  SuperflagClient,
  SuperflagDiagnostic,
  SuperflagReadyInfo,
  SuperflagState,
} from "./types.js"
import {
  CACHE_SCHEMA_VERSION,
  LEGACY_CACHE_KEYS,
  createCacheKey,
  createCacheScope,
  createPersistedCacheBinding,
  isIdentityBoundCacheEntry,
  isPersistedCacheBinding,
  type PersistedCacheBinding,
} from "@superflag-sh/core"
import { getStorage } from "./storage/index.js"
import { initialState } from "./context.js"

const DEFAULT_CONFIG_URL = "https://superflag.sh/api/v1/public-config"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

interface ParsedResponse {
  appId: string
  environment: string
  version: number
  config: FlagConfig
  etag: string
}

function parseResponse(value: unknown, etag: string | null): ParsedResponse {
  if (
    !isRecord(value) ||
    typeof value.appId !== "string" ||
    value.appId.length === 0 ||
    typeof value.env !== "string" ||
    value.env.length === 0 ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 0
  ) {
    throw new TypeError("Invalid config response identity")
  }

  let coreConfig: FlagConfig
  try {
    coreConfig = parseConfig(value.doc)
  } catch (coreError) {
    if (!isRecord(value.doc) || !isRecord(value.doc.flags)) throw coreError
    coreConfig = migrateLegacyFlags(
      value.doc.flags as Readonly<Record<string, LegacyFlagValue>>,
      {
        source: { app: value.appId, environment: value.env },
        configVersion: value.version as number,
      },
    )
  }
  if (
    coreConfig.source.app !== value.appId ||
    coreConfig.source.environment !== value.env ||
    coreConfig.configVersion !== value.version
  ) {
    throw new TypeError("Config document metadata does not match response identity")
  }

  return {
    appId: value.appId,
    environment: value.env,
    version: value.version as number,
    config: coreConfig,
    etag: etag || `"${String(value.version)}"`,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

/** Browser transport/cache lifecycle. Flag semantics remain owned by @superflag-sh/core. */
export function createClient(config: ClientConfig): SuperflagClient {
  const {
    clientKey,
    onStateChange,
    storage: customStorage,
    ttlSeconds = 60,
    maxStaleAgeSeconds = 86_400,
    maxRetries = 2,
    retryBaseDelayMs = 250,
    retryMaxDelayMs = 5_000,
  } = config
  const scope = createCacheScope(config.configUrl ?? DEFAULT_CONFIG_URL, clientKey)
  const context: { targetingKey?: string; attributes?: EvaluationContext["attributes"]; userId?: string } = {
    targetingKey: config.targetingKey,
    attributes: config.attributes,
    userId: config.userId,
  }

  let state: SuperflagState = {
    ...initialState,
    targetingKey: context.targetingKey ?? context.userId,
    attributes: context.attributes,
    userId: context.userId,
    refresh: manualRefresh,
  }
  let destroyed = false
  let initialized = false
  let listenersAttached = false
  let readyNotified = false
  let fetchController: AbortController | null = null
  let refreshPromise: Promise<void> | null = null
  let initializePromise: Promise<void> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryResolve: (() => void) | null = null
  let ttlTimer: ReturnType<typeof setTimeout> | null = null
  let maxStaleTimer: ReturnType<typeof setTimeout> | null = null
  let resolvedStorage: StorageAdapter | null = null
  let activeBinding: PersistedCacheBinding | null = null
  let activeCache: CachedConfig | null = null
  let configPublication = 0

  function emitDiagnostic(diagnostic: SuperflagDiagnostic): void {
    try {
      config.onDiagnostic?.(diagnostic)
    } catch {
      // A diagnostic callback cannot safely diagnose itself.
    }
  }

  function publish(next: SuperflagState): void {
    if (destroyed) return
    state = next
    try {
      onStateChange(state)
    } catch (cause) {
      emitDiagnostic({
        code: "CALLBACK_ERROR",
        message: "onStateChange callback threw",
        severity: "error",
        cause,
      })
    }
  }

  function setState(updates: Partial<SuperflagState>): void {
    publish({ ...state, ...updates })
  }

  function currentAge(fetchedAt = state.fetchedAt): number | null {
    return fetchedAt === null ? null : Math.max(0, Date.now() - fetchedAt) / 1000
  }

  function isStale(fetchedAt = state.fetchedAt): boolean {
    const age = currentAge(fetchedAt)
    return age !== null && age >= ttlSeconds
  }

  function exceedsMaxStale(fetchedAt: number): boolean {
    return currentAge(fetchedAt)! > maxStaleAgeSeconds
  }

  function contextState(): Pick<SuperflagState, "targetingKey" | "attributes" | "userId"> {
    return {
      targetingKey: context.targetingKey ?? context.userId,
      attributes: context.attributes,
      userId: context.userId,
    }
  }

  function emptyState(status: SuperflagState["status"], error: string | null): SuperflagState {
    return {
      ...initialState,
      ...contextState(),
      status,
      error,
      refresh: manualRefresh,
    }
  }

  function resolveStorage(): StorageAdapter {
    if (resolvedStorage) return resolvedStorage
    resolvedStorage = customStorage ?? getStorage()
    return resolvedStorage
  }

  async function removeCacheKeys(keys: readonly string[]): Promise<void> {
    const cacheStorage = resolveStorage()
    for (const key of keys) {
      try {
        await cacheStorage.removeItem(key)
      } catch {
        // Storage is an optimization; failures never break initialization.
      }
    }
  }

  async function clearActiveCache(binding = activeBinding): Promise<void> {
    clearMaxStaleTimer()
    activeCache = null
    if (binding) await removeCacheKeys([createCacheKey(scope, binding)])
  }

  async function clearBindingAndCache(): Promise<void> {
    const binding = activeBinding
    activeBinding = null
    await clearActiveCache(binding)
    await removeCacheKeys([scope.bindingKey])
  }

  function cacheLoadIsCurrent(expectedPublication: number): boolean {
    return configPublication === expectedPublication && refreshPromise === null
  }

  async function loadFromCache(
    expectedPublication: number,
  ): Promise<CachedConfig | null> {
    await removeCacheKeys([...LEGACY_CACHE_KEYS, scope.legacyCacheKey])

    let storedBinding: string | null
    try {
      storedBinding = await resolveStorage().getItem(scope.bindingKey)
    } catch {
      if (!cacheLoadIsCurrent(expectedPublication)) return null
      return null
    }
    if (!cacheLoadIsCurrent(expectedPublication)) return null
    if (!storedBinding) return null

    let parsedBinding: unknown
    try {
      parsedBinding = JSON.parse(storedBinding)
    } catch {
      if (cacheLoadIsCurrent(expectedPublication)) {
        await removeCacheKeys([scope.bindingKey])
      }
      return null
    }
    if (!isPersistedCacheBinding(parsedBinding, scope)) {
      if (cacheLoadIsCurrent(expectedPublication)) {
        await removeCacheKeys([scope.bindingKey])
      }
      return null
    }
    const cacheKey = createCacheKey(scope, parsedBinding)
    let storedCache: string | null
    try {
      storedCache = await resolveStorage().getItem(cacheKey)
    } catch {
      if (!cacheLoadIsCurrent(expectedPublication)) return null
      return null
    }
    if (!cacheLoadIsCurrent(expectedPublication)) return null
    if (!storedCache) {
      activeBinding = parsedBinding
      return null
    }

    let parsedCache: unknown
    try {
      parsedCache = JSON.parse(storedCache)
    } catch {
      if (cacheLoadIsCurrent(expectedPublication)) {
        await removeCacheKeys([cacheKey])
      }
      return null
    }
    if (!isIdentityBoundCacheEntry(parsedCache, scope, parsedBinding)) {
      if (cacheLoadIsCurrent(expectedPublication)) {
        await removeCacheKeys([cacheKey])
      }
      return null
    }

    let loadedCache: CachedConfig
    try {
      const cached = parsedCache as CachedConfig
      const coreConfig = parseConfig(cached.config)
      if (
        coreConfig.source.app !== parsedBinding.appId ||
        coreConfig.source.environment !== parsedBinding.environment ||
        coreConfig.configVersion !== cached.version
      ) {
        throw new TypeError("Cached config metadata does not match its identity binding")
      }
      loadedCache = { ...cached, config: coreConfig, flags: coreConfig.flags }
    } catch (cause) {
      emitDiagnostic({
        code: "CACHE_INVALID",
        message: "Cached configuration failed core validation",
        severity: "warning",
        cause,
      })
      if (cacheLoadIsCurrent(expectedPublication)) {
        await removeCacheKeys([cacheKey])
      }
      return null
    }

    if (exceedsMaxStale(loadedCache.fetchedAt)) {
      emitDiagnostic({
        code: "CACHE_EXPIRED",
        message: `Cached configuration exceeded maxStaleAgeSeconds (${maxStaleAgeSeconds})`,
        severity: "warning",
      })
      if (cacheLoadIsCurrent(expectedPublication)) {
        await removeCacheKeys([cacheKey])
      }
      return null
    }
    if (!cacheLoadIsCurrent(expectedPublication)) return null
    activeBinding = parsedBinding
    activeCache = loadedCache
    return loadedCache
  }

  async function establishBinding(
    appId: string,
    environment: string,
  ): Promise<PersistedCacheBinding> {
    const binding = createPersistedCacheBinding(scope, { appId, environment })
    activeBinding = binding
    try {
      await resolveStorage().setItem(scope.bindingKey, JSON.stringify(binding))
    } catch {
      // The authenticated response still establishes a session-only binding.
    }
    return binding
  }

  async function saveToCache(
    binding: PersistedCacheBinding,
    coreConfig: FlagConfig,
    version: number,
    etag: string,
    fetchedAt = Date.now(),
  ): Promise<CachedConfig> {
    const cache: CachedConfig = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      endpointFingerprint: scope.endpointFingerprint,
      clientKeyFingerprint: scope.clientKeyFingerprint,
      appId: binding.appId,
      environment: binding.environment,
      flags: coreConfig.flags,
      config: coreConfig,
      version,
      etag,
      fetchedAt,
    }
    activeCache = cache
    try {
      await resolveStorage().setItem(createCacheKey(scope, binding), JSON.stringify(cache))
    } catch {
      // The in-memory cache remains identity-bound for this session.
    }
    return cache
  }

  function getActiveIdentity(): CachedConfig | null {
    const cache = activeCache
    if (
      activeBinding &&
      cache &&
      cache.appId === activeBinding.appId &&
      cache.environment === activeBinding.environment &&
      state.appId === cache.appId &&
      state.environment === cache.environment &&
      state.configVersion === cache.version &&
      state.etag === cache.etag
    ) {
      return cache
    }
    return null
  }

  function notifyReady(info: SuperflagReadyInfo): void {
    if (readyNotified) return
    readyNotified = true
    try {
      config.onReady?.(info)
    } catch (cause) {
      emitDiagnostic({
        code: "CALLBACK_ERROR",
        message: "onReady callback threw",
        severity: "error",
        cause,
      })
    }
  }

  function publishConfig(cache: CachedConfig, source: "cache" | "network"): void {
    configPublication += 1
    const age = currentAge(cache.fetchedAt)
    const stale = isStale(cache.fetchedAt)
    publish({
      ...state,
      ...contextState(),
      config: cache.config,
      flags: cache.config.flags,
      status: stale ? "stale" : "ready",
      source,
      appId: cache.appId,
      environment: cache.environment,
      version: cache.version,
      configVersion: cache.version,
      etag: cache.etag,
      lastFetchedAt: cache.fetchedAt,
      fetchedAt: cache.fetchedAt,
      age,
      stale,
      error: null,
      refresh: manualRefresh,
    })
    notifyReady({
      source,
      fetchedAt: cache.fetchedAt,
      configVersion: cache.version,
      appId: cache.appId,
      environment: cache.environment,
    })
    scheduleMaxStaleExpiry(cache.fetchedAt)
  }

  function clearTtlTimer(): void {
    if (ttlTimer) clearTimeout(ttlTimer)
    ttlTimer = null
  }

  function clearMaxStaleTimer(): void {
    if (maxStaleTimer) clearTimeout(maxStaleTimer)
    maxStaleTimer = null
  }

  function scheduleMaxStaleExpiry(fetchedAt: number): void {
    clearMaxStaleTimer()
    if (destroyed || !state.config) return
    const delay = Math.max(1, fetchedAt + maxStaleAgeSeconds * 1_000 - Date.now() + 1)
    maxStaleTimer = setTimeout(() => {
      maxStaleTimer = null
      if (destroyed || state.fetchedAt !== fetchedAt || !state.config) return
      emitDiagnostic({
        code: "CACHE_EXPIRED",
        message: `Cached configuration exceeded maxStaleAgeSeconds (${maxStaleAgeSeconds})`,
        severity: "warning",
      })
      void clearActiveCache().finally(() => {
        if (!destroyed && state.fetchedAt === fetchedAt) {
          publish(emptyState("error", "Cached configuration exceeded maximum stale age"))
        }
      })
    }, delay)
  }

  function scheduleRefresh(from = state.fetchedAt ?? Date.now()): void {
    clearTtlTimer()
    if (destroyed || !state.config) return
    const ttlMs = Math.max(1, ttlSeconds * 1_000)
    const delay = Math.max(0, from + ttlMs - Date.now())
    ttlTimer = setTimeout(() => {
      ttlTimer = null
      void refresh("ttl")
    }, delay)
  }

  function waitForRetry(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      retryResolve = resolve
      retryTimer = setTimeout(() => {
        retryTimer = null
        retryResolve = null
        resolve()
      }, delayMs)
    })
  }

  function retryDelay(attempt: number): number {
    return Math.min(retryMaxDelayMs, retryBaseDelayMs * 2 ** attempt)
  }

  async function publishFailure(message: string, rateLimited = false): Promise<void> {
    const fetchedAt = state.fetchedAt
    if (state.config && fetchedAt !== null && !exceedsMaxStale(fetchedAt)) {
      const age = currentAge(fetchedAt)
      const stale = isStale(fetchedAt)
      setState({
        status: rateLimited ? "rate-limited" : stale ? "stale" : "ready",
        source: "cache",
        error: message,
        age,
        stale,
      })
      scheduleRefresh(Date.now())
      return
    }

    if (state.config) await clearActiveCache()
    publish(emptyState(rateLimited ? "rate-limited" : "error", message))
  }

  async function performRefresh(reason: RefreshReason): Promise<void> {
    if (destroyed) return
    clearTtlTimer()
    const hasConfig = state.config !== null
    setState({
      status: hasConfig ? "refreshing" : "loading",
      age: currentAge(),
      stale: isStale(),
      error: null,
    })

    fetchController = typeof AbortController === "undefined" ? null : new AbortController()
    let allowConditional = true
    let recoveredMissing304Cache = false
    let finalError = "Network error"
    let finalRateLimited = false

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (destroyed) return
      try {
        const headers: Record<string, string> = { Authorization: `Bearer ${clientKey}` }
        const requestCache = allowConditional ? getActiveIdentity() : null
        if (requestCache) headers["If-None-Match"] = requestCache.etag

        const response = await fetch(scope.configUrl, {
          headers,
          signal: fetchController?.signal,
        })
        if (destroyed) return

        if (response.status === 304) {
          const responseCache = getActiveIdentity()
          if (!responseCache && !recoveredMissing304Cache) {
            recoveredMissing304Cache = true
            allowConditional = false
            await clearActiveCache()
            publish(emptyState("loading", null))
            attempt -= 1
            continue
          }
          if (!responseCache) {
            finalError = "Received 304 without an identity-bound cache entry"
            break
          }
          const refreshed = await saveToCache(
            activeBinding!,
            responseCache.config,
            responseCache.version,
            responseCache.etag,
          )
          publishConfig(refreshed, "network")
          scheduleRefresh(refreshed.fetchedAt)
          return
        }

        if (response.status === 401) {
          const body = (await response.json().catch(() => ({}))) as { error?: string }
          await clearBindingAndCache()
          publish(emptyState("error", body.error || "Invalid or unauthorized client key"))
          return
        }

        if (retryableStatus(response.status)) {
          finalRateLimited = response.status === 429
          finalError = finalRateLimited ? "Monthly quota exceeded" : `Server error: ${response.status}`
          if (attempt < maxRetries) {
            const delay = retryDelay(attempt)
            emitDiagnostic({
              code: "RETRY_SCHEDULED",
              message: `${finalError}; retrying in ${delay}ms`,
              severity: "warning",
              attempt: attempt + 1,
            })
            await waitForRetry(delay)
            continue
          }
          break
        }

        if (!response.ok) {
          finalError = `Server error: ${response.status}`
          break
        }

        let parsed: ParsedResponse
        try {
          parsed = parseResponse(await response.json(), response.headers.get("ETag"))
        } catch (cause) {
          finalError = errorMessage(cause)
          emitDiagnostic({
            code: "CONFIG_INVALID",
            message: finalError,
            severity: "error",
            cause,
          })
          break
        }

        if (
          activeBinding &&
          (activeBinding.appId !== parsed.appId || activeBinding.environment !== parsed.environment)
        ) {
          await clearBindingAndCache()
          publish(emptyState("error", "Authenticated config identity changed for bound client key"))
          return
        }

        const latestVersion = Math.max(
          activeCache?.version ?? -1,
          state.configVersion ?? -1,
        )
        if (parsed.version < latestVersion) {
          finalError = `Rejected config version ${parsed.version}; latest accepted version is ${latestVersion}`
          emitDiagnostic({
            code: "CONFIG_INVALID",
            message: finalError,
            severity: "error",
          })
          break
        }

        const binding = activeBinding ?? (await establishBinding(parsed.appId, parsed.environment))
        const saved = await saveToCache(
          binding,
          parsed.config,
          parsed.version,
          parsed.etag,
        )
        publishConfig(saved, "network")
        scheduleRefresh(saved.fetchedAt)
        return
      } catch (cause) {
        if (destroyed || (cause instanceof Error && cause.name === "AbortError")) return
        finalError = errorMessage(cause)
        if (attempt < maxRetries) {
          const delay = retryDelay(attempt)
          emitDiagnostic({
            code: "RETRY_SCHEDULED",
            message: `${finalError}; retrying in ${delay}ms`,
            severity: "warning",
            attempt: attempt + 1,
            cause,
          })
          await waitForRetry(delay)
          continue
        }
        break
      }
    }

    emitDiagnostic({
      code: "FETCH_ERROR",
      message: `${reason} refresh failed: ${finalError}`,
      severity: "error",
    })
    await publishFailure(finalError, finalRateLimited)
  }

  function refresh(reason: RefreshReason): Promise<void> {
    if (destroyed) return Promise.resolve()
    if (refreshPromise) return refreshPromise
    refreshPromise = performRefresh(reason).finally(() => {
      refreshPromise = null
      fetchController = null
    })
    return refreshPromise
  }

  function manualRefresh(): Promise<void> {
    return refresh("manual")
  }

  function onVisibilityChange(): void {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      void refresh("visibility")
    }
  }

  function onOnline(): void {
    void refresh("online")
  }

  function attachListeners(): void {
    if (listenersAttached) return
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange)
    }
    if (typeof window !== "undefined") window.addEventListener("online", onOnline)
    listenersAttached = true
  }

  function removeListeners(): void {
    if (!listenersAttached) return
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
    if (typeof window !== "undefined") window.removeEventListener("online", onOnline)
    listenersAttached = false
  }

  async function initializeInternal(): Promise<void> {
    if (destroyed || initialized) return
    initialized = true
    attachListeners()
    try {
      const publicationBeforeCacheLoad = configPublication
      const cached = await loadFromCache(publicationBeforeCacheLoad)
      if (cached) {
        publishConfig(cached, "cache")
      } else if (configPublication !== publicationBeforeCacheLoad) {
        return
      }
      await refresh("initial")
    } catch (cause) {
      emitDiagnostic({
        code: "FETCH_ERROR",
        message: `Initialization failed: ${errorMessage(cause)}`,
        severity: "error",
        cause,
      })
      await publishFailure("Failed to initialize")
    }
  }

  function initialize(): Promise<void> {
    initializePromise ??= initializeInternal()
    return initializePromise
  }

  function setContext(next: Partial<EvaluationContext> & { userId?: string }): void {
    if ("targetingKey" in next) context.targetingKey = next.targetingKey
    if ("attributes" in next) context.attributes = next.attributes
    if ("userId" in next) context.userId = next.userId
    setState(contextState())
  }

  function destroy(): void {
    if (destroyed) return
    destroyed = true
    clearTtlTimer()
    clearMaxStaleTimer()
    removeListeners()
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    retryResolve?.()
    retryResolve = null
    fetchController?.abort()
    fetchController = null
  }

  return {
    initialize,
    destroy,
    refresh: manualRefresh,
    refetch: manualRefresh,
    setContext,
  }
}
