import type { StorageAdapter } from "../types"

/**
 * Web localStorage adapter.
 * Used in browser environments.
 */
export const webStorage: StorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },

  async setItem(key: string, value: string): Promise<void> {
    try {
      localStorage.setItem(key, value)
    } catch {
      // Storage might be full or disabled
    }
  },

  async removeItem(key: string): Promise<void> {
    try {
      localStorage.removeItem(key)
    } catch {
      // Ignore errors
    }
  },
}
