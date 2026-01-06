import type { StorageAdapter } from "../types"

/**
 * React Native AsyncStorage adapter.
 * Dynamically imports AsyncStorage to avoid bundling issues.
 */

let asyncStorageModule: typeof import("@react-native-async-storage/async-storage").default | null = null
let loadAttempted = false

async function getAsyncStorage(): Promise<typeof asyncStorageModule> {
  if (loadAttempted) {
    return asyncStorageModule
  }

  loadAttempted = true

  try {
    const module = await import("@react-native-async-storage/async-storage")
    asyncStorageModule = module.default
    return asyncStorageModule
  } catch {
    return null
  }
}

export const nativeStorage: StorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    const storage = await getAsyncStorage()
    if (!storage) return null

    try {
      return await storage.getItem(key)
    } catch {
      return null
    }
  },

  async setItem(key: string, value: string): Promise<void> {
    const storage = await getAsyncStorage()
    if (!storage) return

    try {
      await storage.setItem(key, value)
    } catch {
      // Ignore errors
    }
  },

  async removeItem(key: string): Promise<void> {
    const storage = await getAsyncStorage()
    if (!storage) return

    try {
      await storage.removeItem(key)
    } catch {
      // Ignore errors
    }
  },
}

/**
 * Check if AsyncStorage is available
 */
export async function isNativeStorageAvailable(): Promise<boolean> {
  const storage = await getAsyncStorage()
  return storage !== null
}
