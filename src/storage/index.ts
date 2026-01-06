import type { StorageAdapter } from "../types"
import { memoryStorage } from "./memory"
import { webStorage } from "./web"
import { nativeStorage, isNativeStorageAvailable } from "./native"

export type { StorageAdapter }
export { memoryStorage, webStorage, nativeStorage }

/**
 * Cache key used for storing config
 */
export const CACHE_KEY = "superflag:cache:v1"

let resolvedStorage: StorageAdapter | null = null

/**
 * Check if we're running in React Native
 */
function isReactNative(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.product === "ReactNative"
  )
}

/**
 * Auto-detect and return the appropriate storage adapter.
 * Priority:
 * 1. React Native AsyncStorage (if in RN environment)
 * 2. Web localStorage (if in browser)
 * 3. In-memory fallback
 */
export async function getStorage(): Promise<StorageAdapter> {
  if (resolvedStorage) {
    return resolvedStorage
  }

  // Check for React Native FIRST
  if (isReactNative()) {
    if (await isNativeStorageAvailable()) {
      resolvedStorage = nativeStorage
      return resolvedStorage
    }
    // RN but no AsyncStorage installed
    if (process.env.NODE_ENV === "development") {
      console.warn(
        "[superflag] React Native detected but AsyncStorage not available. " +
          "Install @react-native-async-storage/async-storage for persistent caching."
      )
    }
    resolvedStorage = memoryStorage
    return resolvedStorage
  }

  // Check for web environment
  if (typeof window !== "undefined" && typeof window.localStorage !== "undefined") {
    try {
      // Test if localStorage is actually usable
      const testKey = "__superflag_test__"
      window.localStorage.setItem(testKey, "1")
      window.localStorage.removeItem(testKey)
      resolvedStorage = webStorage
      return resolvedStorage
    } catch {
      // localStorage might be disabled
    }
  }

  // Fall back to memory storage
  if (process.env.NODE_ENV === "development") {
    console.warn(
      "[superflag] No persistent storage available. Using in-memory storage."
    )
  }

  resolvedStorage = memoryStorage
  return resolvedStorage
}
