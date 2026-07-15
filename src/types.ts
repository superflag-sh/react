import type {
  AttributeValue,
  EvaluationContext,
  EvaluationDetails,
  EvaluationErrorCode,
  EvaluationReason,
  FlagConfig,
  FlagKey,
  FlagValue as CoreFlagValue,
  FlagValueFor,
  JsonValue,
} from "@superflag-sh/core"
import type {
  FeatureEvent,
  FeatureEventDimension,
  PseudonymousSubject,
  TelemetryAdapterOptions,
  TelemetryDiagnostic,
  TelemetryEnqueueResult,
  TelemetryFlushResult,
  TelemetryShutdownResult,
  TelemetryTransport,
} from "@superflag-sh/core"

export type {
  AttributeValue,
  EvaluationContext,
  EvaluationErrorCode,
  EvaluationReason,
  Flag,
  FlagConfig,
  FlagKey,
  FlagValueFor,
  JsonValue,
  Rollout,
  Segment,
  Serve,
  TargetingRule,
  Variation,
} from "@superflag-sh/core"

/** @deprecated Use the core FlagConfig contract. */
export type FlagType = "bool" | "string" | "number" | "json"

/** A remotely configured flag definition from the shared core schema. */
export type FlagValue = FlagConfig["flags"][string]
export type Flags = FlagConfig["flags"]

export type SuperflagStatus =
  | "idle"
  | "loading"
  | "refreshing"
  | "ready"
  | "stale"
  | "error"
  | "rate-limited"

export type SuperflagSource = "cache" | "network" | "default"
export type RefreshReason = "initial" | "manual" | "ttl" | "visibility" | "online"

export interface SuperflagDiagnostic {
  code:
    | EvaluationErrorCode
    | "CACHE_EXPIRED"
    | "CACHE_INVALID"
    | "CALLBACK_ERROR"
    | "CONFIG_INVALID"
    | "FETCH_ERROR"
    | "RETRY_SCHEDULED"
    | "TELEMETRY_DROPPED"
    | "TELEMETRY_ERROR"
  message: string
  severity: "info" | "warning" | "error"
  flagKey?: string
  attempt?: number
  telemetryCode?: TelemetryDiagnostic["code"]
  cause?: unknown
}

export interface SuperflagTelemetryIdentityInput {
  targetingKey: string
  namespace: string
  appId: string
  environment: string
  state: PseudonymousSubject["state"]
}

export interface SuperflagHostedTelemetryOptions {
  /** Control-plane base URL. `/api/v1/events/batch` is appended safely. */
  baseUrl?: string
  headers?: Readonly<Record<string, string>>
  fetch?: typeof globalThis.fetch
}

export type SuperflagTelemetryQueueOptions = Omit<
  TelemetryAdapterOptions,
  "transport" | "onEvent" | "onDiagnostic" | "allowedDimensions" | "scheduler"
>

/** Telemetry is disabled unless this object supplies hosted delivery, a transport, or onEvent. */
export interface SuperflagTelemetryOptions extends SuperflagTelemetryQueueOptions {
  transport?: TelemetryTransport
  hosted?: boolean | SuperflagHostedTelemetryOptions
  pseudonymize?: (
    input: SuperflagTelemetryIdentityInput,
  ) => PseudonymousSubject | Promise<PseudonymousSubject>
  subjectState?: PseudonymousSubject["state"]
  subjectRevision?: number
  /** Outcome attributes are projected through this allow-list. Defaults closed. */
  allowedAttributes?: readonly string[]
  onEvent?: (event: FeatureEvent) => void
  onDiagnostic?: (diagnostic: TelemetryDiagnostic) => void
}

export interface SuperflagTrackOptions {
  revision?: number
  attributes?: Readonly<Record<string, FeatureEventDimension>>
}

export type SuperflagTrackResult =
  | TelemetryEnqueueResult
  | {
      status: "dropped"
      reason: "invalid_outcome" | "missing_exposure" | "missing_identity"
      queueSize: number
    }

export type SuperflagEvaluationDetails<T = CoreFlagValue> = Omit<
  EvaluationDetails,
  "value" | "source" | "configVersion"
> & {
  value: T
  source: SuperflagSource
  configVersion: number | null
}

export interface SuperflagEvaluationEvent<T = CoreFlagValue> {
  flagKey: string
  value: T
  variation?: string
  reason: EvaluationReason
  errorCode?: EvaluationErrorCode
  source: SuperflagSource
  configVersion: number | null
  timestamp: string
}

export type SuperflagExposureEvent = Omit<SuperflagEvaluationEvent, "value" | "errorCode">

export interface SuperflagReadyInfo {
  source: Exclude<SuperflagSource, "default">
  fetchedAt: number
  configVersion: number
  appId: string
  environment: string
}

