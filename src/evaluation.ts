import type { FlagValue } from "./types"

/**
 * MurmurHash3 32-bit implementation
 * Based on industry standard used by Unleash, Amplitude, Optimizely
 * @see https://github.com/aappleby/smhasher/blob/master/src/MurmurHash3.cpp
 */
export function murmur3(key: string, seed: number = 0): number {
  const remainder = key.length % 4
  const bytes = key.length - remainder
  let h1 = seed
  const c1 = 0xcc9e2d51
  const c2 = 0x1b873593
  let i = 0

  while (i < bytes) {
    let k1 =
      (key.charCodeAt(i) & 0xff) |
      ((key.charCodeAt(++i) & 0xff) << 8) |
      ((key.charCodeAt(++i) & 0xff) << 16) |
      ((key.charCodeAt(++i) & 0xff) << 24)
    ++i

    k1 = Math.imul(k1, c1)
    k1 = (k1 << 15) | (k1 >>> 17)
    k1 = Math.imul(k1, c2)

    h1 ^= k1
    h1 = (h1 << 13) | (h1 >>> 19)
    h1 = Math.imul(h1, 5) + 0xe6546b64
  }

  let k1 = 0
  if (remainder === 3) {
    k1 ^= (key.charCodeAt(i + 2) & 0xff) << 16
  }
  if (remainder >= 2) {
    k1 ^= (key.charCodeAt(i + 1) & 0xff) << 8
  }
  if (remainder >= 1) {
    k1 ^= key.charCodeAt(i) & 0xff
    k1 = Math.imul(k1, c1)
    k1 = (k1 << 15) | (k1 >>> 17)
    k1 = Math.imul(k1, c2)
    h1 ^= k1
  }

  h1 ^= key.length
  h1 ^= h1 >>> 16
  h1 = Math.imul(h1, 0x85ebca6b)
  h1 ^= h1 >>> 13
  h1 = Math.imul(h1, 0xc2b2ae35)
  h1 ^= h1 >>> 16

  return h1 >>> 0 // Convert to unsigned 32-bit integer
}

/**
 * Calculate bucket (0-9999) for userId + flagKey combination
 * Uses modulo 10000 for 0.01% precision
 */
export function getBucket(userId: string, flagKey: string): number {
  const hashInput = `${userId}:${flagKey}`
  const hash = murmur3(hashInput)
  return hash % 10000
}

/**
 * Check if user is in rollout percentage
 * @param percentage - 0-100, supports decimals (e.g., 12.5)
 */
export function isInRollout(userId: string, flagKey: string, percentage: number): boolean {
  const bucket = getBucket(userId, flagKey)
  const threshold = Math.floor(percentage * 100) // Convert to 0-10000 range
  return bucket < threshold
}

/**
 * Get variant index for A/B test
 * @param weights - Array of weights that sum to 100
 */
export function getVariantIndex(userId: string, flagKey: string, weights: number[]): number {
  const bucket = getBucket(userId, flagKey)
  const bucketPercentage = bucket / 100 // Convert 0-9999 to 0-99.99

  let cumulative = 0
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i]
    if (bucketPercentage < cumulative) {
      return i
    }
  }

  return weights.length - 1 // Fallback to last variant
}

/**
 * Get default value for a flag type (used as rollout fallback)
 */
function getDefaultForType(type: FlagValue["type"]): unknown {
  switch (type) {
    case "bool":
      return false
    case "string":
      return ""
    case "number":
      return 0
    case "json":
      return {}
  }
}

/**
 * Evaluate a flag value based on rollout/variant configuration
 * @param flag - The flag configuration from server
 * @param flagKey - The flag key (for hashing)
 * @param userId - Optional user ID for bucketing
 * @returns Evaluated flag value
 */
export function evaluateFlag<T = unknown>(flag: FlagValue, flagKey: string, userId?: string): T {
  // No rollout/variants = simple flag
  if (!flag.rollout && !flag.variants) {
    return flag.value as T
  }

  // Rollout/variants require userId
  if (!userId) {
    console.warn(
      `[superflag] Flag "${flagKey}" has rollout/variants but no userId provided. ` +
        `Returning default value. Pass userId to SuperflagProvider.`
    )
    return flag.value as T
  }

  // Gradual rollout
  if (flag.rollout) {
    const inRollout = isInRollout(userId, flagKey, flag.rollout.percentage)
    return (inRollout ? flag.value : getDefaultForType(flag.type)) as T
  }

  // A/B test variants
  if (flag.variants && flag.variants.length > 0) {
    const weights = flag.variants.map((v) => v.weight)
    const index = getVariantIndex(userId, flagKey, weights)
    return flag.variants[index].value as T
  }

  return flag.value as T
}
