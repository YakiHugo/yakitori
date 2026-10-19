import type { ContextSource } from "../protocol/input-context.ts"

export type {
  ContextExcerpt,
  ContextSource,
} from "../protocol/input-context.ts"

export function contextSourceAttributes(source: ContextSource | undefined) {
  if (!source) return {}
  return {
    "data-context-kind": source.kind,
    "data-context-label": source.label,
    "data-context-session-id":
      source.kind !== "browser" ? source.sessionId : undefined,
    "data-context-message-id":
      source.kind === "message" ? source.messageId : undefined,
    "data-context-path": source.kind === "file" ? source.path : undefined,
    "data-context-url": source.kind === "browser" ? source.url : undefined,
  }
}
