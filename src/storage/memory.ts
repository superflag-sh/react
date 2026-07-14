import type { StorageAdapter } from "../types.js"

/**
 * In-memory storage adapter.
 * Used as a fallback when localStorage and AsyncStorage are unavailable.
 * Data does not persist across sessions.
 */
const store = new Map<string, string>()

export const memoryStorage: StorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    return store.get(key) ?? null
  },

  async setItem(key: string, value: string): Promise<void> {
    store.set(key, value)
  },

  async removeItem(key: string): Promise<void> {
    store.delete(key)
  },
}
