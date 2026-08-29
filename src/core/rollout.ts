import type {
  EventMetadata,
  JsonObject,
  ModelMessage,
  ModelSelection,
  SessionConfigurationSnapshot,
  TokenUsage,
} from "../kernel/events.ts"

export type HistoryPosition = {
  readonly rolloutId: string
  readonly endSeqExclusive: number
  readonly endByteOffset: number
}

export type ThreadMetadata = {
  readonly id: string
  readonly rolloutId?: string
  readonly conversationId: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly title?: string
  readonly workingDirectory?: string
  readonly mateId?: string
  readonly mateRevisionId?: string
  readonly parentThreadId?: string
  readonly forkedFromTurnId?: string
  readonly historyBase?: HistoryPosition
  readonly metadata?: EventMetadata
}

export type ResponseItemEnvelope = {
  readonly id: string
  readonly turnId: string
  readonly createdAt: string
  readonly item: ModelMessage
  readonly providerMetadata?: JsonObject
}

export type TurnContextItem = {
  readonly turnId: string
  readonly configuration: SessionConfigurationSnapshot
  readonly selection: ModelSelection
}

export type RolloutItem =
  | { readonly type: "session_meta"; readonly metadata: ThreadMetadata }
  | { readonly type: "response_item"; readonly item: ResponseItemEnvelope }
  | { readonly type: "turn_context"; readonly context: TurnContextItem }
  | {
      readonly type: "turn_started"
      readonly turnId: string
      readonly inputItemId: string
    }
  | {
      readonly type: "turn_completed"
      readonly turnId: string
      readonly outcome: "completed" | "failed" | "interrupted"
      readonly usage?: TokenUsage
      readonly error?: { readonly message: string; readonly code?: string }
    }
  | {
      readonly type: "world_state"
      readonly turnId: string
      readonly state: JsonObject
    }
  | {
      readonly type: "compacted"
      readonly turnId: string
      readonly replacement: readonly ResponseItemEnvelope[]
      readonly summary: string
    }

export type StoredRolloutItem = {
  readonly threadId: string
  readonly rolloutId: string
  readonly seq: number
  readonly createdAt: string
  readonly item: RolloutItem
}

export type StoredThread = {
  readonly metadata: ThreadMetadata
  readonly rollout: readonly StoredRolloutItem[]
}

export type ThreadSummary = ThreadMetadata & {
  readonly seq: number
}
