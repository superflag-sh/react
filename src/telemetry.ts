import {
  createEvaluationEvent,
  createTelemetryAdapter,
  FEATURE_EVENT_SCHEMA_VERSION,
  parseFeatureEvent,
} from "@superflag-sh/core"
import type {
  EvaluationDetails,
  FeatureEvent,
  FeatureEventDimension,
  PseudonymousSubject,
  TelemetryAdapter,
  TelemetryBatchResult,
  TelemetryDiagnostic,
  TelemetryFlushResult,
  TelemetryItemResult,
  TelemetryShutdownResult,
  TelemetryTransport,
} from "@superflag-sh/core"
import type {
  SuperflagDiagnostic,
  SuperflagEvaluationDetails,
  SuperflagHostedTelemetryOptions,
  SuperflagTelemetryOptions,
  SuperflagTrackOptions,
  SuperflagTrackResult,
} from "./types.js"
import { sha256 } from "@superflag-sh/core"

const DEFAULT_BASE_URL = "https://superflag.sh"
const EVENT_ROUTE = "/api/v1/events/batch"
const MAX_HOSTED_BODY_BYTES = 250 * 1_024
const SDK_NAME = "@superflag-sh/react"
const SDK_VERSION = "0.7.0"
const sessionInstallationKeys = new Map<string, string>()
type TelemetryAbortSignal = Parameters<TelemetryTransport["send"]>[1]["signal"]

interface TelemetryState {
  config: NonNullable<import("./types.js").SuperflagState["config"]> | null
  targetingKey?: string
}

interface ExposureRecord {
  event: Extract<FeatureEvent, { kind: "exposure" }>
}

export interface HostedTelemetryTransportOptions
  extends SuperflagHostedTelemetryOptions {
  clientKey: string
}

export interface BrowserTelemetryControllerOptions {
  clientKey: string
  configUrl?: string
  telemetry: SuperflagTelemetryOptions
  getState: () => TelemetryState
  onDiagnostic?: (diagnostic: SuperflagDiagnostic) => void
}

