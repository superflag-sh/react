import { afterEach, describe, expect, test } from "bun:test"
import { createEvaluator, parseFeatureEvent } from "@superflag-sh/core"
import type {
  FeatureEvent,
  PseudonymousSubject,
  TelemetryTransport,
} from "@superflag-sh/core"
import { conformanceConfig } from "@superflag-sh/core/conformance"
import {
  createBrowserTelemetryController,
  createHostedTelemetryTransport,
} from "../telemetry.js"
import type { SuperflagDiagnostic, SuperflagState } from "../types.js"

const originalDocument = globalThis.document
const originalWindow = globalThis.window
const originalLocalStorage = globalThis.localStorage

const subject: PseudonymousSubject = {
  id: "psn_0123456789abcdef",
  namespace: "conformance:test",
  revision: 1,
  state: "authenticated",
}

function evaluation(exposedSource: "cache" | "network" = "network") {
  return {
    ...createEvaluator(conformanceConfig).boolean(
      "checkout",
      { targetingKey: "raw-user-secret", attributes: { plan: "pro" } },
      false,
    ),
    source: exposedSource,
    configVersion: conformanceConfig.configVersion,
  } as const
}

function state(): Pick<SuperflagState, "config" | "targetingKey"> {
  return { config: conformanceConfig, targetingKey: "raw-user-secret" }
}

class EventTargetStub {
  readonly listeners = new Map<string, Set<EventListener>>()
  visibilityState: DocumentVisibilityState = "visible"
  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }
  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener)
  }
  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type))
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }
}

afterEach(() => {
  globalThis.document = originalDocument
  globalThis.window = originalWindow
  globalThis.localStorage = originalLocalStorage
})

