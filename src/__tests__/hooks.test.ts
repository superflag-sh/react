import { describe, expect, test } from "bun:test"
import { conformanceConfig } from "@superflag-sh/core/conformance"
import type { SuperflagContextValue } from "../context.js"
import { initialState } from "../context.js"
import {
  contextClientDependencies,
  createContextClient,
  createFlagsResult,
} from "../hooks.js"
import { createEvaluationReader } from "../evaluation.js"

function contextValue(): SuperflagContextValue {
  const evaluations: unknown[] = []
  return {
    ...initialState,
    config: conformanceConfig,
    flags: conformanceConfig.flags,
    status: "ready",
    source: "network",
    appId: conformanceConfig.source.app,
    environment: conformanceConfig.source.environment,
    version: conformanceConfig.configVersion,
    configVersion: conformanceConfig.configVersion,
    fetchedAt: 90_000,
    lastFetchedAt: 90_000,
    age: 10,
    targetingKey: "user-1",
    evaluate: createEvaluationReader({
      config: conformanceConfig,
      context: { targetingKey: "user-1", attributes: { plan: "pro" } },
      source: "network",
      configVersion: conformanceConfig.configVersion,
    }),
    recordEvaluation: (details, exposed) => evaluations.push({ details, exposed }),
    track: async () => ({ status: "queued", queueSize: 1 }),
    flush: async () => ({
      sent: 0,
      accepted: 0,
      duplicates: 0,
      permanent: 0,
      retryScheduled: 0,
      queueSize: 0,
    }),
    shutdown: async () => ({
      sent: 0,
      accepted: 0,
      duplicates: 0,
      permanent: 0,
      retryScheduled: 0,
      queueSize: 0,
      timedOut: false,
      dropped: 0,
    }),
  }
}

describe("public hook projections", () => {
  test("useFlags projection preserves the public state and hides provider internals", () => {
    const result = createFlagsResult(contextValue())

    expect(result).toMatchObject({
      ready: true,
      loading: false,
      appId: conformanceConfig.source.app,
      environment: conformanceConfig.source.environment,
      fetchedAt: 90_000,
      age: 10,
    })
    expect("evaluate" in result).toBeFalse()
    expect("recordEvaluation" in result).toBeFalse()
    expect("track" in result).toBeFalse()
    expect("shutdown" in result).toBeFalse()
  })

  test("imperative client reuses the provider evaluation and exposure Interface", async () => {
    const context = contextValue()
    const recorded: boolean[] = []
    context.recordEvaluation = (_details, exposed) => recorded.push(exposed)
    const client = createContextClient<{ checkout: boolean }>(context)

    expect(client.getFlag("checkout", false)).toBeBoolean()
    expect(client.getFlagDetails("checkout", false).flagKey).toBe("checkout")
    expect(recorded).toEqual([true, false])
    expect(await client.track("checkout", "converted")).toEqual({
      status: "queued",
      queueSize: 1,
    })
  })

  test("imperative client identity ignores unrelated provider state", () => {
    const context = contextValue()
    const refreshedState = { ...context, age: 11, status: "refreshing" as const }

    expect(contextClientDependencies(refreshedState)).toEqual(
      contextClientDependencies(context),
    )
  })
})
