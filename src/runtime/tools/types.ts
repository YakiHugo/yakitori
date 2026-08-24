import type {
  JsonObject,
  JsonValue,
  ToolExecutionDescriptor,
} from "../../kernel/index.ts"
import type { SessionFiles } from "../../kernel/session-files.ts"
import type { BoundAgentControl } from "../agent-control.ts"
import type { VisibleFileObservations } from "./visible-file-observations.ts"

export type ToolEffect = "observe" | "mutate" | "opaque"

export type ToolExecutionContext = Readonly<{
  workspaceRoot: string
  sessionId?: string
  toolCallId?: string
  sessionFiles?: SessionFiles
  signal?: AbortSignal
  visibleFileObservations?: VisibleFileObservations
  agentControl?: BoundAgentControl
}>

export type ToolPermissionRequest = Readonly<{
  kind: "tool"
  action: string
  subject?: string
  reason?: string
}>

export type ToolPermissionContext = Readonly<{ workspaceRoot: string }>

export type ToolSuccess = Readonly<{
  ok: true
  output: JsonValue
  content: string
}>

export type ToolFailure = Readonly<{
  ok: false
  code: string
  message: string
  content: string
  output?: JsonValue
}>

export type ToolExecutionResult = ToolSuccess | ToolFailure

export type RuntimeTool = Readonly<{
  name: string
  description: string
  inputSchema: JsonObject
  autoAllow: boolean
  effect: ToolEffect
  permission?: (
    input: unknown,
    context: ToolPermissionContext,
  ) => Promise<ToolPermissionRequest | undefined>
  describeExecution?: (input: JsonValue) => ToolExecutionDescriptor
  completeExecution?: (
    started: ToolExecutionDescriptor,
    output: JsonValue,
    succeeded: boolean,
  ) => ToolExecutionDescriptor
  execute(
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>
}>
