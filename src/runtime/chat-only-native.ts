import type { ModelContentBlock, ModelNativeItem } from "./model.ts"
import { cleanModelText } from "./model-control-tokens.ts"

// Admit only a redundant, plain Chat assistant message. In particular, never
// infer portability from a readable text field next to opaque provider state.
// The original envelope stays in durable history; nothing is rewritten.
export function isPortableChatOnlyNative(
  content: readonly ModelContentBlock[],
  native: readonly ModelNativeItem[] | undefined,
): boolean {
  if (native === undefined || native.length === 0) return true
  if (native.length !== 1 || content.some((block) => block.type !== "text"))
    return false
  const item = native[0]
  if (item?.wireApi !== "openai_chat_completions") return false
  const value = item.value
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "role") ||
    !Object.hasOwn(value, "content") ||
    value.role !== "assistant"
  )
    return false
  const text = content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
  return typeof value.content === "string"
    ? value.content === text || cleanModelText(value.content) === text
    : value.content === null && text.length === 0
}
