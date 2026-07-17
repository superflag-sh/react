import { createEvaluator } from "@superflag-sh/core"
import type {
  EvaluationContext,
  EvaluationDetails,
  FlagConfig,
  FlagValue as CoreFlagValue,
} from "@superflag-sh/core"
import type {
  SuperflagEvaluationDetails,
  SuperflagSource,
} from "./types.js"

export type EvaluateFlag = <T>(
  flagKey: string,
  fallback?: T,
) => SuperflagEvaluationDetails<T | undefined>

export interface EvaluationReaderState {
  config: FlagConfig | null
  context: EvaluationContext
  source: SuperflagSource
  configVersion: number | null
}

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

/**
 * Create the React adapter's evaluation reader once per provider state change.
 * Core owns flag semantics; this module owns React fallback and diagnostic projection.
 */
export function createEvaluationReader(state: EvaluationReaderState): EvaluateFlag {
  if (!state.config) return defaultEvaluation

  const evaluator = createEvaluator(state.config)
  return <T>(
    flagKey: string,
    fallback?: T,
  ): SuperflagEvaluationDetails<T | undefined> => {
    const flag = state.config?.flags[flagKey]
    const safeFallback =
      fallback ?? (flag ? flag.variations[flag.offVariation]?.value : undefined)
    if (safeFallback === undefined) return defaultEvaluation(flagKey, fallback)

    const details = evaluator.evaluate(
      flagKey as never,
      state.context,
      safeFallback as never,
    )
    return {
      ...details,
      value: details.value as T,
      source: state.source,
      configVersion: state.configVersion,
    }
  }
}

/** @deprecated Import evaluation primitives from @superflag-sh/core directly. */
export { bucket, createEvaluator, stableHash } from "@superflag-sh/core"
