// Application engine DTOs contain observed history only. Transport session IDs
// belong to the adapter/store and are never exposed to the renderer.
export type EngineCapabilities = Readonly<{
  resume: boolean
  load: boolean
  list: boolean
  fork: boolean
  steer: boolean
  queue: boolean
  subagents: boolean
}>

export type EngineDescriptor = Readonly<{
  id: string
  label: string
  kind: "native" | "acp"
  available: boolean
  capabilities: EngineCapabilities
}>

export type EngineSessionSummary = Readonly<{
  id: string
  engineId: string
  cwd: string
  title?: string
  projectId?: string
  createdAt: number
  updatedAt: number
}>

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
  | Readonly<{
      type: "input.submitted"
      requestId: string
      turnId: string
      text: string
    }>
  | Readonly<{
      type: "permission.resolved"
      requestId: string
      turnId?: string
      optionId: string
    }>

export type EngineSendResult =
  | Readonly<{
      status: "accepted"
      turnId: string
      inputId?: string
      replayed?: boolean
    }>
  | Readonly<{ status: "rejected"; reason: string }>

export type EngineSessionSnapshot = Readonly<{
  session: EngineSessionSummary
  events: readonly Readonly<{
    seq: number
    event: EngineEvent
    createdAt: number
  }>[]
  history: "observed"
  requests: readonly Readonly<{
    requestId: string
    input: Readonly<{ requestId: string; text: string }>
    status: "pending" | "accepted" | "rejected" | "terminal" | "unknown"
    turnId?: string
    reason?: string
  }>[]
}>

export type EngineRpcParams = {
  "engine/list": Record<string, never>
  "engineSession/create": {
    engineId: string
    cwd?: string
    title?: string
    projectId?: string
  }
  "engineSession/list": Record<string, never>
  "engineSession/read": { sessionId: string }
  "engineSession/send": { sessionId: string; requestId: string; text: string }
  "engineSession/cancel": { sessionId: string; turnId: string }
  "engineSession/respondPermission": {
    sessionId: string
    requestId: string
    optionId: string
    turnId?: string
  }
}

export type EngineRpcResponses = {
  "engine/list": { engines: readonly EngineDescriptor[] }
  "engineSession/create": EngineSessionSnapshot
  "engineSession/list": { sessions: readonly EngineSessionSummary[] }
  "engineSession/read": EngineSessionSnapshot
  "engineSession/send": EngineSendResult
  "engineSession/cancel": { status: "requested" | "not_running" }
  "engineSession/respondPermission": boolean
}
