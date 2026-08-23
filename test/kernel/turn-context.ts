import type { TurnExecutionContext } from "../../src/kernel/events.ts"

export function testTurnExecutionContext(
  overrides: Partial<TurnExecutionContext> = {},
): TurnExecutionContext {
  return {
    mateId: "mate_test",
    mateRevisionId: "mate_revision_test",
    provider: "faux",
    model: "scripted",
    promptId: "default",
    baseInstructionsRevision: "base_test",
    modelInstructionsRevision: "model_test",
    workingDirectory: "/tmp",
    enabledTools: [],
    approvalPolicy: "never",
    executionPolicy: {
      modelCallsPerTurn: 16,
      toolCallsPerTurn: 32,
      modelVisibleMessageBlocks: 200,
      modelVisibleContextBytes: 256_000,
      compactionTriggerContextBytes: 204_800,
      compactionRetainContextBytes: 40_960,
      modelVisibleToolResultBytes: 50_000,
      modelVisibleToolResultLines: 2_000,
      assistantResponseBytes: 256_000,
    },
    ...overrides,
  }
}
