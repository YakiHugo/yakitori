import type { SessionExecutionPolicyDefaultsSnapshot } from "../kernel/events.ts"

export const SessionExecutionPolicyDefaults = {
  modelVisibleToolResultBytes: 50 * 1024,
  modelVisibleToolResultLines: 2_000,
  assistantResponseBytes: 256 * 1024,
} as const satisfies SessionExecutionPolicyDefaultsSnapshot

// Server input bytes are an admission safety boundary, separate from the
// model context and auto-compaction token budgets.
export const DEFAULT_INPUT_ADMISSION_BYTES = 256 * 1024

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
  return {
    modelVisibleToolResultBytes:
      overrides.modelVisibleToolResultBytes ??
      SessionExecutionPolicyDefaults.modelVisibleToolResultBytes,
    modelVisibleToolResultLines:
      overrides.modelVisibleToolResultLines ??
      SessionExecutionPolicyDefaults.modelVisibleToolResultLines,
    assistantResponseBytes:
      overrides.assistantResponseBytes ??
      SessionExecutionPolicyDefaults.assistantResponseBytes,
  }
}
