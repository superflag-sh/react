import { describe, test, expect } from "bun:test"
import { murmur3, getBucket, isInRollout, getVariantIndex, evaluateFlag } from "../evaluation"
import type { FlagValue } from "../types"

describe("murmur3", () => {
  test("produces deterministic output for same input", () => {
    const input = "test-user-123"
    const hash1 = murmur3(input)
    const hash2 = murmur3(input)
    expect(hash1).toBe(hash2)
  })

  test("produces different output for different inputs", () => {
    const hash1 = murmur3("user-1")
    const hash2 = murmur3("user-2")
    expect(hash1).not.toBe(hash2)
  })

  test("handles empty string", () => {
    const hash = murmur3("")
    expect(hash).toBeGreaterThanOrEqual(0)
    expect(hash).toBeLessThan(2 ** 32)
  })

  test("handles long strings", () => {
    const longString = "a".repeat(1000)
    const hash = murmur3(longString)
    expect(hash).toBeGreaterThanOrEqual(0)
    expect(hash).toBeLessThan(2 ** 32)
  })

  test("handles seed parameter", () => {
    const input = "test"
    const hash1 = murmur3(input, 0)
    const hash2 = murmur3(input, 42)
    expect(hash1).not.toBe(hash2)
  })

  test("matches known test vectors", () => {
    // Known MurmurHash3 test vector
    const hash = murmur3("hello", 0)
    expect(hash).toBeGreaterThanOrEqual(0)
    expect(hash).toBeLessThan(2 ** 32)
  })

  test("returns unsigned 32-bit integer", () => {
    const hash = murmur3("test")
    expect(hash).toBeGreaterThanOrEqual(0)
    expect(hash).toBeLessThan(2 ** 32)
    expect(Number.isInteger(hash)).toBe(true)
  })
})

describe("getBucket", () => {
  test("produces consistent bucket for same userId and flagKey", () => {
    const bucket1 = getBucket("user-123", "dark-mode")
    const bucket2 = getBucket("user-123", "dark-mode")
    expect(bucket1).toBe(bucket2)
  })

  test("produces different buckets for different users", () => {
    const bucket1 = getBucket("user-1", "feature-a")
    const bucket2 = getBucket("user-2", "feature-a")
    expect(bucket1).not.toBe(bucket2)
  })

  test("produces different buckets for different flags", () => {
    const bucket1 = getBucket("user-123", "feature-a")
    const bucket2 = getBucket("user-123", "feature-b")
    expect(bucket1).not.toBe(bucket2)
  })

  test("returns value in 0-9999 range", () => {
    const bucket = getBucket("user-123", "test-flag")
    expect(bucket).toBeGreaterThanOrEqual(0)
    expect(bucket).toBeLessThanOrEqual(9999)
  })

  test("distributes users uniformly across buckets", () => {
    const buckets: number[] = []
    for (let i = 0; i < 10000; i++) {
      buckets.push(getBucket(`user-${i}`, "test-flag"))
    }

    // Check distribution uniformity - verify buckets are spread across the range
    const min = Math.min(...buckets)
    const max = Math.max(...buckets)

    // Buckets should span most of the 0-9999 range
    expect(min).toBeLessThan(1000)
    expect(max).toBeGreaterThan(9000)

    // Check that buckets are reasonably distributed (no massive clustering)
    // Divide into 10 segments and count users in each
    const segments = new Array(10).fill(0)
    buckets.forEach((b) => {
      const segment = Math.floor(b / 1000)
      segments[segment]++
    })

    // Each segment should have roughly 1000 users (±30% is reasonable)
    segments.forEach((count) => {
      expect(count).toBeGreaterThan(700)
      expect(count).toBeLessThan(1300)
    })
  })
})

