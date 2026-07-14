import type { FlagValue as CoreFlagValue } from "@superflag-sh/core"
import { toExposureEvent } from "./context.js"
import type {
  SuperflagDiagnostic,
  SuperflagEvaluationDetails,
  SuperflagEvaluationEvent,
  SuperflagExposureEvent,
} from "./types.js"

export interface EvaluationCallbacks {
  onDiagnostic?: (diagnostic: SuperflagDiagnostic) => void
  onEvaluation?: (event: SuperflagEvaluationEvent) => void
  onExposure?: (event: SuperflagExposureEvent) => void
}

/** Dispatches post-commit telemetry without allowing consumer callbacks to affect evaluation. */
export function dispatchEvaluationCallbacks(
  details: SuperflagEvaluationDetails<unknown>,
  exposed: boolean,
  callbacks: EvaluationCallbacks,
): void {
  const diagnostic = (value: SuperflagDiagnostic): void => {
    try {
      callbacks.onDiagnostic?.(value)
    } catch {
      // A diagnostic callback cannot safely diagnose itself.
    }
  }
  if (details.errorCode) {
    diagnostic({
      code: details.errorCode,
      message: details.errorMessage ?? `Evaluation failed for ${details.flagKey}`,
      severity: "warning",
      flagKey: details.flagKey,
    })
  }

  const event: SuperflagEvaluationEvent<unknown> = {
    flagKey: details.flagKey,
    value: details.value,
    variation: details.variation,
    reason: details.reason,
    errorCode: details.errorCode,
    source: details.source,
    configVersion: details.configVersion,
    timestamp: details.timestamp,
  }
  try {
    callbacks.onEvaluation?.(event as SuperflagEvaluationEvent<CoreFlagValue>)
  } catch (cause) {
    diagnostic({
      code: "CALLBACK_ERROR",
      message: "onEvaluation callback threw",
      severity: "error",
      flagKey: details.flagKey,
      cause,
    })
  }

  if (!exposed) return
  try {
    callbacks.onExposure?.(toExposureEvent(details))
  } catch (cause) {
    diagnostic({
      code: "CALLBACK_ERROR",
      message: "onExposure callback threw",
      severity: "error",
      flagKey: details.flagKey,
      cause,
    })
  }
}
