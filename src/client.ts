import type {
  SuperflagState,
  ClientConfig,
  ConfigResponse,
  CachedConfig,
  Flags,
  SuperflagClient,
} from "./types"
import { getStorage, CACHE_KEY } from "./storage"
import { initialState } from "./context"

const BASE_URL = "https://superflag.sh"

/**
 * Creates a Superflag client that manages flag fetching and caching
 */
export function createClient(config: ClientConfig): SuperflagClient {
  const { clientKey, ttlSeconds: _ttlSeconds, onStateChange, storage: customStorage } = config
  // ttlSeconds reserved for future periodic background refresh

  let state: SuperflagState = { ...initialState }
  let destroyed = false
  let fetchController: AbortController | null = null

  function setState(updates: Partial<SuperflagState>): void {
    if (destroyed) return
    state = { ...state, ...updates }
    onStateChange(state)
  }

  async function resolveStorage() {
    return customStorage ?? await getStorage()
  }

  async function loadFromCache(): Promise<CachedConfig | null> {
    try {
      const storage = await resolveStorage()
      const cached = await storage.getItem(CACHE_KEY)
      if (!cached) return null

      const parsed = JSON.parse(cached) as CachedConfig
      return parsed
    } catch {
      return null
    }
  }

  async function saveToCache(flags: Flags, version: number, etag: string): Promise<void> {
    try {
      const storage = await resolveStorage()
      const cache: CachedConfig = {
        flags,
        version,
        etag,
        fetchedAt: Date.now(),
      }
      await storage.setItem(CACHE_KEY, JSON.stringify(cache))
    } catch {
      // Ignore cache save errors
    }
  }

  async function fetchConfig(): Promise<void> {
    if (destroyed) return

    // Cancel any in-flight request
    if (fetchController) {
      fetchController.abort()
    }

    fetchController = new AbortController()

    // Only show loading if we don't have flags yet
    if (Object.keys(state.flags).length === 0) {
      setState({ status: "loading" })
    }

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${clientKey}`,
      }

      if (state.etag) {
        headers["If-None-Match"] = state.etag
      }

      const response = await fetch(`${BASE_URL}/api/v1/public-config`, {
        headers,
        signal: fetchController.signal,
      })

      if (destroyed) return

      // Handle 304 Not Modified
      if (response.status === 304) {
        setState({
          status: "ready",
          lastFetchedAt: Date.now(),
          error: null,
        })
        // Update cache fetchedAt
        if (state.version !== null && state.etag) {
          await saveToCache(state.flags, state.version, state.etag)
        }
        return
      }

      // Handle 401 Unauthorized
      if (response.status === 401) {
        const body = await response.json().catch(() => ({}))
        setState({
          status: "error",
          error: body.error || "Invalid or unauthorized client key",
        })
        return
      }

      // Handle 429 Rate Limited
      if (response.status === 429) {
        setState({
          status: "rate-limited",
          error: "Monthly quota exceeded",
        })
        return
      }

      // Handle other errors
      if (!response.ok) {
        setState({
          status: "error",
          error: `Server error: ${response.status}`,
        })
        return
      }

      // Parse successful response
      const data = (await response.json()) as ConfigResponse
      const etag = response.headers.get("ETag") || `"${data.version}"`

      setState({
        flags: data.doc.flags,
        status: "ready",
        version: data.version,
        etag: etag,
        lastFetchedAt: Date.now(),
        error: null,
      })

      await saveToCache(data.doc.flags, data.version, etag)
    } catch (err) {
      if (destroyed) return

      // Ignore abort errors
      if (err instanceof Error && err.name === "AbortError") {
        return
      }

      // Network or other error - keep existing flags if we have them
      setState({
        status: state.flags && Object.keys(state.flags).length > 0 ? "ready" : "error",
        error: err instanceof Error ? err.message : "Network error",
      })
    } finally {
      fetchController = null
    }
  }

  async function initialize(): Promise<void> {
    if (destroyed) return

    // Load from cache first
    const cached = await loadFromCache()

    if (cached) {
      // Show cached data immediately
      setState({
        flags: cached.flags,
        status: "ready",
        version: cached.version,
        etag: cached.etag,
        lastFetchedAt: cached.fetchedAt,
      })
    }

    // Always fetch on app start - ETag ensures we only download if changed
    // This guarantees users see fresh values on refresh
    await fetchConfig()
  }

  function destroy(): void {
    destroyed = true
    if (fetchController) {
      fetchController.abort()
      fetchController = null
    }
  }

  return {
    initialize: initialize,
    destroy: destroy,
    refetch: fetchConfig,
  }
}
