import type { JsonObject, JsonValue } from "../../kernel/index.ts"
import type { VisibleFileObservations } from "./visible-file-observations.ts"

export type ToolEffect = "observe" | "mutate" | "opaque"

export type SubagentResult =
  | {
      readonly ok: true
      readonly sessionId: string
      readonly text: string
    }
  | {
      readonly ok: false
      readonly sessionId: string
      readonly error: string
      readonly partialText?: string
    }

export type SpawnSubagent = (input: {
  readonly agent: "general" | "explore"
  readonly description: string
  readonly prompt: string
}) => Promise<SubagentResult>

export type ToolExecutionContext = {
  readonly workspaceRoot: string
  readonly signal?: AbortSignal
  readonly visibleFileObservations?: VisibleFileObservations
  // Present only for root sessions; subagent sessions never receive it, which
  // caps delegation depth at 1.
  readonly spawnSubagent?: SpawnSubagent
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