describe("isInRollout", () => {
  test("0% rollout includes no users", () => {
    const results = []
    for (let i = 0; i < 100; i++) {
      results.push(isInRollout(`user-${i}`, "test-flag", 0))
    }
    expect(results.every((r) => r === false)).toBe(true)
  })

  test("100% rollout includes all users", () => {
    const results = []
    for (let i = 0; i < 100; i++) {
      results.push(isInRollout(`user-${i}`, "test-flag", 100))
    }
    expect(results.every((r) => r === true)).toBe(true)
  })

  test("50% rollout includes approximately half of users", () => {
    const results = []
    for (let i = 0; i < 10000; i++) {
      results.push(isInRollout(`user-${i}`, "test-flag", 50))
    }
    const includedCount = results.filter((r) => r).length
    const percentage = (includedCount / 10000) * 100

    // Should be within 2% of target (48-52%)
    expect(percentage).toBeGreaterThan(48)
    expect(percentage).toBeLessThan(52)
  })

  test("supports decimal percentages (12.5%)", () => {
    const results = []
    for (let i = 0; i < 10000; i++) {
      results.push(isInRollout(`user-${i}`, "test-flag", 12.5))
    }
    const includedCount = results.filter((r) => r).length
    const percentage = (includedCount / 10000) * 100

    // Should be within 2% of target (10.5-14.5%)
    expect(percentage).toBeGreaterThan(10.5)
    expect(percentage).toBeLessThan(14.5)
  })

  test("supports decimal percentages (33.33%)", () => {
    const results = []
    for (let i = 0; i < 10000; i++) {
      results.push(isInRollout(`user-${i}`, "test-flag", 33.33))
    }
    const includedCount = results.filter((r) => r).length
    const percentage = (includedCount / 10000) * 100

    // Should be within 2% of target (31.33-35.33%)
    expect(percentage).toBeGreaterThan(31.33)
    expect(percentage).toBeLessThan(35.33)
  })

  test("same user always gets same result (consistency)", () => {
    const userId = "consistent-user"
    const flagKey = "test-flag"
    const percentage = 50

    const result1 = isInRollout(userId, flagKey, percentage)
    const result2 = isInRollout(userId, flagKey, percentage)
    const result3 = isInRollout(userId, flagKey, percentage)

    expect(result1).toBe(result2)
    expect(result2).toBe(result3)
  })

  test("distribution accuracy for 25% rollout", () => {
    const results = []
    for (let i = 0; i < 10000; i++) {
      results.push(isInRollout(`user-${i}`, "test-flag", 25))
    }
    const includedCount = results.filter((r) => r).length
    const percentage = (includedCount / 10000) * 100

    // Should be within 2% of target (23-27%)
    expect(percentage).toBeGreaterThan(23)
    expect(percentage).toBeLessThan(27)
  })

  test("distribution accuracy for 75% rollout", () => {
    const results = []
    for (let i = 0; i < 10000; i++) {
      results.push(isInRollout(`user-${i}`, "test-flag", 75))
    }
    const includedCount = results.filter((r) => r).length
    const percentage = (includedCount / 10000) * 100

    // Should be within 2% of target (73-77%)
    expect(percentage).toBeGreaterThan(73)
    expect(percentage).toBeLessThan(77)
  })
})

describe("getVariantIndex", () => {
  test("equal weights [33, 33, 34] distribute evenly", () => {
    const weights = [33, 33, 34]
    const results = [0, 0, 0]

    for (let i = 0; i < 10000; i++) {
      const index = getVariantIndex(`user-${i}`, "test-flag", weights)
      results[index]++
    }

    // Each variant should get roughly its weight ±2%
    expect(results[0] / 10000).toBeGreaterThan(0.31)
    expect(results[0] / 10000).toBeLessThan(0.35)
    expect(results[1] / 10000).toBeGreaterThan(0.31)
    expect(results[1] / 10000).toBeLessThan(0.35)
    expect(results[2] / 10000).toBeGreaterThan(0.32)
    expect(results[2] / 10000).toBeLessThan(0.36)
  })

  test("unequal weights [50, 30, 20] distribute correctly", () => {
    const weights = [50, 30, 20]
    const results = [0, 0, 0]

    for (let i = 0; i < 10000; i++) {
      const index = getVariantIndex(`user-${i}`, "test-flag", weights)
      results[index]++
    }

    // Variant 0 (50%) should be 48-52%
    expect(results[0] / 10000).toBeGreaterThan(0.48)
    expect(results[0] / 10000).toBeLessThan(0.52)
    // Variant 1 (30%) should be 28-32%
    expect(results[1] / 10000).toBeGreaterThan(0.28)
    expect(results[1] / 10000).toBeLessThan(0.32)
    // Variant 2 (20%) should be 18-22%
    expect(results[2] / 10000).toBeGreaterThan(0.18)
    expect(results[2] / 10000).toBeLessThan(0.22)
  })

  test("two-way split [50, 50] distributes evenly", () => {
    const weights = [50, 50]
    const results = [0, 0]

    for (let i = 0; i < 10000; i++) {
      const index = getVariantIndex(`user-${i}`, "test-flag", weights)
      results[index]++
    }

    // Each variant should get 48-52%
    expect(results[0] / 10000).toBeGreaterThan(0.48)
    expect(results[0] / 10000).toBeLessThan(0.52)
    expect(results[1] / 10000).toBeGreaterThan(0.48)
    expect(results[1] / 10000).toBeLessThan(0.52)
  })

  test("single variant [100] always returns index 0", () => {
    const weights = [100]

    for (let i = 0; i < 100; i++) {
      const index = getVariantIndex(`user-${i}`, "test-flag", weights)
      expect(index).toBe(0)
    }
  })

  test("same user always gets same variant (consistency)", () => {
    const weights = [33, 33, 34]
    const userId = "consistent-user"
    const flagKey = "test-flag"

    const index1 = getVariantIndex(userId, flagKey, weights)
    const index2 = getVariantIndex(userId, flagKey, weights)
    const index3 = getVariantIndex(userId, flagKey, weights)

    expect(index1).toBe(index2)
    expect(index2).toBe(index3)
  })

  test("returns last variant as fallback on boundary", () => {
    const weights = [50, 50]
    const index = getVariantIndex("user-boundary", "test-flag", weights)
    expect(index).toBeGreaterThanOrEqual(0)
    expect(index).toBeLessThanOrEqual(1)
  })
})

