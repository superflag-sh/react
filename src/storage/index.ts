import type { StorageAdapter } from "../types"
import { memoryStorage } from "./memory"
import { webStorage } from "./web"

export type { StorageAdapter }
export { memoryStorage, webStorage }

/**
 * Cache key used for storing config
 */
export const CACHE_KEY = "superflag:cache:v1"

let resolvedStorage: StorageAdapter | null = null

/**
 * Get the appropriate storage adapter for web environments.
 * Uses localStorage if available, otherwise falls back to memory.
 */
export function getStorage(): StorageAdapter {
  if (resolvedStorage) {
    return resolvedStorage
  }

  // Check for localStorage (browser environment)
  if (typeof window !== "undefined" && typeof window.localStorage !== "undefined") {
    try {
      const testKey = "__superflag_test__"
      window.localStorage.setItem(testKey, "1")
      window.localStorage.removeItem(testKey)
      resolvedStorage = webStorage
      return resolvedStorage
    } catch {
      // localStorage might be disabled (private browsing, etc.)
    }
  }

  // Fall back to memory storage (SSR, localStorage disabled, etc.)
  resolvedStorage = memoryStorage
  return resolvedStorage
}
