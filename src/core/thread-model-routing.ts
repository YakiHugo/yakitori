import type { ModelMessage } from "../kernel/events.ts"
import type { StoredRolloutItem } from "./rollout.ts"

export type ThreadModelRouting = Readonly<{
  hasImage?: boolean
  preferredAccount?: string
  contextWindowTokens?: number
}>

export function modelMessageHasImage(message: ModelMessage): boolean {
  return (
    (message.role === "user" || message.role === "tool") &&
    message.content.some(({ type }) => type === "image")
  )
}

export function advanceThreadModelRouting(
  previous: ThreadModelRouting,
  records: readonly StoredRolloutItem[],
): ThreadModelRouting {
  let routing = previous
  for (const { item } of records) {
    if (item.type === "turn_context") {
      const { configuration } = item.context
      routing = {
        ...(routing.hasImage ? { hasImage: true } : {}),
        preferredAccount: configuration.defaultTarget.provider,
        ...(configuration.modelContextWindowTokens === undefined
          ? {}
          : { contextWindowTokens: configuration.modelContextWindowTokens }),
      }
    } else if (item.type === "compacted") {
      routing = {
        ...routing,
        hasImage: item.replacement.some(({ item }) =>
          modelMessageHasImage(item),
        ),
      }
    } else if (
      (item.type === "response_item" || item.type === "agent_message") &&
      !routing.hasImage &&
      modelMessageHasImage(item.item.item)
    ) {
      routing = { ...routing, hasImage: true }
    }
  }
  return routing
}
