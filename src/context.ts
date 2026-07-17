import { createContext } from "react"
import type {
  SuperflagEvaluationDetails,
  SuperflagExposureEvent,
  SuperflagState,
  SuperflagTrackOptions,
  SuperflagTrackResult,
} from "./types.js"
import type { TelemetryFlushResult, TelemetryShutdownResult } from "@superflag-sh/core"

const noRefresh = async (): Promise<void> => {}

export const initialState: SuperflagState = {
  config: null,
  flags: {},
  status: "idle",
  source: "default",
  appId: null,
  environment: null,
  version: null,
  configVersion: null,
  etag: null,
  lastFetchedAt: null,
  fetchedAt: null,
  age: null,
  stale: false,
  error: null,
  refresh: noRefresh,
}

export interface SuperflagContextValue extends SuperflagState {
  evaluate: <T>(flagKey: string, fallback?: T) => SuperflagEvaluationDetails<T | undefined>
  recordEvaluation: (
    details: SuperflagEvaluationDetails<unknown>,
    exposed: boolean,
  ) => void
  track: (
    flagKey: string,
    metricKey: string,
    value?: number,
    options?: SuperflagTrackOptions,
  ) => Promise<SuperflagTrackResult>
  flush: () => Promise<TelemetryFlushResult>
  shutdown: (options?: {
    flush?: boolean
    timeoutMs?: number
  }) => Promise<TelemetryShutdownResult>
}

export const SuperflagContext: React.Context<SuperflagContextValue | null> =
  createContext<SuperflagContextValue | null>(null)

export function toExposureEvent(
  details: SuperflagEvaluationDetails<unknown>,
): SuperflagExposureEvent {
  return {
    flagKey: details.flagKey,
    variation: details.variation,
    reason: details.reason,
    source: details.source,
    configVersion: details.configVersion,
    timestamp: details.timestamp,
  }
}