export interface SuperflagState {
  config: FlagConfig | null
  flags: Flags
  status: SuperflagStatus
  source: SuperflagSource
  appId: string | null
  environment: string | null
  /** @deprecated Use configVersion. */
  version: number | null
  configVersion: number | null
  etag: string | null
  /** @deprecated Use fetchedAt. */
  lastFetchedAt: number | null
  fetchedAt: number | null
  /** Cache/config age in seconds at the latest lifecycle transition. */
  age: number | null
  stale: boolean
  error: string | null
  targetingKey?: string
  attributes?: Readonly<Record<string, AttributeValue>>
  /** @deprecated Use targetingKey. */
  userId?: string
  refresh: () => Promise<void>
}

export interface SuperflagProviderProps {
  clientKey?: string
  configUrl?: string
  ttlSeconds?: number
  /** Maximum time cached configuration may be served. Defaults to 24 hours. */
  maxStaleAgeSeconds?: number
  /** Additional attempts after the initial request. Defaults to 2. */
  maxRetries?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
  storage?: StorageAdapter
  targetingKey?: string
  attributes?: Readonly<Record<string, AttributeValue>>
  /** @deprecated Use targetingKey. */
  userId?: string
  onReady?: (info: SuperflagReadyInfo) => void
  onDiagnostic?: (diagnostic: SuperflagDiagnostic) => void
  onEvaluation?: (event: SuperflagEvaluationEvent) => void
  onExposure?: (event: SuperflagExposureEvent) => void
  telemetry?: SuperflagTelemetryOptions
  children: React.ReactNode
}

export interface ConfigResponse {
  appId: string
  env: string
  version: number
  doc: FlagConfig
  ttlSeconds: number
}

export interface CachedConfig {
  schemaVersion: 3
  endpointFingerprint: string
  clientKeyFingerprint: string
  appId: string
  environment: string
  /** Retained for the shared cache identity validator. */
  flags: Flags
  config: FlagConfig
  version: number
  etag: string
  fetchedAt: number
}

export interface StorageAdapter {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

export interface ClientConfig {
  clientKey: string
  configUrl?: string
  ttlSeconds: number
  maxStaleAgeSeconds: number
  maxRetries: number
  retryBaseDelayMs: number
  retryMaxDelayMs: number
  onStateChange: (state: SuperflagState) => void
  onReady?: (info: SuperflagReadyInfo) => void
  onDiagnostic?: (diagnostic: SuperflagDiagnostic) => void
  storage?: StorageAdapter
  targetingKey?: string
  attributes?: Readonly<Record<string, AttributeValue>>
  userId?: string
}

export interface SuperflagClient {
  initialize: () => Promise<void>
  destroy: () => void
  refresh: () => Promise<void>
  /** @deprecated Use refresh. */
  refetch: () => Promise<void>
  setContext: (context: Partial<EvaluationContext> & { userId?: string }) => void
}

export type TypedFlagValues<T> = T extends FlagConfig
  ? { [K in FlagKey<T>]: FlagValueFor<T, K> }
  : T

export interface TypedSuperflagClient<T extends object> {
  getFlag<K extends Extract<keyof TypedFlagValues<T>, string>>(
    flagKey: K,
    fallback: TypedFlagValues<T>[K],
  ): TypedFlagValues<T>[K]
  getFlagDetails<K extends Extract<keyof TypedFlagValues<T>, string>>(
    flagKey: K,
    fallback: TypedFlagValues<T>[K],
  ): SuperflagEvaluationDetails<TypedFlagValues<T>[K]>
  /** Records a numeric outcome against this subject's latest real exposure. */
  track<K extends Extract<keyof TypedFlagValues<T>, string>>(
    flagKey: K,
    metricKey: string,
    value: number,
    options?: SuperflagTrackOptions,
  ): Promise<SuperflagTrackResult>
  flush: () => Promise<TelemetryFlushResult>
  shutdown: (options?: {
    flush?: boolean
    timeoutMs?: number
  }) => Promise<TelemetryShutdownResult>
  refresh: () => Promise<void>
}

export interface TypedSuperflagHooks<T extends object> {
  useFlag<K extends Extract<keyof TypedFlagValues<T>, string>>(
    flagKey: K,
    fallback: TypedFlagValues<T>[K],
  ): TypedFlagValues<T>[K]
  useFlagDetails<K extends Extract<keyof TypedFlagValues<T>, string>>(
    flagKey: K,
    fallback: TypedFlagValues<T>[K],
  ): SuperflagEvaluationDetails<TypedFlagValues<T>[K]>
  useClient: () => TypedSuperflagClient<T>
}

export type ObjectFlagValue = Exclude<JsonValue, string | number | boolean | null>
