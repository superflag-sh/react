import { useState, useEffect } from "react"
import type { SuperflagProviderProps, SuperflagState } from "./types"
import { SuperflagContext, initialState } from "./context"
import { createClient } from "./client"

/**
 * Provides Superflag context to the component tree.
 *
 * @example
 * ```tsx
 * <SuperflagProvider clientKey="pub_prod_abc123">
 *   <App />
 * </SuperflagProvider>
 * ```
 */
export function SuperflagProvider({
  clientKey: propKey,
  ttlSeconds = 60,
  storage,
  userId,
  children,
}: SuperflagProviderProps): JSX.Element {
  // Try to get key from props or environment
  const clientKey = propKey ?? (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_SUPERFLAG_CLIENT_KEY : undefined)

  const [state, setState] = useState<SuperflagState>(() => {
    if (!clientKey) {
      return {
        ...initialState,
        status: "error",
        error: "Missing clientKey prop or NEXT_PUBLIC_SUPERFLAG_CLIENT_KEY",
      }
    }
    return initialState
  })

  useEffect(() => {
    if (!clientKey) return

    try {
      const client = createClient({
        clientKey,
        ttlSeconds,
        storage,
        userId,
        onStateChange: setState,
      })

      client.initialize().catch(() => {
        // Initialization errors are handled inside initialize()
      })

      return () => {
        client.destroy()
      }
    } catch {
      setState({
        ...initialState,
        status: "error",
        error: "Failed to create client",
      })
    }
  }, [clientKey, ttlSeconds, storage, userId])

  return (
    <SuperflagContext.Provider value={state}>
      {children}
    </SuperflagContext.Provider>
  )
}
