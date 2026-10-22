import type { EventMetadata, ModelSelection } from "./events.ts"
import type { InputContent } from "./user-input.ts"

// Assigned by the host routing an independent thread, never by user text.
export type ThreadMessageProvenance = Readonly<{
  sourceThreadId: string
  sourceRequestId: string
}>

export function isThreadMessageProvenance(
  value: unknown,
): value is ThreadMessageProvenance {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false
  const source = value as Record<string, unknown>
  return (
    Object.keys(source).every((key) =>
      ["sourceThreadId", "sourceRequestId"].includes(key),
    ) &&
    typeof source.sourceThreadId === "string" &&
    source.sourceThreadId.trim().length > 0 &&
    typeof source.sourceRequestId === "string" &&
    source.sourceRequestId.trim().length > 0
  )
}

export type InputPurpose =
  | "message"
  | "task"
  | "question_answer"
  | "continuation"
export type InputSource = "human" | "agent" | "runtime"

export type TurnInput = Readonly<{
  purpose?: InputPurpose
  source?: InputSource
  submissionId: string
  content: InputContent
  manualCompact?: boolean
  modelSelection?: ModelSelection
  metadata?: EventMetadata
  parentInputId?: string
  provenance?: ThreadMessageProvenance
  // Host-generated continuation, not a user message or user authorization.
  goalId?: string
}>

export type QueuedInput = Readonly<{
  id: string
  sessionId: string
  input: TurnInput
  createdAt: string
}>