describe("canonical browser telemetry", () => {
  test("emits one decision for inspection and one deduped exposure for value reads", async () => {
    const delivered: FeatureEvent[] = []
    const transport: TelemetryTransport = {
      async send(events) {
        delivered.push(...events)
        return {
          items: events.map((event) => ({
            eventId: event.id,
            status: "accepted" as const,
          })),
        }
      },
    }
    const controller = createBrowserTelemetryController({
      clientKey: "pub_test_secret",
      telemetry: {
        transport,
        batchSize: 50,
        flushIntervalMs: 60_000,
        pseudonymize: () => subject,
      },
      getState: state,
    })

    expect(delivered).toEqual([])
    controller.recordEvaluation(evaluation(), false)
    controller.recordEvaluation(evaluation(), true)
    controller.recordEvaluation(evaluation(), true)
    await Promise.resolve()
    await controller.flush()

    expect(delivered.map((event) => event.kind)).toEqual(["decision", "exposure"])
    expect(delivered.every((event) => parseFeatureEvent(event))).toBe(true)
    expect(delivered[1]).toMatchObject({
      kind: "exposure",
      flagKey: "checkout",
      sdk: { name: "@superflag-sh/react", version: "0.7.0", platform: "browser" },
      subject,
    })
    const serialized = JSON.stringify(delivered)
    expect(serialized).not.toContain("raw-user-secret")
    expect(serialized).not.toContain("pub_test_secret")
    expect(serialized).not.toContain('"plan"')
    controller.destroy()
  })

  test("tracks binary and numeric outcomes only after exposure with bounded attributes", async () => {
    const delivered: FeatureEvent[] = []
    const diagnostics: SuperflagDiagnostic[] = []
    const controller = createBrowserTelemetryController({
      clientKey: "pub_test",
      telemetry: {
        transport: {
          async send(events) {
            delivered.push(...events)
            return {
              items: events.map((event) => ({
                eventId: event.id,
                status: "accepted" as const,
              })),
            }
          },
        },
        allowedAttributes: ["plan"],
        flushIntervalMs: 60_000,
        pseudonymize: () => subject,
      },
      getState: state,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })

    await expect(controller.track("checkout", "revenue", 12)).resolves.toMatchObject({
      status: "dropped",
      reason: "missing_exposure",
    })
    await expect(controller.track("", "revenue")).resolves.toMatchObject({
      status: "dropped",
      reason: "invalid_outcome",
    })
    await expect(controller.track("checkout", "revenue", Number.NaN)).resolves.toMatchObject({
      status: "dropped",
      reason: "invalid_outcome",
    })
    controller.recordEvaluation(evaluation(), true)
    await expect(
      controller.track("checkout", "revenue", 12.5, {
        revision: 2,
        attributes: { plan: "pro", rawEmail: "private@example.com" },
      }),
    ).resolves.toMatchObject({ status: "queued" })
    await expect(controller.track("checkout", "purchase")).resolves.toMatchObject({
      status: "queued",
    })
    await controller.flush()

    const exposure = delivered.find((event) => event.kind === "exposure")
    const outcomes = delivered.filter((event) => event.kind === "outcome")
    expect(outcomes[0]).toMatchObject({
      kind: "outcome",
      flagKey: "checkout",
      exposureId: exposure?.id,
      metric: { key: "revenue", revision: 2 },
      value: 12.5,
      dimensions: { plan: "pro" },
    })
    expect(outcomes[1]).toMatchObject({
      kind: "outcome",
      exposureId: exposure?.id,
      metric: { key: "purchase", revision: 1 },
      value: true,
    })
    expect(outcomes[0]?.id).not.toBe(outcomes[1]?.id)
    expect(JSON.stringify(outcomes)).not.toContain("private@example.com")
    expect(diagnostics.some((entry) => entry.code === "TELEMETRY_DROPPED")).toBe(true)
    controller.destroy()
  })

  test("rejects identity changes until a new exposure and then uses the latest exposure", async () => {
    const events: FeatureEvent[] = []
    let targetingKey = "first-user"
    const controller = createBrowserTelemetryController({
      clientKey: "pub_test",
      telemetry: {
        onEvent: (event) => events.push(event),
        pseudonymize: ({ targetingKey: key }) => ({
          ...subject,
          id: key === "first-user"
            ? "psn_1111111111111111"
            : "psn_2222222222222222",
        }),
      },
      getState: () => ({ config: conformanceConfig, targetingKey }),
    })

    controller.recordEvaluation(evaluation(), true)
    await expect(controller.track("checkout", "purchase")).resolves.toMatchObject({
      status: "callback_only",
    })
    targetingKey = "second-user"
    await expect(controller.track("checkout", "purchase")).resolves.toMatchObject({
      status: "dropped",
      reason: "missing_exposure",
    })
    controller.recordEvaluation(
      { ...evaluation(), variation: "second-variation" },
      true,
    )
    await expect(controller.track("checkout", "purchase")).resolves.toMatchObject({
      status: "callback_only",
    })

    const exposures = events.filter((event) => event.kind === "exposure")
    const outcomes = events.filter((event) => event.kind === "outcome")
    expect(exposures).toHaveLength(2)
    expect(outcomes.at(-1)).toMatchObject({
      exposureId: exposures.at(-1)?.id,
      variation: "second-variation",
    })
    controller.destroy()
  })

  test("reports a missing identity before attempting exposure attribution", async () => {
    const controller = createBrowserTelemetryController({
      clientKey: "pub_test",
      telemetry: { onEvent: () => {} },
      getState: () => ({ config: conformanceConfig }),
    })
    await expect(controller.track("checkout", "purchase")).resolves.toMatchObject({
      status: "dropped",
      reason: "missing_identity",
    })
    controller.destroy()
  })

  test("default identity is install-stable without persisting raw identifiers or keys", async () => {
    const values = new Map<string, string>()
    globalThis.localStorage = {
      get length() {
        return values.size
      },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => {
        values.delete(key)
      },
      setItem: (key, value) => {
        values.set(key, value)
      },
    }
    const subjects: PseudonymousSubject[] = []
    for (let index = 0; index < 2; index += 1) {
      const controller = createBrowserTelemetryController({
        clientKey: "pub_raw_client_key",
        telemetry: {
          onEvent: (event) => subjects.push(event.subject),
        },
        getState: state,
      })
      controller.recordEvaluation(evaluation(), true)
      await controller.flush()
      controller.destroy()
    }
    expect(subjects).toHaveLength(2)
    expect(subjects[0]?.id).toBe(subjects[1]?.id)
    const persisted = JSON.stringify([...values.entries()])
    expect(persisted).not.toContain("raw-user-secret")
    expect(persisted).not.toContain("pub_raw_client_key")
  })

  test("transport failures stay fail-open and produce diagnostics", async () => {
    const callbacks: string[] = []
    const diagnostics: SuperflagDiagnostic[] = []
    const controller = createBrowserTelemetryController({
      clientKey: "pub_test",
      telemetry: {
        transport: {
          async send() {
            throw new Error("offline")
          },
        },
        onEvent: (event) => callbacks.push(event.kind),
        maxAttempts: 1,
        flushIntervalMs: 60_000,
        pseudonymize: () => subject,
      },
      getState: state,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })

    expect(() => controller.recordEvaluation(evaluation("cache"), true)).not.toThrow()
    await Promise.resolve()
    await expect(controller.flush()).resolves.toMatchObject({ permanent: 1 })
    expect(callbacks).toEqual(["exposure"])
    expect(
      diagnostics.some(
        (entry) =>
          entry.code === "TELEMETRY_ERROR" && entry.telemetryCode === "transport_error",
      ),
    ).toBe(true)
    controller.destroy()
  })

  test("bounds shutdown even when a custom pseudonymizer never settles", async () => {
    const controller = createBrowserTelemetryController({
      clientKey: "pub_test",
      telemetry: {
        onEvent: () => {},
        shutdownTimeoutMs: 5,
        pseudonymize: () => new Promise(() => {}),
      },
      getState: state,
    })
    controller.recordEvaluation(evaluation(), true)
    await expect(controller.shutdown()).resolves.toMatchObject({
      timedOut: true,
      dropped: 1,
    })
    controller.destroy()
  })

  test("flushes opportunistically when the page is hidden", async () => {
    const documentTarget = new EventTargetStub()
    const windowTarget = new EventTargetStub()
    globalThis.document = documentTarget as unknown as Document
    globalThis.window = windowTarget as unknown as Window & typeof globalThis
    let sends = 0
    const controller = createBrowserTelemetryController({
      clientKey: "pub_test",
      telemetry: {
        transport: {
          async send(events) {
            sends += 1
            return {
              items: events.map((event) => ({
                eventId: event.id,
                status: "accepted" as const,
              })),
            }
          },
        },
        flushIntervalMs: 60_000,
        pseudonymize: () => subject,
      },
      getState: state,
    })
    controller.recordEvaluation(evaluation(), true)
    await Promise.resolve()
    documentTarget.visibilityState = "hidden"
    documentTarget.dispatch("visibilitychange")
    await Promise.resolve()
    await controller.flush()
    expect(sends).toBe(1)
    controller.destroy()
    expect(documentTarget.count("visibilitychange")).toBe(0)
    expect(windowTarget.count("pagehide")).toBe(0)
    expect(windowTarget.count("online")).toBe(0)
  })
})

