import type { EventMetadata, ModelSelection } from "../../protocol/events.ts"
import type { InputContent } from "../../protocol/user-input.ts"

// An engine owns the complete agent loop and its context. Model providers are
// internal to an engine; changing a provider does not change this binding.
export type EngineBinding = Readonly<{
  engineId: string
  appSessionId: string
  engineSessionId: string
  cwd: string
}>

export type EngineCapabilities = Readonly<{
  resume: boolean
  load: boolean
  list: boolean
  fork: boolean
  steer: boolean
  queue: boolean
  subagents: boolean
}>

export type EngineInput = Readonly<{
  requestId: string
  text: string
  content?: InputContent
  modelSelection?: ModelSelection
  metadata?: EventMetadata
  parentInputId?: string
}>

export type EngineSendResult =
  | Readonly<{
      status: "accepted"
      turnId: string
      inputId?: string
      replayed?: boolean
    }>
  | Readonly<{ status: "rejected"; reason: string }>

export type EngineEvent =
  | Readonly<{
      type: "turn.status"
      turnId: string
      status:
        | "accepted"
        | "running"
        | "completed"
        | "failed"
        | "cancelled"
        | "disconnected"
      message?: string
      stopReason?: string
    }>
  | Readonly<{
      type: "message.delta"
      turnId: string
      text: string
      channel: "assistant" | "reasoning"
    }>
  | Readonly<{
      type: "permission.requested"
      turnId: string
      requestId: string
      description: string
      toolCall?: Record<string, unknown>
      options: readonly Readonly<{ id: string; label: string; kind?: string }>[]
    }>
  | Readonly<{
      type: "session.update"
      replayed?: boolean
      update: Record<string, unknown>
      turnId?: string
    }>

export type EnginePermissionResponse = Readonly<{
  requestId: string
  optionId: string
  turnId?: string
  reason?: Readonly<{ kind: string; message?: string }>
}>

export interface EngineAdapter {
  readonly id: string
  readonly capabilities: EngineCapabilities
  connect(): Promise<void>
  bind(
    input: Readonly<{
      appSessionId: string
      engineSessionId?: string
      cwd: string
    }>,
  ): Promise<EngineBinding>
  // Acceptance is not completion. Reconnect must never replay an unknown send.
  send(binding: EngineBinding, input: EngineInput): Promise<EngineSendResult>
  cancel(
    binding: EngineBinding,
    turnId: string,
    reason?: string,
  ): Promise<Readonly<{ status: "requested" | "not_running" }>>
  respondPermission(
    binding: EngineBinding,
    response: EnginePermissionResponse,
  ): Promise<boolean>
  subscribe(
    binding: EngineBinding,
    listener: (event: EngineEvent) => void,
  ): () => void
  close(): Promise<void>
}
