export const RuntimeLimits = {
  modelCallsPerTurn: 16,
  toolCallsPerTurn: 32,
  modelVisibleMessageBlocks: 200,
  modelVisibleContextBytes: 256 * 1024,
  modelVisibleToolResultBytes: 50 * 1024,
  modelVisibleToolResultLines: 2_000,
  rawFileReadBytes: 256 * 1024,
  fileWriteBytes: 1 * 1024 * 1024,
  commandOutputBytes: 1 * 1024 * 1024,
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
  return {
    ...RuntimeLimits,
    ...overrides,
  }
}
