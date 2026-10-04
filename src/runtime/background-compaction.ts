import type { ResponseItemEnvelope } from "../core/rollout.ts"
import { estimateHistoryTokens } from "./model-request-budget.ts"

export type BackgroundCompaction = Readonly<{
  epoch: string
  prefix: readonly ResponseItemEnvelope[]
  replacement: readonly ResponseItemEnvelope[]
  summary: string
}>

// Only a closed prefix may be summarized. The current response and all of its
// tool results stay in the append-only tail, byte-for-byte, until checkpoint.
export function canCompactPrefix(
  prefix: readonly ResponseItemEnvelope[],
): boolean {
  const pending = new Set<string>()
  let hasCompletedTools = false
  for (const { item } of prefix) {
    if (item.role === "assistant") {
      for (const block of item.content) {
        // Opaque checkpoints belong to a provider/account and never enter a
        // local speculative summary, including after a provider switch.
        if (block.type === "compaction") return false
        if (block.type === "tool_call") {
          if (pending.has(block.id)) return false
          pending.add(block.id)
        }
      }
    } else if (item.role === "tool") {
      if (!pending.delete(item.toolCallId)) return false
      hasCompletedTools = true
    }
  }
  return hasCompletedTools && pending.size === 0
}

export function createBackgroundCompaction(
  input: Readonly<{
    epoch: string
    prefix: readonly ResponseItemEnvelope[]
    checkpoint: ResponseItemEnvelope
    summary: string
  }>,
): BackgroundCompaction | undefined {
  // Unlike foreground emergency compaction, speculative work never truncates
  // user constraints or developer instructions to obtain a smaller checkpoint.
  const replacement = [
    ...input.prefix.filter(
      ({ item }) => item.role === "user" || item.role === "developer",
    ),
    input.checkpoint,
  ]
  if (
    estimateHistoryTokens(replacement.map(({ item }) => item)) >=
    estimateHistoryTokens(input.prefix.map(({ item }) => item))
  )
    return undefined
  return {
    epoch: input.epoch,
    prefix: input.prefix,
    replacement,
    summary: input.summary,
  }
}
