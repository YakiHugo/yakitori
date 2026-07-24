import type { JsonObject, JsonValue } from "../../kernel/index.ts"

export type ToolExecutionContext = {
  readonly workspaceRoot: string
  readonly signal?: AbortSignal
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
  execute(
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>
}
