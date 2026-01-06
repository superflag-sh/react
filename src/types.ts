/**
 * Flag value types supported by Superflag
 */
export type FlagType = "bool" | "string" | "number" | "json"

/**
 * A single flag value as returned from the server
 */
export interface FlagValue {
  type: FlagType
  value: boolean | string | number | object
}

/**
 * The flags record type
 */
export type Flags = Record<string, FlagValue>

/**
 * SDK status states
 */
export type SuperflagStatus = "idle" | "loading" | "ready" | "error" | "rate-limited"

/**
 * Internal state managed by the SDK
 */
export interface SuperflagState {
  flags: Flags
  status: SuperflagStatus
  version: number | null
  etag: string | null
  lastFetchedAt: number | null
  error: string | null
}

/**
 * Props for the SuperflagProvider component
 */
export interface SuperflagProviderProps {
  /**
   * Client key for authentication.
   * Falls back to process.env.EXPO_PUBLIC_SUPERFLAG_CLIENT_KEY if not provided.
   */
  clientKey?: string
  /**
   * Time-to-live in seconds before refetching config.
   * @default 60
   */
  ttlSeconds?: number
  /**
   * Custom storage adapter. If not provided, auto-detects based on environment.
   * Use this to integrate with expo-sqlite, MMKV, or any other storage.
   */
  storage?: StorageAdapter
  /**
   * React children
   */
  children: React.ReactNode
}

/**
 * Configuration response from the server
 */
export interface ConfigResponse {
  appId: string
  env: string
  version: number
  doc: {
    flags: Flags
    overrides: Record<string, unknown>
    rules: Record<string, unknown>
  }
  ttlSeconds: number
}

/**
 * Cached config structure stored in storage
 */
export interface CachedConfig {
  flags: Flags
  version: number
  etag: string
  fetchedAt: number
}

/**
 * Storage adapter interface for cross-platform storage
 */
export interface StorageAdapter {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

/**
 * Client configuration options
 */
export interface ClientConfig {
  clientKey: string
  ttlSeconds: number
  onStateChange: (state: SuperflagState) => void
  storage?: StorageAdapter
}

/**
 * Superflag client interface
 */
export interface SuperflagClient {
  initialize: () => Promise<void>
  destroy: () => void
  refetch: () => Promise<void>
}
