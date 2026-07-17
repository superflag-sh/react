import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ReactElement } from "react"
import { stableJsonSignature } from "@superflag-sh/core"
import type {
  SuperflagEvaluationDetails,
  SuperflagProviderProps,
  SuperflagState,
  SuperflagTelemetryOptions,
} from "./types.js"
import {
  SuperflagContext,
  initialState,
} from "./context.js"
import { createEvaluationReader } from "./evaluation.js"
import { createClient } from "./client.js"
import { dispatchEvaluationCallbacks } from "./callbacks.js"
import {
  createBrowserTelemetryController,
  disabledTelemetryController,
} from "./telemetry.js"

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
  telemetry,
  children,
}: SuperflagProviderProps): ReactElement {
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
  const telemetryOptionsRef = useRef(telemetry)
  telemetryOptionsRef.current = telemetry
  const hostedOptions =
    typeof telemetry?.hosted === "object" ? telemetry.hosted : undefined
  const hostedHeadersSignature = stableJsonSignature(hostedOptions?.headers)
  const attributesSignature = stableJsonSignature(attributes)
  const stableAttributes = useMemo(
    () => (attributes ? { ...attributes } : undefined),
    [attributesSignature],
  )
  const allowedAttributesSignature = JSON.stringify(
    telemetry?.allowedAttributes ?? [],
  )
  const stableTelemetry = useMemo<SuperflagTelemetryOptions | undefined>(
    () =>
      telemetry
        ? {
            ...telemetry,
            ...(telemetry.transport
              ? {
                  transport: {
                    send: (events, options) => {
                      const current = telemetryOptionsRef.current?.transport
                      return current
                        ? current.send(events, options)
                        : Promise.reject(new Error("Telemetry transport was removed"))
                    },
                  },
                }
              : {}),
            ...(hostedOptions
              ? {
                  hosted: {
                    ...hostedOptions,
                    ...(hostedOptions.fetch
                      ? {
                          fetch: (input, init) => {
                            const current =
                              typeof telemetryOptionsRef.current?.hosted === "object"
                                ? telemetryOptionsRef.current.hosted.fetch
                                : undefined
                            return (current ?? globalThis.fetch)(input, init)
                          },
                        }
                      : {}),
                    ...(hostedOptions.headers
                      ? { headers: { ...hostedOptions.headers } }
                      : {}),
                  },
                }
              : {}),
            ...(telemetry.pseudonymize
              ? {
                  pseudonymize: (input) => {
                    const current = telemetryOptionsRef.current?.pseudonymize
                    if (!current) throw new Error("Telemetry pseudonymizer was removed")
                    return current(input)
                  },
                }
              : {}),
            ...(telemetry.onEvent
              ? {
                  onEvent: (event) => telemetryOptionsRef.current?.onEvent?.(event),
                }
              : {}),
            ...(telemetry.onDiagnostic
              ? {
                  onDiagnostic: (diagnostic) =>
                    telemetryOptionsRef.current?.onDiagnostic?.(diagnostic),
                }
              : {}),
            ...(telemetry.allowedAttributes
              ? { allowedAttributes: [...telemetry.allowedAttributes] }
              : {}),
          }
        : undefined,
    [
      telemetry !== undefined,
      telemetry?.transport !== undefined,
      telemetry?.hosted === true,
      hostedOptions?.baseUrl,
      hostedOptions?.fetch !== undefined,
      hostedHeadersSignature,
      telemetry?.pseudonymize !== undefined,
      telemetry?.subjectState,
      telemetry?.subjectRevision,
      allowedAttributesSignature,
      telemetry?.onEvent !== undefined,
      telemetry?.onDiagnostic !== undefined,
      telemetry?.maxQueueSize,
      telemetry?.batchSize,
      telemetry?.flushIntervalMs,
      telemetry?.backpressure,
      telemetry?.maxAttempts,
      telemetry?.retryBaseMs,
      telemetry?.retryMaxMs,
      telemetry?.retryJitterRatio,
      telemetry?.maxExposureDedupeEntries,
      telemetry?.maxEventPayloadBytes,
      telemetry?.shutdownTimeoutMs,
    ],
  )

  const clientRef = useRef<ReturnType<typeof createClient> | null>(null)
  const telemetryRef = useRef(disabledTelemetryController)
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
  const stateRef = useRef(state)
  stateRef.current = state

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
      attributes: stableAttributes,
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
    clientRef.current?.setContext({ targetingKey, attributes: stableAttributes, userId })
  }, [targetingKey, stableAttributes, userId])

  useEffect(() => {
    if (!clientKey || !stableTelemetry) {
      telemetryRef.current = disabledTelemetryController
      return
    }
    let controller: ReturnType<typeof createBrowserTelemetryController>
    try {
      controller = createBrowserTelemetryController({
        clientKey,
        configUrl,
        telemetry: stableTelemetry,
        getState: () => ({
          config: stateRef.current.config,
          targetingKey: stateRef.current.targetingKey,
        }),
        onDiagnostic: (diagnostic) => onDiagnosticRef.current?.(diagnostic),
      })
    } catch (cause) {
      telemetryRef.current = disabledTelemetryController
      try {
        onDiagnosticRef.current?.({
          code: "TELEMETRY_ERROR",
          message: "Telemetry setup failed; evaluation remains available",
          severity: "error",
          cause,
        })
      } catch {
        // Telemetry and diagnostic callbacks are both fail-open.
      }
      return
    }
    telemetryRef.current = controller
    return () => {
      if (telemetryRef.current === controller) {
        telemetryRef.current = disabledTelemetryController
      }
      controller.destroy()
    }
  }, [clientKey, configUrl, stableTelemetry])

  const evaluate = useMemo(
    () =>
      createEvaluationReader({
        config: state.config,
        context: {
          targetingKey: state.targetingKey ?? "",
          ...(state.attributes ? { attributes: state.attributes } : {}),
        },
        source: state.source,
        configVersion: state.configVersion,
      }),
    [
      state.config,
      state.targetingKey,
      state.attributes,
      state.source,
      state.configVersion,
    ],
  )

  const recordEvaluation = useCallback(
    (details: SuperflagEvaluationDetails<unknown>, exposed: boolean): void => {
      telemetryRef.current.recordEvaluation(details, exposed)
      dispatchEvaluationCallbacks(details, exposed, {
        onDiagnostic: onDiagnosticRef.current,
        onEvaluation: onEvaluationRef.current,
        onExposure: onExposureRef.current,
      })
    },
    [],
  )

  const track = useCallback(
    (
      flagKey: string,
      metricKey: string,
      value?: number,
      options?: import("./types.js").SuperflagTrackOptions,
    ) => telemetryRef.current.track(flagKey, metricKey, value, options),
    [],
  )
  const flush = useCallback(() => telemetryRef.current.flush(), [])
  const shutdown = useCallback(
    (options?: { flush?: boolean; timeoutMs?: number }) =>
      telemetryRef.current.shutdown(options),
    [],
  )

  const contextValue = useMemo(
    () => ({ ...state, evaluate, recordEvaluation, track, flush, shutdown }),
    [state, evaluate, recordEvaluation, track, flush, shutdown],
  )

  return (
    <SuperflagContext.Provider value={contextValue}>
      {children}
    </SuperflagContext.Provider>
  )
}
