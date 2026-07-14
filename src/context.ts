import { createContext } from "react"
import type { EvaluationDetails, FlagValue as CoreFlagValue } from "@superflag-sh/core"
import type {
  SuperflagEvaluationDetails,
  SuperflagExposureEvent,
  SuperflagState,
} from "./types.js"

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
}

export const SuperflagContext: React.Context<SuperflagContextValue | null> =
  createContext<SuperflagContextValue | null>(null)

export function defaultEvaluation<T>(
  flagKey: string,
  fallback: T | undefined,
): SuperflagEvaluationDetails<T | undefined> {
  const base: Omit<
    EvaluationDetails<CoreFlagValue>,
    "value" | "source" | "configVersion"
  > = {
    flagKey,
    reason: "DEFAULT",
    errorCode: "FLAG_NOT_FOUND",
    errorMessage: `Flag ${flagKey} was not found`,
    segmentIds: [],
    prerequisites: [],
    timestamp: new Date().toISOString(),
  }
  return { ...base, value: fallback, source: "default", configVersion: null }
}

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
