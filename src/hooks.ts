import { useContext } from "react"
import { SuperflagContext } from "./context"
import type { SuperflagStatus } from "./types"

/**
 * Hook to get a single flag value.
 *
 * @param name - The flag name
 * @param fallback - Optional fallback value if flag is not found
 * @returns The flag value or fallback
 *
 * @example
 * ```tsx
 * const darkMode = useFlag("dark-mode", false)
 * const maxUploads = useFlag<number>("max-uploads", 5)
 * ```
 */
export function useFlag<T = unknown>(name: string, fallback?: T): T | undefined {
  const ctx = useContext(SuperflagContext)

  if (!ctx) {
    throw new Error("useFlag must be used within a SuperflagProvider")
  }

  const flag = ctx.flags[name]

  if (flag === undefined) {
    return fallback
  }

  return flag.value as T
}

/**
 * Hook to get the SDK state.
 *
 * @returns Object with ready, loading, and status properties
 *
 * @example
 * ```tsx
 * const { ready, loading, status } = useFlags()
 *
 * if (loading) return <Spinner />
 * if (status === "error") return <ErrorMessage />
 * ```
 */
export function useFlags(): {
  ready: boolean
  loading: boolean
  status: SuperflagStatus
} {
  const ctx = useContext(SuperflagContext)

  if (!ctx) {
    throw new Error("useFlags must be used within a SuperflagProvider")
  }

  return {
    ready: ctx.status === "ready",
    loading: ctx.status === "loading",
    status: ctx.status,
  }
}
