import { useContext, useEffect, useMemo } from "react"
import { SuperflagContext } from "./context.js"
import type {
  ObjectFlagValue,
  SuperflagEvaluationDetails,
  TypedFlagValues,
  TypedSuperflagClient,
  TypedSuperflagHooks,
  UseFlagsResult,
} from "./types.js"
import type { SuperflagContextValue } from "./context.js"

function useSuperflagContext(): SuperflagContextValue {
  const context = useContext(SuperflagContext)
  if (!context) throw new Error("Superflag hooks must be used within a SuperflagProvider")
  return context
}

function useEvaluation<T>(
  flagKey: string,
  fallback: T | undefined,
  exposed: boolean,
): SuperflagEvaluationDetails<T | undefined> {
  const context = useSuperflagContext()

  const details = useMemo(
    () => context.evaluate(flagKey, fallback),
    [context.evaluate, flagKey, fallback],
  )
  useEffect(() => {
    context.recordEvaluation(details, exposed)
  }, [context.recordEvaluation, details, exposed])
  return details
}

/** Backwards-compatible value hook. Missing fallbacks resolve to the configured off variation. */
export function useFlag<T = unknown>(flagKey: string, fallback?: T): T | undefined {
  return useEvaluation(flagKey, fallback, true).value
}

export function useFlagDetails<T>(
  flagKey: string,
  fallback: T,
): SuperflagEvaluationDetails<T> {
  return useEvaluation(flagKey, fallback, false) as SuperflagEvaluationDetails<T>
}

export function useBooleanFlag(flagKey: string, fallback: boolean): boolean {
  return useEvaluation(flagKey, fallback, true).value as boolean
}

export function useStringFlag(flagKey: string, fallback: string): string {
  return useEvaluation(flagKey, fallback, true).value as string
}

export function useNumberFlag(flagKey: string, fallback: number): number {
  return useEvaluation(flagKey, fallback, true).value as number
}

export function useObjectFlag<T extends ObjectFlagValue>(flagKey: string, fallback: T): T {
  return useEvaluation(flagKey, fallback, true).value as T
}

export function useBooleanFlagDetails(
  flagKey: string,
  fallback: boolean,
): SuperflagEvaluationDetails<boolean> {
  return useFlagDetails(flagKey, fallback)
}

export function useStringFlagDetails(
  flagKey: string,
  fallback: string,
): SuperflagEvaluationDetails<string> {
  return useFlagDetails(flagKey, fallback)
}

export function useNumberFlagDetails(
  flagKey: string,
  fallback: number,
): SuperflagEvaluationDetails<number> {
  return useFlagDetails(flagKey, fallback)
}

export function useObjectFlagDetails<T extends ObjectFlagValue>(
  flagKey: string,
  fallback: T,
): SuperflagEvaluationDetails<T> {
  return useFlagDetails(flagKey, fallback)
}

/** Project provider state without leaking private evaluation or telemetry methods. */
export function createFlagsResult(context: SuperflagContextValue): UseFlagsResult {
  return {
    config: context.config,
    flags: context.flags,
    status: context.status,
    source: context.source,
    appId: context.appId,
    environment: context.environment,
    version: context.version,
    configVersion: context.configVersion,
    etag: context.etag,
    lastFetchedAt: context.lastFetchedAt,
    fetchedAt: context.fetchedAt,
    age: context.age,
    stale: context.stale,
    error: context.error,
    targetingKey: context.targetingKey,
    attributes: context.attributes,
    userId: context.userId,
    refresh: context.refresh,
    ready: context.config !== null && context.status !== "error",
    loading: context.status === "idle" || context.status === "loading",
  }
}

export function useFlags(): UseFlagsResult {
  return createFlagsResult(useSuperflagContext())
}

/** Build the imperative Interface from the provider context. */
export function createContextClient<T extends object>(
  context: SuperflagContextValue,
): TypedSuperflagClient<T> {
  return {
    getFlag<K extends Extract<keyof TypedFlagValues<T>, string>>(
      flagKey: K,
      fallback: TypedFlagValues<T>[K],
    ): TypedFlagValues<T>[K] {
      const details = context.evaluate(flagKey, fallback)
      context.recordEvaluation(details, true)
      return details.value as TypedFlagValues<T>[K]
    },
    getFlagDetails<K extends Extract<keyof TypedFlagValues<T>, string>>(
      flagKey: K,
      fallback: TypedFlagValues<T>[K],
    ): SuperflagEvaluationDetails<TypedFlagValues<T>[K]> {
      const details = context.evaluate(flagKey, fallback)
      context.recordEvaluation(details, false)
      return details as SuperflagEvaluationDetails<TypedFlagValues<T>[K]>
    },
    track: context.track,
    flush: context.flush,
    shutdown: context.shutdown,
    refresh: context.refresh,
  }
}

/** Relevant identities for the imperative client's memoized Interface. */
export type ContextClientDependencies = readonly [
  SuperflagContextValue["evaluate"],
  SuperflagContextValue["recordEvaluation"],
  SuperflagContextValue["track"],
  SuperflagContextValue["flush"],
  SuperflagContextValue["shutdown"],
  SuperflagContextValue["refresh"],
]

export function contextClientDependencies(
  context: SuperflagContextValue,
): ContextClientDependencies {
  return [
    context.evaluate,
    context.recordEvaluation,
    context.track,
    context.flush,
    context.shutdown,
    context.refresh,
  ] as const
}

/** Imperative evaluation API for event handlers and non-render callbacks. */
export function useSuperflagClient<
  T extends object = Record<string, unknown>,
>(): TypedSuperflagClient<T> {
  const context = useSuperflagContext()
  return useMemo(
    () => createContextClient<T>(context),
    contextClientDependencies(context),
  )
}

/** Bind generated/core config types once, then use key/value-safe hooks throughout an app. */
export function createTypedHooks<const T extends object>(): TypedSuperflagHooks<T> {
  return {
    useFlag<K extends Extract<keyof TypedFlagValues<T>, string>>(
      flagKey: K,
      fallback: TypedFlagValues<T>[K],
    ) {
      return useFlag(flagKey, fallback) as TypedFlagValues<T>[K]
    },
    useFlagDetails<K extends Extract<keyof TypedFlagValues<T>, string>>(
      flagKey: K,
      fallback: TypedFlagValues<T>[K],
    ) {
      return useFlagDetails(flagKey, fallback) as SuperflagEvaluationDetails<
        TypedFlagValues<T>[K]
      >
    },
    useClient() {
      return useSuperflagClient<T>()
    },
  }
}
