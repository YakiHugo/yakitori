import type { EventMetadata, ModelSelection } from "./events.ts"
import type { InputContent } from "./user-input.ts"

export type TurnInput = Readonly<{
  submissionId: string
  content: InputContent
  manualCompact?: boolean
  modelSelection?: ModelSelection
  metadata?: EventMetadata
  parentInputId?: string
  // Host-generated continuation, not a user message or user authorization.
  goalId?: string
}>

export type QueuedInput = Readonly<{
  id: string
  sessionId: string
  input: TurnInput
  createdAt: string
}>
