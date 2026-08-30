import type {
  JsonObject,
  JsonValue,
  ToolExecutionDescriptor,
} from "../../kernel/index.ts"
import type { RolloutAssets } from "../../kernel/rollout-assets.ts"
import type { BoundAgentControl } from "../agent-control.ts"
import type { VisibleFileObservations } from "./visible-file-observations.ts"

export type ToolEffect = "observe" | "mutate" | "opaque"

export type ToolApprovalAction = "command_execution" | "file_change"

export type ToolApprovalRequirement =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "approval"
      action: ToolApprovalAction
      subject?: string
      reason?: string
    }>

export type ToolExecutionContext = Readonly<{
  workspaceRoot: string
  rolloutId?: string
  toolCallId?: string
  rolloutAssets?: RolloutAssets
  signal?: AbortSignal
  visibleFileObservations?: VisibleFileObservations
  agentControl?: BoundAgentControl
}>

export type ToolPermissionRequest = Readonly<{
  kind: "tool"
  action: ToolApprovalAction
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
  effect: ToolEffect
  approvalRequirement:
    | ToolApprovalRequirement
    | ((
        input: unknown,
        context: ToolPermissionContext,
      ) => ToolApprovalRequirement | Promise<ToolApprovalRequirement>)
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