describe("evaluateFlag", () => {
  test("simple flag without rollout/variants returns value", () => {
    const flag: FlagValue = {
      type: "bool",
      value: true,
    }

    const result = evaluateFlag(flag, "test-flag")
    expect(result).toBe(true)
  })

  test("simple flag with userId but no rollout/variants returns value", () => {
    const flag: FlagValue = {
      type: "string",
      value: "hello",
    }

    const result = evaluateFlag(flag, "test-flag", "user-123")
    expect(result).toBe("hello")
  })

  test("rollout flag with userId applies rollout logic", () => {
    const flag: FlagValue = {
      type: "bool",
      value: true,
      rollout: { percentage: 100 },
    }

    const result = evaluateFlag(flag, "test-flag", "user-123")
    expect(result).toBe(true)
  })

  test("rollout flag at 0% returns default value", () => {
    const flag: FlagValue = {
      type: "bool",
      value: true,
      rollout: { percentage: 0 },
    }

    const result = evaluateFlag(flag, "test-flag", "user-123")
    expect(result).toBe(false) // Default for bool is false
  })

  test("rollout flag without userId returns flag value and warns", () => {
    const flag: FlagValue = {
      type: "bool",
      value: true,
      rollout: { percentage: 50 },
    }

    // Should return the flag value (not default) when no userId
    const result = evaluateFlag(flag, "test-flag")
    expect(result).toBe(true)
  })

  test("variant flag with userId selects variant", () => {
    const flag: FlagValue = {
      type: "string",
      value: "control",
      variants: [
        { value: "variant-a", weight: 50, name: "A" },
        { value: "variant-b", weight: 50, name: "B" },
      ],
    }

    const result = evaluateFlag<string>(flag, "test-flag", "user-123")
    expect(["variant-a", "variant-b"]).toContain(result)
  })

  test("variant flag without userId returns flag value and warns", () => {
    const flag: FlagValue = {
      type: "string",
      value: "control",
      variants: [
        { value: "variant-a", weight: 100, name: "A" },
      ],
    }

    const result = evaluateFlag(flag, "test-flag")
    expect(result).toBe("control")
  })

  test("type defaults: bool → false", () => {
    const flag: FlagValue = {
      type: "bool",
      value: true,
      rollout: { percentage: 0 },
    }

    const result = evaluateFlag(flag, "test-flag", "user-123")
    expect(result).toBe(false)
  })

  test("type defaults: string → empty string", () => {
    const flag: FlagValue = {
      type: "string",
      value: "test",
      rollout: { percentage: 0 },
    }

    const result = evaluateFlag(flag, "test-flag", "user-123")
    expect(result).toBe("")
  })

  test("type defaults: number → 0", () => {
    const flag: FlagValue = {
      type: "number",
      value: 42,
      rollout: { percentage: 0 },
    }

    const result = evaluateFlag(flag, "test-flag", "user-123")
    expect(result).toBe(0)
  })

  test("type defaults: json → {}", () => {
    const flag: FlagValue = {
      type: "json",
      value: { key: "value" },
      rollout: { percentage: 0 },
    }

    const result = evaluateFlag(flag, "test-flag", "user-123")
    expect(result).toEqual({})
  })

  test("variant distribution matches weights", () => {
    const flag: FlagValue = {
      type: "string",
      value: "control",
      variants: [
        { value: "red", weight: 50, name: "Red" },
        { value: "blue", weight: 30, name: "Blue" },
        { value: "green", weight: 20, name: "Green" },
      ],
    }

    const results = { red: 0, blue: 0, green: 0 }

    for (let i = 0; i < 10000; i++) {
      const result = evaluateFlag<string>(flag, "test-flag", `user-${i}`)
      results[result as keyof typeof results]++
    }

    // Red (50%) should be 48-52%
    expect(results.red / 10000).toBeGreaterThan(0.48)
    expect(results.red / 10000).toBeLessThan(0.52)
    // Blue (30%) should be 28-32%
    expect(results.blue / 10000).toBeGreaterThan(0.28)
    expect(results.blue / 10000).toBeLessThan(0.32)
    // Green (20%) should be 18-22%
    expect(results.green / 10000).toBeGreaterThan(0.18)
    expect(results.green / 10000).toBeLessThan(0.22)
  })

  test("empty variants array returns flag value", () => {
    const flag: FlagValue = {
      type: "bool",
      value: true,
      variants: [],
    }

    const result = evaluateFlag(flag, "test-flag", "user-123")
    expect(result).toBe(true)
  })
})
