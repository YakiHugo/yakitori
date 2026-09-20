import type { ContextSource } from "../kernel/input-context.ts"

export type {
  ContextExcerpt,
  ContextSource,
  ResponseAnnotation,
  SelectedTextAttachment,
} from "../kernel/input-context.ts"

export function contextSourceAttributes(source: ContextSource) {
  return {
    "data-context-kind": source.kind,
    "data-context-label": source.label,
    "data-context-session-id": source.sessionId,
    "data-context-message-id": source.messageId,
    "data-context-path": source.path,
    "data-context-url": source.url,
  }
}
