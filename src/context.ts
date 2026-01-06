import { createContext } from "react"
import type { SuperflagState } from "./types"

/**
 * Initial state for the SDK
 */
export const initialState: SuperflagState = {
  flags: {},
  status: "idle",
  version: null,
  etag: null,
  lastFetchedAt: null,
  error: null,
}

/**
 * React context for Superflag state
 */
export const SuperflagContext: React.Context<SuperflagState | null> = createContext<SuperflagState | null>(null)
