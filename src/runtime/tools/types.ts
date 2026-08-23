import type { JsonObject, JsonValue } from "../../kernel/index.ts"
import type { SessionFiles } from "../../kernel/session-files.ts"
import type { BoundAgentControl } from "../agent-control.ts"
import type { VisibleFileObservations } from "./visible-file-observations.ts"

export type ToolEffect = "observe" | "mutate" | "opaque"

export type ToolExecutionContext = {
  readonly workspaceRoot: string
  readonly sessionId?: string
  readonly toolCallId?: string
  readonly sessionFiles?: SessionFiles
  readonly signal?: AbortSignal
  readonly visibleFileObservations?: VisibleFileObservations
  readonly agentControl?: BoundAgentControl
}

export type ToolSuccess = {
  readonly ok: true
  readonly output: JsonValue
  readonly content: string
}

export type ToolFailure = {
  readonly ok: false
  readonly code: string
  readonly message: string
  readonly content: string
  readonly output?: JsonValue
}

export type ToolExecutionResult = ToolSuccess | ToolFailure

export type RuntimeTool = {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonObject
  readonly autoAllow: boolean
  readonly effect: ToolEffect
  execute(
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>
}
