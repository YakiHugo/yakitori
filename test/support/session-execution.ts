import type { Session, SessionSnapshot } from "../../src/core/session.ts"
import type { ExecutionContext } from "../../src/core/session-task.ts"
import type { TurnInput } from "../../src/core/session-io.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"

// Test callbacks bind the real Session domain methods; persistence, leases,
// ordering and task settlement are exercised by the production owner.
const methods = [
  "recordThreadMessageInput",
  "recordModelAttempt",
  "recordInitialInput",
  "recordModelContext",
  "checkpointUsage",
  "recordRequestStartedAt",
  "invalidateRequestStartedAt",
  "recordTurnMetrics",
  "recordContextTokens",
  "emitModelStream",
  "emitWarning",
  "emitItemStarted",
  "recordToolStarted",
  "emitPermissionEvent",
  "recordConversationItems",
  "recordItemCompletions",
  "recordToolResult",
  "recordWorldStateUpdate",
  "checkpointHistory",
] as const

type BoundMethod<T> = T extends (
  execution: ExecutionContext,
  ...args: infer A
) => infer R
  ? (...args: A) => R
  : never
export type TestTurnRuntime = {
  [K in (typeof methods)[number]]: BoundMethod<Session[K]>
} & { snapshot(): SessionSnapshot }

export function bindExecution(
  session: Session,
  execution: ExecutionContext,
): TestTurnRuntime {
  return {
    recordThreadMessageInput: (
      ...args: Parameters<TestTurnRuntime["recordThreadMessageInput"]>
    ) => session.recordThreadMessageInput(execution, ...args),
    recordModelAttempt: (
      ...args: Parameters<TestTurnRuntime["recordModelAttempt"]>
    ) => session.recordModelAttempt(execution, ...args),
    recordInitialInput: (
      ...args: Parameters<TestTurnRuntime["recordInitialInput"]>
    ) => session.recordInitialInput(execution, ...args),
    recordModelContext: (
      ...args: Parameters<TestTurnRuntime["recordModelContext"]>
    ) => session.recordModelContext(execution, ...args),
    snapshot: (...args: Parameters<TestTurnRuntime["snapshot"]>) =>
      session.executionSnapshot(execution, ...args),
    checkpointUsage: (
      ...args: Parameters<TestTurnRuntime["checkpointUsage"]>
    ) => session.checkpointUsage(execution, ...args),
    recordRequestStartedAt: (
      ...args: Parameters<TestTurnRuntime["recordRequestStartedAt"]>
    ) => session.recordRequestStartedAt(execution, ...args),
    invalidateRequestStartedAt: (
      ...args: Parameters<TestTurnRuntime["invalidateRequestStartedAt"]>
    ) => session.invalidateRequestStartedAt(execution, ...args),
    recordTurnMetrics: (
      ...args: Parameters<TestTurnRuntime["recordTurnMetrics"]>
    ) => session.recordTurnMetrics(execution, ...args),
    recordContextTokens: (
      ...args: Parameters<TestTurnRuntime["recordContextTokens"]>
    ) => session.recordContextTokens(execution, ...args),
    emitModelStream: (
      ...args: Parameters<TestTurnRuntime["emitModelStream"]>
    ) => session.emitModelStream(execution, ...args),
    emitWarning: (...args: Parameters<TestTurnRuntime["emitWarning"]>) =>
      session.emitWarning(execution, ...args),
    emitItemStarted: (
      ...args: Parameters<TestTurnRuntime["emitItemStarted"]>
    ) => session.emitItemStarted(execution, ...args),
    recordToolStarted: (
      ...args: Parameters<TestTurnRuntime["recordToolStarted"]>
    ) => session.recordToolStarted(execution, ...args),
    emitPermissionEvent: (
      ...args: Parameters<TestTurnRuntime["emitPermissionEvent"]>
    ) => session.emitPermissionEvent(execution, ...args),
    recordConversationItems: (
      ...args: Parameters<TestTurnRuntime["recordConversationItems"]>
    ) => session.recordConversationItems(execution, ...args),
    recordItemCompletions: (
      ...args: Parameters<TestTurnRuntime["recordItemCompletions"]>
    ) => session.recordItemCompletions(execution, ...args),
    recordToolResult: (
      ...args: Parameters<TestTurnRuntime["recordToolResult"]>
    ) => session.recordToolResult(execution, ...args),
    recordWorldStateUpdate: (
      ...args: Parameters<TestTurnRuntime["recordWorldStateUpdate"]>
    ) => session.recordWorldStateUpdate(execution, ...args),
    checkpointHistory: (
      ...args: Parameters<TestTurnRuntime["checkpointHistory"]>
    ) => session.checkpointHistory(execution, ...args),
  }
}
export function testTurnContext(snapshot: SessionSnapshot, input: TurnInput) {
  const selection = input.modelSelection ??
    snapshot.configuration?.defaultTarget ?? {
      provider: "faux",
      model: "scripted",
    }
  return {
    turnId: input.submissionId,
    selection,
    configuration: SessionConfiguration.create({
      selection,
      workspaceRoot: snapshot.metadata.workingDirectory ?? process.cwd(),
      enabledTools: [],
      approvalPolicy: "always_approve",
      promptCacheKey: snapshot.metadata.conversationId,
    }).snapshot,
  }
}