describe("hosted telemetry transport", () => {
  test("uses the versioned batch envelope and normalizes a config URL base", async () => {
    let request: { url: string; init?: RequestInit } | undefined
    const transport = createHostedTelemetryTransport({
      clientKey: "pub_environment",
      baseUrl: "https://flags.example.com/api/v1/public-config?ignored=true",
      fetch: async (input, init) => {
        request = { url: String(input), init }
        return Response.json({
          apiVersion: 1,
          schemaVersion: 1,
          items: [{ eventId: "event-1", status: "accepted" }],
        })
      },
    })
    const event = parseFeatureEvent({
      schemaVersion: 1,
      id: "event-1",
      kind: "exposure",
      source: { app: "conformance", environment: "test" },
      flagKey: "checkout",
      variation: "on",
      configVersion: 1,
      reason: "FALLTHROUGH",
      timestamp: "2026-07-14T00:00:00.000Z",
      sdk: { name: "test", version: "1", platform: "browser" },
      subject,
    })
    const result = await transport.send([event], {
      signal: new AbortController().signal,
    })
    expect(result.items).toEqual([{ eventId: "event-1", status: "accepted" }])
    expect(request?.url).toBe("https://flags.example.com/api/v1/events/batch")
    const headers = new Headers(request?.init?.headers)
    expect(headers.get("Authorization")).toBe("Bearer pub_environment")
    expect(headers.get("Content-Type")).toBe("application/json")
    expect(headers.get("X-Request-ID")).toBeTruthy()
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      schemaVersion: 1,
      events: [event],
    })
  })

  test("preserves ordered item-level results from a rate-limited batch", async () => {
    const transport = createHostedTelemetryTransport({
      clientKey: "pub_environment",
      fetch: async () =>
        Response.json(
          {
            apiVersion: 1,
            schemaVersion: 1,
            requestId: "request-1",
            items: [
              {
                eventId: "event-1",
                status: "retryable_error",
                code: "rate_limited",
                retryAfterMs: 2_000,
              },
              {
                eventId: "event-2",
                status: "permanent_error",
                code: "invalid_event",
              },
            ],
          },
          { status: 429 },
        ),
    })
    const base = {
      schemaVersion: 1,
      kind: "exposure",
      source: { app: "conformance", environment: "test" },
      flagKey: "checkout",
      variation: "on",
      configVersion: 1,
      reason: "FALLTHROUGH",
      timestamp: "2026-07-14T00:00:00.000Z",
      sdk: { name: "test", version: "1", platform: "browser" },
      subject,
    } as const
    const result = await transport.send(
      [
        parseFeatureEvent({ ...base, id: "event-1" }),
        parseFeatureEvent({ ...base, id: "event-2" }),
      ],
      { signal: new AbortController().signal },
    )
    expect(result.items).toEqual([
      {
        eventId: "event-1",
        status: "retryable_error",
        code: "rate_limited",
        retryAfterMs: 2_000,
      },
      {
        eventId: "event-2",
        status: "permanent_error",
        code: "invalid_event",
      },
    ])
  })

  test("splits worst-case valid batches below the hosted body limit", async () => {
    const requestSizes: number[] = []
    const transport = createHostedTelemetryTransport({
      clientKey: "pub_environment",
      fetch: async (_input, init) => {
        const body = String(init?.body)
        requestSizes.push(new TextEncoder().encode(body).byteLength)
        const request = JSON.parse(body) as { events: FeatureEvent[] }
        return Response.json({
          apiVersion: 1,
          schemaVersion: 1,
          items: request.events.map((event) => ({
            eventId: event.id,
            status: "accepted",
          })),
        })
      },
    })
    const dimensions = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [
        `d${index}_${"k".repeat(80)}`,
        "v".repeat(64),
      ]),
    )
    const events = Array.from({ length: 100 }, (_, index) =>
      ({
        schemaVersion: 1,
        id: `event-${String(index).padStart(3, "0")}-${"i".repeat(100)}`,
        kind: "exposure",
        source: { app: "a".repeat(90), environment: "e".repeat(90) },
        flagKey: "f".repeat(90),
        variation: "v".repeat(90),
        configVersion: 1,
        reason: "FALLTHROUGH",
        timestamp: "2026-07-14T00:00:00.000Z",
        sdk: { name: "s".repeat(90), version: "1".repeat(90), platform: "browser" },
        subject: {
          id: `psn_${"p".repeat(90)}`,
          namespace: "n".repeat(90),
          revision: 1,
          state: "authenticated",
        },
        experiment: {
          experimentId: `x${"e".repeat(120)}`,
          iterationId: `x${"i".repeat(120)}`,
        },
        dimensions,
      }) as FeatureEvent,
    )
    const result = await transport.send(events, {
      signal: new AbortController().signal,
    })
    expect(requestSizes.length).toBeGreaterThan(1)
    expect(requestSizes.every((size) => size <= 250 * 1_024)).toBe(true)
    expect(result.items.map((item) => item.eventId)).toEqual(
      events.map((event) => event.id),
    )
  })
})
