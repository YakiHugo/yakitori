import type { ModelAssistantMessage, ModelMessage } from "./model.ts"

// Messages APIs carry all output from one sampling attempt in one assistant
// message. Durable history stays append-only even when tools finish between
// streamed output items; grouping belongs to this wire projection.
export function groupModelResponses(
  messages: readonly ModelMessage[],
): ModelMessage[] {
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
  return messages.flatMap((message) => {
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
