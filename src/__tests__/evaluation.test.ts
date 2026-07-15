import { describe, expect, test } from "bun:test"
import { createEvaluator } from "@superflag-sh/core"
import {
  conformanceConfig,
  conformanceVectors,
  runConformanceVectors,
} from "@superflag-sh/core/conformance"
import { dispatchEvaluationCallbacks } from "../callbacks.js"

describe("shared core evaluation", () => {
  test("passes every canonical conformance vector unchanged", () => {
    const results = runConformanceVectors(conformanceConfig, conformanceVectors)
    expect(results).toHaveLength(conformanceVectors.length)
    expect(results.filter((result) => !result.pass)).toEqual([])
  })

  test("missing identity fails closed to the typed fallback", () => {
    const details = createEvaluator(conformanceConfig).boolean(
      "checkout",
      { targetingKey: "" },
      false,
    )
    expect(details).toMatchObject({
      value: false,
      reason: "DEFAULT",
      errorCode: "INVALID_CONTEXT",
      source: conformanceConfig.source,
      configVersion: conformanceConfig.configVersion,
    })
  })

  test("wrong remote types return a typed fallback with diagnostics detail", () => {
    const details = createEvaluator(conformanceConfig).boolean(
      "scheduled",
      { targetingKey: "user-1" },
      true,
    )
    expect(details).toMatchObject({
      value: true,
      reason: "DEFAULT",
      errorCode: "TYPE_MISMATCH",
    })
  })

  test("evaluation and exposure callback failures are isolated", () => {
    const diagnostics: string[] = []
    const details = {
      ...createEvaluator(conformanceConfig).boolean(
        "checkout",
        { targetingKey: "user-1", attributes: { plan: "pro" } },
        false,
      ),
      source: "network" as const,
      configVersion: conformanceConfig.configVersion,
    }
    expect(() =>
      dispatchEvaluationCallbacks(details, true, {
        onEvaluation: () => { throw new Error("evaluation callback") },
        onExposure: () => { throw new Error("exposure callback") },
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
      }),
    ).not.toThrow()
    expect(diagnostics).toEqual(["CALLBACK_ERROR", "CALLBACK_ERROR"])
  })

  test("provider fallback evaluations never report false exposures", () => {
    const evaluations: string[] = []
    const exposures: string[] = []
    dispatchEvaluationCallbacks(
      {
        flagKey: "checkout",
        value: false,
        reason: "DEFAULT",
        errorCode: "FLAG_NOT_FOUND",
        errorMessage: "not initialized",
        segmentIds: [],
        prerequisites: [],
        source: "default",
        configVersion: null,
        timestamp: new Date().toISOString(),
      },
      true,
      {
        onEvaluation: (event) => evaluations.push(event.flagKey),
        onExposure: (event) => exposures.push(event.flagKey),
      },
    )
    expect(evaluations).toEqual(["checkout"])
    expect(exposures).toEqual([])
  })
})
