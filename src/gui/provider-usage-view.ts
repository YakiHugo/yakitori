import type { ModelUsage } from "../core/sqlite-thread-usage-projection.ts"
import type { ConfiguredModel } from "../runtime/provider-presets.ts"

// Historical token counts are priced with the current catalog/user rates.
// Missing cache prices stay unknown rather than borrowing the input rate.
export function estimateModelCost(
  usage: ModelUsage,
  pricing: ConfiguredModel["pricing"],
): number | undefined {
  if (
    !pricing ||
    (usage.cacheReadInputTokens > 0 &&
      pricing.cacheReadPerMillion === undefined) ||
    (usage.cacheWriteInputTokens > 0 &&
      pricing.cacheWritePerMillion === undefined)
  )
    return undefined
  const uncached = Math.max(
    0,
    usage.inputTokens -
      usage.cacheReadInputTokens -
      usage.cacheWriteInputTokens,
  )
  return (
    (uncached * pricing.inputPerMillion +
      usage.outputTokens * pricing.outputPerMillion +
      usage.cacheReadInputTokens * (pricing.cacheReadPerMillion ?? 0) +
      usage.cacheWriteInputTokens * (pricing.cacheWritePerMillion ?? 0)) /
    1_000_000
  )
}
