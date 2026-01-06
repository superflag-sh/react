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
  children,
}: SuperflagProviderProps): JSX.Element {
  // Try to get key from props or environment
  const clientKey = propKey ?? (typeof process !== "undefined" ? process.env.EXPO_PUBLIC_SUPERFLAG_CLIENT_KEY : undefined)

  if (!clientKey) {
    throw new Error(
      "SuperflagProvider requires a clientKey prop or EXPO_PUBLIC_SUPERFLAG_CLIENT_KEY environment variable"
    )
  }

  const [state, setState] = useState<SuperflagState>(initialState)

  useEffect(() => {
    const client = createClient({
      clientKey,
      ttlSeconds,
      storage,
      onStateChange: setState,
    })

    client.initialize()

    return () => {
      client.destroy()
    }
  }, [clientKey, ttlSeconds, storage])

  return (
    <SuperflagContext.Provider value={state}>
      {children}
    </SuperflagContext.Provider>
  )
}