export interface BrowserTelemetryController {
  recordEvaluation(
    details: SuperflagEvaluationDetails<unknown>,
    exposed: boolean,
  ): void
  track(
    flagKey: string,
    metricKey: string,
    value?: number,
    options?: SuperflagTrackOptions,
  ): Promise<SuperflagTrackResult>
  flush(): Promise<TelemetryFlushResult>
  shutdown(options?: {
    flush?: boolean
    timeoutMs?: number
  }): Promise<TelemetryShutdownResult>
  destroy(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeBaseUrl(input: string | undefined): string {
  const candidate = input?.trim() || DEFAULT_BASE_URL
  const browserOrigin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : DEFAULT_BASE_URL
  const parsed = new URL(candidate, `${browserOrigin}/`)
  const marker = parsed.pathname.indexOf("/api/v1")
  if (marker >= 0) parsed.pathname = parsed.pathname.slice(0, marker)
  parsed.search = ""
  parsed.hash = ""
  return parsed.toString().replace(/\/$/, "")
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

function eventId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("Retry-After")
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000)
  const at = Date.parse(header)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

function statusResults(
  events: readonly FeatureEvent[],
  status: "permanent_error" | "retryable_error",
  code: string,
  retryInMs?: number,
): TelemetryBatchResult {
  return {
    items: events.map((event) =>
      status === "permanent_error"
        ? { eventId: event.id, status, code }
        : {
            eventId: event.id,
            status,
            code,
            ...(retryInMs === undefined ? {} : { retryAfterMs: retryInMs }),
          },
    ),
  }
}

function parseItem(value: unknown): TelemetryItemResult | null {
  if (!isRecord(value) || typeof value.eventId !== "string") return null
  if (value.status === "accepted" || value.status === "duplicate") {
    return { eventId: value.eventId, status: value.status }
  }
  if (value.status === "permanent_error" && typeof value.code === "string") {
    return {
      eventId: value.eventId,
      status: value.status,
      code: value.code,
      ...(typeof value.message === "string" ? { message: value.message } : {}),
    }
  }
  if (value.status === "retryable_error") {
    return {
      eventId: value.eventId,
      status: value.status,
      ...(typeof value.code === "string" ? { code: value.code } : {}),
      ...(typeof value.retryAfterMs === "number" &&
      Number.isFinite(value.retryAfterMs) &&
      value.retryAfterMs >= 0
        ? { retryAfterMs: value.retryAfterMs }
        : {}),
    }
  }
  return null
}

function parseBatchResponse(value: unknown): TelemetryBatchResult | null {
  if (
    !isRecord(value) ||
    value.apiVersion !== 1 ||
    value.schemaVersion !== FEATURE_EVENT_SCHEMA_VERSION ||
    !Array.isArray(value.items)
  ) {
    return null
  }
  const items = value.items.map(parseItem)
  return items.some((item) => item === null)
    ? null
    : { items: items as TelemetryItemResult[] }
}

/** Creates the opt-in first-party transport without coupling evaluation to delivery. */
export function createHostedTelemetryTransport(
  options: HostedTelemetryTransportOptions,
): TelemetryTransport {
  const fetcher = options.fetch ?? globalThis.fetch
  if (typeof fetcher !== "function") {
    throw new TypeError("Hosted telemetry requires a fetch implementation")
  }
  const endpoint = `${normalizeBaseUrl(options.baseUrl)}${EVENT_ROUTE}`

  async function sendChunk(
    events: readonly FeatureEvent[],
    signal: TelemetryAbortSignal,
  ): Promise<TelemetryBatchResult> {
      const headers = new Headers(options.headers)
      headers.set("Authorization", `Bearer ${options.clientKey}`)
      headers.set("Content-Type", "application/json")
      headers.set("X-Request-ID", requestId())
      const body = JSON.stringify({
        schemaVersion: FEATURE_EVENT_SCHEMA_VERSION,
        events,
      })
      const response = await fetcher(endpoint, {
        method: "POST",
        headers,
        body,
        signal: signal as AbortSignal,
        // Browsers reject keepalive requests above roughly 64 KiB. Large
        // explicit flushes still deliver as normal fetches.
        keepalive: new TextEncoder().encode(body).byteLength <= 60 * 1024,
      })

      if (response.status === 429) {
        const parsed = parseBatchResponse(await response.json().catch(() => null))
        if (parsed) return parsed
        return statusResults(
          events,
          "retryable_error",
          "HTTP_429",
          retryAfterMs(response),
        )
      }
      if (response.status === 408 || response.status === 425 || response.status >= 500) {
        return statusResults(
          events,
          "retryable_error",
          `HTTP_${response.status}`,
          retryAfterMs(response),
        )
      }
      if (!response.ok) {
        return statusResults(events, "permanent_error", `HTTP_${response.status}`)
      }

      const parsed = parseBatchResponse((await response.json()) as unknown)
      if (!parsed) throw new TypeError("Telemetry endpoint returned an invalid response envelope")
      return parsed
  }

  return {
    async send(events, { signal }) {
      const chunks: FeatureEvent[][] = []
      let chunk: FeatureEvent[] = []
      for (const event of events) {
        const candidate = [...chunk, event]
        const encoded = JSON.stringify({
          schemaVersion: FEATURE_EVENT_SCHEMA_VERSION,
          events: candidate,
        })
        if (
          chunk.length > 0 &&
          new TextEncoder().encode(encoded).byteLength > MAX_HOSTED_BODY_BYTES
        ) {
          chunks.push(chunk)
          chunk = [event]
        } else {
          chunk = candidate
        }
      }
      if (chunk.length > 0) chunks.push(chunk)

      const items: TelemetryItemResult[] = []
      for (const batch of chunks) {
        const result = await sendChunk(batch, signal)
        items.push(...result.items)
      }
      return { items }
    },
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function defaultPseudonymize(
  clientKey: string,
  input: {
    targetingKey: string
    namespace: string
    state: PseudonymousSubject["state"]
    revision: number
  },
): Promise<PseudonymousSubject> {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw new Error("Web Crypto is required for default telemetry pseudonymization")
  }
  const encoder = new TextEncoder()
  const storageKey = `superflag:telemetry-key:v1:${sha256(clientKey)}:${sha256(input.namespace)}`
  let installationKey: string | null = sessionInstallationKeys.get(storageKey) ?? null
  try {
    const stored = globalThis.localStorage?.getItem(storageKey)
    if (stored && /^[A-Za-z0-9_-]{43}$/.test(stored)) {
      installationKey = stored
      sessionInstallationKeys.set(storageKey, stored)
    }
  } catch {
    // Storage is optional. This browser session still receives an opaque key.
  }
  if (!installationKey) {
    const random = new Uint8Array(32)
    globalThis.crypto.getRandomValues(random)
    installationKey = bytesToBase64Url(random)
    sessionInstallationKeys.set(storageKey, installationKey)
    try {
      globalThis.localStorage?.setItem(storageKey, installationKey)
    } catch {
      // Sandboxed/private browsers may keep only this controller's session key.
    }
  }
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(installationKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${input.namespace}\0${input.targetingKey}`),
  )
  return {
    id: `psn_${bytesToBase64Url(new Uint8Array(signature))}`,
    namespace: input.namespace,
    revision: input.revision,
    state: input.state,
  }
}

function emptyFlushResult(): TelemetryFlushResult {
  return {
    sent: 0,
    accepted: 0,
    duplicates: 0,
    permanent: 0,
    retryScheduled: 0,
    queueSize: 0,
  }
}

function emptyShutdownResult(): TelemetryShutdownResult {
  return { ...emptyFlushResult(), timedOut: false, dropped: 0 }
}

/** Framework integration around core's canonical queue and privacy boundary. */
export function createBrowserTelemetryController(
  options: BrowserTelemetryControllerOptions,
): BrowserTelemetryController {
  const telemetry = options.telemetry
  const hosted = telemetry.hosted
  const hostedOptions = typeof hosted === "object" ? hosted : {}
  const baseUrl = hostedOptions.baseUrl ?? options.configUrl
  const transport =
    telemetry.transport ??
    (hosted
      ? createHostedTelemetryTransport({
          ...hostedOptions,
          baseUrl,
          clientKey: options.clientKey,
        })
      : undefined)
  const exposureByFlag = new Map<string, ExposureRecord>()
  const exposureSequenceByFlag = new Map<string, number>()
  const pendingExposureByFlag = new Map<string, Promise<void>>()
  const pendingOperations = new Set<Promise<unknown>>()
  let accepting = true
  let destroyed = false
  let abandonPending = false
  let shutdownPromise: Promise<TelemetryShutdownResult> | undefined

  function emitDiagnostic(diagnostic: SuperflagDiagnostic): void {
    try {
      options.onDiagnostic?.(diagnostic)
    } catch {
      // Diagnostics never affect evaluation or telemetry delivery.
    }
  }

  function bridgeTelemetryDiagnostic(diagnostic: TelemetryDiagnostic): void {
    try {
      telemetry.onDiagnostic?.(diagnostic)
    } catch {
      // Core diagnostics are fail-open and cannot recurse into delivery.
    }
    emitDiagnostic({
      code: "TELEMETRY_ERROR",
      message: diagnostic.message,
      severity: diagnostic.code === "permanent_rejection" ? "error" : "warning",
      telemetryCode: diagnostic.code,
    })
  }

  const adapter: TelemetryAdapter = createTelemetryAdapter({
    ...(transport ? { transport } : {}),
    ...(telemetry.onEvent
      ? {
          onEvent: (event) => telemetry.onEvent?.(event),
        }
      : {}),
    onDiagnostic: bridgeTelemetryDiagnostic,
    ...(telemetry.maxQueueSize === undefined
      ? {}
      : { maxQueueSize: telemetry.maxQueueSize }),
    ...(telemetry.batchSize === undefined ? {} : { batchSize: telemetry.batchSize }),
    ...(telemetry.flushIntervalMs === undefined
      ? {}
      : { flushIntervalMs: telemetry.flushIntervalMs }),
    ...(telemetry.backpressure === undefined
      ? {}
      : { backpressure: telemetry.backpressure }),
    ...(telemetry.maxAttempts === undefined
      ? {}
      : { maxAttempts: telemetry.maxAttempts }),
    ...(telemetry.retryBaseMs === undefined
      ? {}
      : { retryBaseMs: telemetry.retryBaseMs }),
    ...(telemetry.retryMaxMs === undefined
      ? {}
      : { retryMaxMs: telemetry.retryMaxMs }),
    ...(telemetry.retryJitterRatio === undefined
      ? {}
      : { retryJitterRatio: telemetry.retryJitterRatio }),
    ...(telemetry.maxExposureDedupeEntries === undefined
      ? {}
      : { maxExposureDedupeEntries: telemetry.maxExposureDedupeEntries }),
    ...(telemetry.maxEventPayloadBytes === undefined
      ? {}
      : { maxEventPayloadBytes: telemetry.maxEventPayloadBytes }),
    ...(telemetry.shutdownTimeoutMs === undefined
      ? {}
      : { shutdownTimeoutMs: telemetry.shutdownTimeoutMs }),
    allowedDimensions: telemetry.allowedAttributes ?? [],
  })

  async function subjectFor(state: TelemetryState): Promise<PseudonymousSubject | null> {
    const targetingKey = state.targetingKey
    const config = state.config
    if (!targetingKey || !config) return null
    const appId = config.source.app
    const environment = config.source.environment
    const readableNamespace = `${appId}:${environment}`
    const namespace =
      readableNamespace.length <= 96
        ? readableNamespace
        : `scope_${sha256(readableNamespace)}`
    const subjectState = telemetry.subjectState ?? "authenticated"
    const revision =
      Number.isSafeInteger(telemetry.subjectRevision) &&
      (telemetry.subjectRevision as number) > 0
        ? (telemetry.subjectRevision as number)
        : 1
    if (telemetry.pseudonymize) {
      return telemetry.pseudonymize({
        targetingKey,
        namespace,
        appId,
        environment,
        state: subjectState,
      })
    }
    return defaultPseudonymize(options.clientKey, {
      targetingKey,
      namespace,
      state: subjectState,
      revision,
    })
  }

  async function recordEvaluationInternal(
    details: SuperflagEvaluationDetails<unknown>,
    exposed: boolean,
    state: TelemetryState,
    exposureSequence?: number,
  ): Promise<void> {
    if (
      !accepting ||
      !state.config ||
      !details.variation ||
      details.errorCode ||
      details.source === "default" ||
      details.configVersion === null
    ) {
      return
    }
    try {
      const subject = await subjectFor(state)
      if (!subject || abandonPending) return
      const event = createEvaluationEvent({
        id: eventId(),
        kind: exposed ? "exposure" : "decision",
        details: {
          ...details,
          value: details.value as EvaluationDetails["value"],
          source: state.config.source,
          configVersion: details.configVersion,
        },
        sdk: { name: SDK_NAME, version: SDK_VERSION, platform: "browser" },
        subject,
      })
      const result = adapter.enqueue(event)
      if (
        event.kind === "exposure" &&
        exposureSequenceByFlag.get(event.flagKey) === exposureSequence &&
        (result.status === "queued" || result.status === "callback_only")
      ) {
        exposureByFlag.set(event.flagKey, { event })
      }
    } catch (cause) {
      emitDiagnostic({
        code: "TELEMETRY_DROPPED",
        message: `Telemetry ${exposed ? "exposure" : "decision"} was dropped`,
        severity: "warning",
        flagKey: details.flagKey,
        cause,
      })
    }
  }

  function recordEvaluation(
    details: SuperflagEvaluationDetails<unknown>,
    exposed: boolean,
  ): void {
    const state = options.getState()
    if (!exposed) {
      const pending = recordEvaluationInternal(details, false, state)
      pendingOperations.add(pending)
      void pending.finally(() => pendingOperations.delete(pending))
      return
    }
    const sequence = (exposureSequenceByFlag.get(details.flagKey) ?? 0) + 1
    exposureSequenceByFlag.set(details.flagKey, sequence)
    const pending = recordEvaluationInternal(details, true, state, sequence)
    pendingOperations.add(pending)
    pendingExposureByFlag.set(details.flagKey, pending)
    void pending.finally(() => {
      pendingOperations.delete(pending)
      if (pendingExposureByFlag.get(details.flagKey) === pending) {
        pendingExposureByFlag.delete(details.flagKey)
      }
    })
  }

  function dropped(
    reason: Extract<SuperflagTrackResult, { status: "dropped" }>["reason"],
    message: string,
    flagKey: string,
    cause?: unknown,
  ): SuperflagTrackResult {
    emitDiagnostic({
      code: "TELEMETRY_DROPPED",
      message,
      severity: "warning",
      flagKey,
      ...(cause === undefined ? {} : { cause }),
    })
    return { status: "dropped", reason, queueSize: adapter.getSnapshot().queueSize }
  }

  async function trackInternal(
    flagKey: string,
    metricKey: string,
    value: number | undefined,
    trackOptions: SuperflagTrackOptions = {},
  ): Promise<SuperflagTrackResult> {
    if (!flagKey.trim() || !metricKey.trim()) {
      return dropped(
        "invalid_outcome",
        "Feature outcome requires non-empty flag and metric keys",
        flagKey,
      )
    }
    if (value !== undefined && !Number.isFinite(value)) {
      return dropped(
        "invalid_outcome",
        "Feature outcome value must be finite when provided",
        flagKey,
      )
    }
    if (
      trackOptions.revision !== undefined &&
      (!Number.isSafeInteger(trackOptions.revision) || trackOptions.revision < 1)
    ) {
      return dropped(
        "invalid_outcome",
        "Feature outcome metric revision must be a positive safe integer",
        flagKey,
      )
    }
    const state = options.getState()
    if (!state.targetingKey) {
      return dropped(
        "missing_identity",
        "Feature outcome requires a configured targeting identity",
        flagKey,
      )
    }
    await pendingExposureByFlag.get(flagKey)
    const exposure = exposureByFlag.get(flagKey)?.event
    if (!exposure) {
      return dropped(
        "missing_exposure",
        "Feature outcome requires a prior value exposure for this flag",
        flagKey,
      )
    }
    try {
      const subject = await subjectFor(state)
      if (abandonPending) {
        return {
          status: "dropped",
          reason: "closed",
          queueSize: adapter.getSnapshot().queueSize,
        }
      }
      if (!subject) {
        return dropped(
          "missing_identity",
          "Feature outcome requires a configured targeting identity",
          flagKey,
        )
      }
      if (
        subject.id !== exposure.subject.id ||
        subject.revision !== exposure.subject.revision ||
        state.config?.source.app !== exposure.source.app ||
        state.config?.source.environment !== exposure.source.environment
      ) {
        return dropped(
          "missing_exposure",
          "Feature outcome requires an exposure for the current subject and environment",
          flagKey,
        )
      }
      const allow = new Set(telemetry.allowedAttributes ?? [])
      const attributes = trackOptions.attributes
        ? Object.fromEntries(
            Object.entries(trackOptions.attributes).filter(([key]) => allow.has(key)),
          ) as Record<string, FeatureEventDimension>
        : undefined
      const outcome = parseFeatureEvent(
        {
          schemaVersion: FEATURE_EVENT_SCHEMA_VERSION,
          id: eventId(),
          kind: "outcome",
          source: exposure.source,
          flagKey: exposure.flagKey,
          variation: exposure.variation,
          configVersion: exposure.configVersion,
          reason: exposure.reason,
          timestamp: new Date().toISOString(),
          sdk: { name: SDK_NAME, version: SDK_VERSION, platform: "browser" },
          subject,
          exposureId: exposure.id,
          metric: { key: metricKey, revision: trackOptions.revision ?? 1 },
          value: value ?? true,
          ...(attributes && Object.keys(attributes).length > 0
            ? { dimensions: attributes }
            : {}),
        },
        { allowedDimensions: telemetry.allowedAttributes ?? [] },
      )
      return adapter.enqueue(outcome)
    } catch (cause) {
      return dropped(
        "invalid_outcome",
        "Feature outcome failed canonical validation",
        flagKey,
        cause,
      )
    }
  }

  function track(
    flagKey: string,
    metricKey: string,
    value?: number,
    trackOptions: SuperflagTrackOptions = {},
  ): Promise<SuperflagTrackResult> {
    if (!accepting) {
      return Promise.resolve({
        status: "dropped",
        reason: "closed",
        queueSize: adapter.getSnapshot().queueSize,
      })
    }
    const pending = trackInternal(flagKey, metricKey, value, trackOptions)
    pendingOperations.add(pending)
    void pending.finally(() => pendingOperations.delete(pending))
    return pending
  }

  async function flush(): Promise<TelemetryFlushResult> {
    await Promise.allSettled([...pendingOperations])
    return adapter.flush()
  }

  async function performControllerShutdown(shutdownOptions: {
    flush?: boolean
    timeoutMs?: number
  }): Promise<TelemetryShutdownResult> {
    const pendingAtShutdown = [...pendingOperations]
    if (shutdownOptions.flush === false || pendingAtShutdown.length === 0) {
      if (shutdownOptions.flush === false) abandonPending = true
      const result = await adapter.shutdown(shutdownOptions)
      return shutdownOptions.flush === false && pendingAtShutdown.length > 0
        ? { ...result, dropped: result.dropped + pendingAtShutdown.length }
        : result
    }

    const configuredTimeout =
      shutdownOptions.timeoutMs ?? telemetry.shutdownTimeoutMs ?? 5_000
    const timeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout >= 0
        ? configuredTimeout
        : 5_000
    const startedAt = Date.now()
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const settled = await Promise.race([
      Promise.allSettled(pendingAtShutdown).then(() => true),
      new Promise<false>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
    if (timeoutHandle) clearTimeout(timeoutHandle)
    const abandoned = settled ? 0 : pendingOperations.size
    if (!settled) abandonPending = true
    const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt))
    const result = await adapter.shutdown({
      ...shutdownOptions,
      timeoutMs: remaining,
    })
    if (settled) return result
    emitDiagnostic({
      code: "TELEMETRY_DROPPED",
      message: "Telemetry identity/outcome work exceeded the shutdown deadline",
      severity: "warning",
    })
    return {
      ...result,
      timedOut: true,
      dropped: result.dropped + abandoned,
    }
  }

  function shutdown(
    shutdownOptions: { flush?: boolean; timeoutMs?: number } = {},
  ): Promise<TelemetryShutdownResult> {
    accepting = false
    shutdownPromise ??= performControllerShutdown(shutdownOptions)
    return shutdownPromise
  }

  function onVisibilityChange(): void {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      void flush()
    }
  }

  function onPageHide(): void {
    void flush()
  }

  function onOnline(): void {
    void flush()
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange)
  }
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", onPageHide)
    window.addEventListener("online", onOnline)
  }

  function destroy(): void {
    if (destroyed) return
    destroyed = true
    accepting = false
    exposureByFlag.clear()
    exposureSequenceByFlag.clear()
    pendingExposureByFlag.clear()
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", onPageHide)
      window.removeEventListener("online", onOnline)
    }
    shutdownPromise ??= performControllerShutdown({})
  }

  return { recordEvaluation, track, flush, shutdown, destroy }
}

export const disabledTelemetryController: BrowserTelemetryController = {
  recordEvaluation() {},
  async track(_flagKey, _metricKey, _value, _options) {
    return { status: "disabled", queueSize: 0 }
  },
  async flush() {
    return emptyFlushResult()
  },
  async shutdown() {
    return emptyShutdownResult()
  },
  destroy() {},
}
