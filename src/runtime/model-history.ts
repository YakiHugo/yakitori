import type { ResponseItemEnvelope } from "../core/rollout.ts"
import { type JsonObject, MISSING_TOOL_RESULT_TEXT } from "../kernel/index.ts"
import type {
  ModelAssistantMessage,
  ModelMessage,
  ModelToolCallBlock,
} from "./model.ts"
import {
  ModelHistoryScopeError,
  projectCompactionSummary,
} from "./model-native.ts"

// Messages APIs carry all output from one sampling attempt in one assistant
// message. Durable history stays append-only even when tools finish between
// streamed output items; grouping belongs to this wire projection.
export function groupModelResponses(
  messages: readonly ModelMessage[],
): Exclude<ModelMessage, { role: "compaction" }>[] {
  const groups = new Map<string, ModelAssistantMessage>()
  for (const message of messages) {
    if (message.role !== "assistant" || message.response === undefined) continue
    const id = message.response.attemptId
    const previous = groups.get(id)
    if (
      previous !== undefined &&
      JSON.stringify(previous.response) !== JSON.stringify(message.response)
    ) {
      throw new Error("Model output changed its sampling attempt identity.")
    }
    groups.set(
      id,
      previous === undefined
        ? message
        : {
            ...previous,
            content: [...previous.content, ...message.content],
            ...(previous.native === undefined && message.native === undefined
              ? {}
              : {
                  native: [
                    ...(previous.native ?? []),
                    ...(message.native ?? []),
                  ],
                }),
          },
    )
  }
  const emitted = new Set<string>()
  return messages.flatMap((entry) => {
    const message = projectCompactionSummary(entry)
    if (message.role === "compaction")
      throw new ModelHistoryScopeError(
        "This wire adapter cannot replay opaque compaction.",
      )
    if (message.role !== "assistant" || message.response === undefined)
      return [message]
    const id = message.response.attemptId
    if (emitted.has(id)) return []
    emitted.add(id)
    const group = groups.get(id)
    if (group === undefined) throw new Error("Missing model response group.")
    return [group]
  })
}

export function envelope(
  turnId: string,
  item: ModelMessage,
  providerMetadata?: JsonObject,
  id = `message_${globalThis.crypto.randomUUID()}`,
): ResponseItemEnvelope {
  return {
    id,
    turnId,
    createdAt: new Date().toISOString(),
    item,
    ...(providerMetadata === undefined ? {} : { providerMetadata }),
  }
}

export function completeToolCallHistory(
  messages: readonly ModelMessage[],
): readonly ModelMessage[] {
  const completed: ModelMessage[] = []
  let pending: Array<
    Readonly<{ id: string; toolKind: ModelToolCallBlock["toolKind"] }>
  > = []
  const flushMissing = () => {
    completed.push(
      ...pending.map(({ id: toolCallId, toolKind }) => ({
        role: "tool" as const,
        toolCallId,
        content: [{ type: "text" as const, text: MISSING_TOOL_RESULT_TEXT }],
        isError: true,
        ...(toolKind === "tool_search" ? { toolSearch: { tools: [] } } : {}),
      })),
    )
    pending = []
  }
  for (const message of messages) {
    if (
      message.role === "tool" &&
      pending.some(({ id }) => id === message.toolCallId)
    ) {
      completed.push(message)
      pending = pending.filter(({ id }) => id !== message.toolCallId)
      continue
    }
    if (message.role === "tool") continue
    if (message.role !== "assistant" && pending.length > 0) flushMissing()
    completed.push(message)
    if (message.role === "assistant") {
      pending.push(
        ...message.content.flatMap((block) =>
          block.type === "tool_call"
            ? [{ id: block.id, toolKind: block.toolKind }]
            : [],
        ),
      )
    }
  }
  if (pending.length > 0) flushMissing()
  return completed
}
