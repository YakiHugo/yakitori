export const RuntimeLimits = {
  modelCallsPerTurn: 16,
  toolCallsPerTurn: 32,
  modelVisibleMessageBlocks: 200,
  modelVisibleContextBytes: 256 * 1024,
  compactionTriggerRatio: 0.8,
  compactionRetainRatio: 0.16,
  modelVisibleToolResultBytes: 50 * 1024,
  modelVisibleToolResultLines: 2_000,
  compactionSummaryBytes: 16 * 1024,
  fileWriteBytes: 1 * 1024 * 1024,
  toolDiffBytes: 64 * 1024,
  commandOutputBytes: 1 * 1024 * 1024,
  commandPersistedOutputBytes: 32 * 1024 * 1024,
  commandTextBytes: 16 * 1024,
  assistantResponseBytes: 256 * 1024,
  runCommandDefaultTimeoutSeconds: 120,
  runCommandMaxTimeoutSeconds: 600,
  permissionWaitTimeoutMs: 10 * 60 * 1000,
  commandKillGraceMs: 2_000,
  assistantSnapshotPublicationsPerSecond: 20,
} as const

export type RuntimeLimits = {
  readonly [K in keyof typeof RuntimeLimits]: number
}

export function createRuntimeLimits(
  overrides: Partial<RuntimeLimits> = {},
): RuntimeLimits {
  const limits = {
    ...RuntimeLimits,
    ...overrides,
  }
  if (limits.compactionTriggerRatio <= 0 || limits.compactionTriggerRatio > 1) {
    throw new Error(
      "compactionTriggerRatio must be greater than 0 and at most 1.",
    )
  }
  if (
    limits.compactionRetainRatio < 0 ||
    limits.compactionRetainRatio >= limits.compactionTriggerRatio
  ) {
    throw new Error(
      "compactionRetainRatio must be non-negative and less than compactionTriggerRatio.",
    )
  }
  return limits
}

export function deriveCompactionContextBytes(input: {
  readonly modelVisibleContextBytes: number
  readonly triggerRatio: number
  readonly retainRatio: number
}): {
  readonly triggerBytes: number
  readonly retainBytes: number
} {
  return {
    triggerBytes: Math.floor(
      input.modelVisibleContextBytes * input.triggerRatio,
    ),
    retainBytes: Math.floor(input.modelVisibleContextBytes * input.retainRatio),
  }
}

// Byte measurement is the harness's tokenizer-free capacity proxy. Keep the
// full estimated window here; proactive compaction ratios reserve headroom.
export function deriveModelVisibleContextBytes(
  contextWindowTokens: number,
): number {
  if (!Number.isInteger(contextWindowTokens) || contextWindowTokens <= 0) {
    throw new Error("contextWindowTokens must be a positive integer.")
  }
  return contextWindowTokens * 4
}
