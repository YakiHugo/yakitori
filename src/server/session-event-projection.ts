import type { StoredRolloutItem } from "../core/rollout.ts"
import { inputContentFromModelMessage } from "../core/user-input.ts"
import type { ModelUserMessage } from "../kernel/events.ts"
import {
  createEventEnvelope,
  EVENT_SCHEMA_VERSION,
  type InputContent,
  InputRole,
} from "../kernel/index.ts"
import type { ModelAssistantTextBlock } from "../protocol/conversation.ts"
import type { AppSessionEventEnvelope } from "../protocol/events.ts"
import { isJsonObject } from "../protocol/json.ts"
import {
  anthropicCitations,
  openAICitations,
} from "../runtime/model-citations.ts"
import { invalidInput } from "./thread-handler-errors.ts"

export function mapRolloutEvent(
  record: StoredRolloutItem,
  threadId: string,
): AppSessionEventEnvelope {
  const item = record.item
  const base = {
    sessionId: threadId,
    seq: record.seq + 1,
    id: `event_${threadId}_${record.rolloutId}_${record.seq}`,
    createdAt: record.createdAt,
  }
  if (item.type === "session_meta") {
    const metadata = item.metadata
    return createEventEnvelope({
      ...base,
      event: {
        type: "session.created",
        data: {
          conversationId: metadata.conversationId,
          ...(metadata.title === undefined ? {} : { title: metadata.title }),
          ...(metadata.workingDirectory === undefined
            ? {}
            : { workingDirectory: metadata.workingDirectory }),
          ...(metadata.projectId === undefined
            ? {}
            : { projectId: metadata.projectId }),
          ...(metadata.mateId === undefined ? {} : { mateId: metadata.mateId }),
          ...(metadata.mateRevisionId === undefined
            ? {}
            : { mateRevisionId: metadata.mateRevisionId }),
          ...(metadata.parentThreadId === undefined
            ? {}
            : { parentSessionId: metadata.parentThreadId }),
          ...(metadata.metadata === undefined
            ? {}
            : { metadata: metadata.metadata }),
        },
      },
    })
  }
  if (
    item.type === "response_item" &&
    (item.item.id.startsWith("input_") || item.item.id.startsWith("message_"))
  ) {
    const message = item.item.item
    const submission = item.item.submissionMetadata
    const threadMessage =
      message.role === "developer" &&
      message.context?.type === "thread_message" &&
      submission?.content !== undefined &&
      submission.provenance !== undefined
    // Thread-message model text contains a security wrapper. Only host metadata
    // supplies its authored display content; arbitrary developer text stays hidden.
    const content =
      message.role === "user" && message.context === undefined
        ? (submission?.content ?? modelUserInputContent(message))
        : threadMessage
          ? submission.content
          : undefined
    if (content !== undefined) {
      // message_-prefixed items are steered inputs, recorded when the active
      // Turn sampled them; input_-prefixed items start Turns.
      const steered = item.item.id.startsWith("message_")
      const source = threadMessage ? "agent" : submission?.source
      return createEventEnvelope({
        ...base,
        event: {
          type: "input.admitted",
          data: {
            requestId: item.item.turnId,
            inputId: item.item.id,
            role: threadMessage ? InputRole.Runtime : InputRole.User,
            ...(steered ? { steered: true } : {}),
            content,
            ...(source === undefined ? {} : { source }),
            ...(submission?.provenance === undefined
              ? {}
              : { provenance: submission.provenance }),
            ...(submission?.modelSelection === undefined
              ? {}
              : { modelSelection: submission.modelSelection }),
            ...(submission?.parentInputId === undefined
              ? {}
              : { parentInputId: submission.parentInputId }),
            ...(submission?.metadata === undefined
              ? {}
              : { metadata: submission.metadata }),
          },
        },
      })
    }
  }
  if (item.type === "turn_started") {
    return createEventEnvelope({
      ...base,
      event: {
        type: "turn.started",
        data: {
          turnId: item.turnId,
          ...(item.inputItemId === undefined
            ? {}
            : { inputId: item.inputItemId }),
        },
      },
    })
  }
  if (item.type === "turn_completed") {
    const outcome =
      item.outcome === "completed"
        ? ({ status: "completed", ...item.completion } as const)
        : item.outcome === "interrupted"
          ? ({ status: "interrupted" } as const)
          : ({
              status: "failed",
              error: item.error ?? { message: "Turn execution failed." },
            } as const)
    return createEventEnvelope({
      ...base,
      event: {
        type: "turn.completed",
        data: {
          turnId: item.turnId,
          outcome,
          ...(item.usage === undefined ? {} : { usage: item.usage }),
          ...(item.metrics === undefined ? {} : { metrics: item.metrics }),
        },
      },
    })
  }
  if (item.type === "item_started") {
    return createEventEnvelope({
      ...base,
      event: {
        type: "item.started",
        data: { turnId: item.turnId, item: item.item },
      },
    })
  }
  if (item.type === "token_count") {
    return createEventEnvelope({
      ...base,
      event: {
        type: "context.tokens",
        data: {
          turnId: item.turnId,
          activeContextTokens: item.activeContextTokens,
          ...(item.capacityTokens === undefined
            ? {}
            : { capacityTokens: item.capacityTokens }),
          ...(item.provider === undefined ? {} : { provider: item.provider }),
          ...(item.model === undefined ? {} : { model: item.model }),
        },
      },
    })
  }
  if (item.type === "item_completed") {
    const completed = item.item
    return createEventEnvelope({
      ...base,
      event: {
        type: "item.completed",
        data: {
          turnId: item.turnId,
          item:
            completed.type === "agent_message"
              ? {
                  ...completed,
                  content: completed.content.map(readAssistantCitations),
                }
              : completed,
        },
      },
    })
  }
  return {
    ...base,
    version: EVENT_SCHEMA_VERSION,
    type: "session.cursor",
    data: {},
  }
}

function readAssistantCitations(
  block: ModelAssistantTextBlock,
): ModelAssistantTextBlock {
  const metadata = block.providerMetadata
  if (block.annotations !== undefined || metadata === undefined) return block
  // Existing turns stored citations only in their provider-owned payloads.
  // Restore the display annotations at the rollout projection without rewriting history.
  const part = isJsonObject(metadata.openai) ? metadata.openai.part : undefined
  const annotations = openAICitations(
    isJsonObject(part) ? part.annotations : undefined,
    block.text,
  )
  if (isJsonObject(metadata.anthropic))
    annotations.push(...anthropicCitations(metadata.anthropic.citations))
  if (isJsonObject(metadata.chatCompletions))
    annotations.push(
      ...openAICitations(metadata.chatCompletions.annotations, block.text),
    )
  return annotations.length === 0 ? block : { ...block, annotations }
}

export function modelUserInputContent(message: ModelUserMessage): InputContent {
  const content = inputContentFromModelMessage(message)
  if (content === undefined)
    throw invalidInput("Input attachments require portable asset sources.")
  return content
}
