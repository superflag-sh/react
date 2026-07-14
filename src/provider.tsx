import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createEvaluator } from "@superflag-sh/core"
import type {
  SuperflagEvaluationDetails,
  SuperflagProviderProps,
  SuperflagState,
} from "./types.js"
import {
  SuperflagContext,
  defaultEvaluation,
  initialState,
} from "./context.js"
import { createClient } from "./client.js"
import { dispatchEvaluationCallbacks } from "./callbacks.js"

function nonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

export function SuperflagProvider({
  clientKey: propKey,
  configUrl,
  ttlSeconds: rawTtlSeconds = 60,
  maxStaleAgeSeconds: rawMaxStaleAgeSeconds = 86_400,
  maxRetries: rawMaxRetries = 2,
  retryBaseDelayMs: rawRetryBaseDelayMs = 250,
  retryMaxDelayMs: rawRetryMaxDelayMs = 5_000,
  storage,
  targetingKey,
  attributes,
  userId,
  onReady,
  onDiagnostic,
  onEvaluation,
  onExposure,
  children,
}: SuperflagProviderProps): JSX.Element {
  const clientKey =
    propKey ??
    (typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_SUPERFLAG_CLIENT_KEY
      : undefined)
  const ttlSeconds = nonNegative(rawTtlSeconds, 60)
  const maxStaleAgeSeconds = nonNegative(rawMaxStaleAgeSeconds, 86_400)
  const maxRetries = Math.floor(nonNegative(rawMaxRetries, 2))
  const retryBaseDelayMs = nonNegative(rawRetryBaseDelayMs, 250)
  const retryMaxDelayMs = Math.max(
    retryBaseDelayMs,
    nonNegative(rawRetryMaxDelayMs, 5_000),
  )

  const clientRef = useRef<ReturnType<typeof createClient> | null>(null)
  const onReadyRef = useRef(onReady)
  const onDiagnosticRef = useRef(onDiagnostic)
  const onEvaluationRef = useRef(onEvaluation)
  const onExposureRef = useRef(onExposure)
  onReadyRef.current = onReady
  onDiagnosticRef.current = onDiagnostic
  onEvaluationRef.current = onEvaluation
  onExposureRef.current = onExposure

  const [state, setState] = useState<SuperflagState>(() =>
    clientKey
      ? initialState
      : {
          ...initialState,
          status: "error",
          error: "Missing clientKey prop or NEXT_PUBLIC_SUPERFLAG_CLIENT_KEY",
        },
  )

  useEffect(() => {
    if (!clientKey) {
      clientRef.current = null
      setState({
        ...initialState,
        status: "error",
        error: "Missing clientKey prop or NEXT_PUBLIC_SUPERFLAG_CLIENT_KEY",
      })
      return
    }

    const client = createClient({
      clientKey,
      configUrl,
      ttlSeconds,
      maxStaleAgeSeconds,
      maxRetries,
      retryBaseDelayMs,
      retryMaxDelayMs,
      storage,
      targetingKey,
      attributes,
      userId,
      onStateChange: setState,
      onReady: (info) => onReadyRef.current?.(info),
      onDiagnostic: (diagnostic) => onDiagnosticRef.current?.(diagnostic),
    })
    clientRef.current = client
    void client.initialize()

    return () => {
      clientRef.current = null
      client.destroy()
    }
  }, [
    clientKey,
    configUrl,
    ttlSeconds,
    maxStaleAgeSeconds,
    maxRetries,
    retryBaseDelayMs,
    retryMaxDelayMs,
    storage,
  ])

  useEffect(() => {
    clientRef.current?.setContext({ targetingKey, attributes, userId })
  }, [targetingKey, attributes, userId])

  const evaluate = useMemo(() => {
    if (!state.config) return defaultEvaluation
    const evaluator = createEvaluator(state.config)
    const evaluationContext = {
      targetingKey: state.targetingKey ?? "",
      ...(state.attributes ? { attributes: state.attributes } : {}),
    }

    return <T,>(
      flagKey: string,
      fallback?: T,
    ): SuperflagEvaluationDetails<T | undefined> => {
      const flag = state.config?.flags[flagKey]
      const safeFallback =
        fallback ??
        (flag ? flag.variations[flag.offVariation]?.value : undefined)
      if (safeFallback === undefined) return defaultEvaluation(flagKey, fallback)

      const details = evaluator.evaluate(
        flagKey as never,
        evaluationContext,
        safeFallback as never,
      )
      return {
        ...details,
        value: details.value as T,
        source: state.source,
        configVersion: state.configVersion,
      }
    }
  }, [
    state.config,
    state.targetingKey,
    state.attributes,
    state.source,
    state.configVersion,
  ])

  const recordEvaluation = useCallback(
    (details: SuperflagEvaluationDetails<unknown>, exposed: boolean): void => {
      dispatchEvaluationCallbacks(details, exposed, {
        onDiagnostic: onDiagnosticRef.current,
        onEvaluation: onEvaluationRef.current,
        onExposure: onExposureRef.current,
      })
    },
    [],
  )

  const contextValue = useMemo(
    () => ({ ...state, evaluate, recordEvaluation }),
    [state, evaluate, recordEvaluation],
  )

  return (
    <SuperflagContext.Provider value={contextValue}>
      {children}
    </SuperflagContext.Provider>
  )
}
