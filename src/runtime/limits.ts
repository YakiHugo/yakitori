import type { SessionExecutionPolicyDefaultsSnapshot } from "../kernel/events.ts"

export const SessionExecutionPolicyDefaults = {
  modelCallsPerTurn: 16,
  toolCallsPerTurn: 32,
  modelVisibleMessageBlocks: 200,
  modelVisibleContextBytes: 256 * 1024,
  compactionTriggerRatio: 0.8,
  compactionRetainRatio: 0.16,
  modelVisibleToolResultBytes: 50 * 1024,
  modelVisibleToolResultLines: 2_000,
  compactionSummaryBytes: 16 * 1024,
  assistantResponseBytes: 256 * 1024,
} as const satisfies SessionExecutionPolicyDefaultsSnapshot

// Tool-installation defaults are intentionally absent from Session history.
export type ToolLimitPolicy = Readonly<{
  toolPreviewBytes: number
  toolPreviewLines: number
  fileWriteBytes: number
  toolDiffBytes: number
  commandOutputBytes: number
  commandPersistedOutputBytes: number
  commandTextBytes: number
  runCommandDefaultTimeoutSeconds: number
  runCommandMaxTimeoutSeconds: number
  commandKillGraceMs: number
}>

export type RunnerTimingPolicy = Readonly<{
  permissionWaitTimeoutMs: number
  assistantSnapshotPublicationsPerSecond: number
}>

export const ToolLimitDefaults = {
  toolPreviewBytes: 50 * 1024,
  toolPreviewLines: 2_000,
  fileWriteBytes: 1 * 1024 * 1024,
  toolDiffBytes: 64 * 1024,
  commandOutputBytes: 1 * 1024 * 1024,
  commandPersistedOutputBytes: 32 * 1024 * 1024,
  commandTextBytes: 16 * 1024,
  runCommandDefaultTimeoutSeconds: 120,
  runCommandMaxTimeoutSeconds: 600,
  commandKillGraceMs: 2_000,
} as const satisfies ToolLimitPolicy

export const RunnerTimingDefaults = {
  permissionWaitTimeoutMs: 10 * 60 * 1000,
  // This bounds transient SSE/renderer churn, not model sampling or fsync.
  assistantSnapshotPublicationsPerSecond: 10,
} as const satisfies RunnerTimingPolicy

export function createRunnerTimingPolicy(
  overrides: Partial<RunnerTimingPolicy> = {},
): RunnerTimingPolicy {
  return { ...RunnerTimingDefaults, ...overrides }
}

export type SessionExecutionPolicy = SessionExecutionPolicyDefaultsSnapshot

export function createSessionExecutionPolicy(
  overrides: Partial<SessionExecutionPolicy> = {},
): SessionExecutionPolicy {
  const policy = {
    ...SessionExecutionPolicyDefaults,
    ...overrides,
  }
  if (policy.compactionTriggerRatio <= 0 || policy.compactionTriggerRatio > 1) {
    throw new Error(
      "compactionTriggerRatio must be greater than 0 and at most 1.",
    )
  }
  if (
    policy.compactionRetainRatio < 0 ||
    policy.compactionRetainRatio >= policy.compactionTriggerRatio
  ) {
    throw new Error(
      "compactionRetainRatio must be non-negative and less than compactionTriggerRatio.",
    )
  }
  return policy
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

// A tokenizer-free fallback used only when a model catalog does not provide a
// more specific estimator. Complete-request budgeting owns the final decision.
export function deriveModelVisibleContextBytes(
  contextWindowTokens: number,
): number {
  if (!Number.isInteger(contextWindowTokens) || contextWindowTokens <= 0) {
    throw new Error("contextWindowTokens must be a positive integer.")
  }
  return contextWindowTokens * 4
}
