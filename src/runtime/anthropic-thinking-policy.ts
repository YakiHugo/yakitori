import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { isJsonObject } from "../kernel/index.ts"
import type { ModelRequest } from "./model.ts"

export const thinkingBindingBeta = "thinking-binding-controls-2026-08-01"
const bindingModels = new Set([
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
])

// Yakitori can change system/tools and compact history. The native API alone
// can validate opaque signatures against that prefix. Keep original history and
// ask it to discard only invalid blocks, reporting every actual loss to the UI.
// This is an observable compatibility fallback, not an append-only guarantee.
// https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
export function prepareAnthropicThinkingHistory(
  request: ModelRequest,
  body: { model: string; thinking?: unknown; messages: BetaMessageParam[] },
): boolean {
  if (!bindingModels.has(body.model)) return false
  const count = (messages: readonly BetaMessageParam[]) =>
    messages.reduce(
      (total, message) =>
        total +
        (Array.isArray(message.content)
          ? message.content.filter(
              (block) =>
                block.type === "thinking" || block.type === "redacted_thinking",
            ).length
          : 0),
      0,
    )
  const original = request.messages.reduce(
    (total, message) =>
      total +
      (message.role === "assistant"
        ? (message.native?.filter(
            (item) =>
              item.wireApi === "anthropic_messages" &&
              ["thinking", "redacted_thinking"].includes(
                String(item.value.type),
              ),
          ).length ??
          message.content.filter(
            (block) =>
              block.type === "reasoning" &&
              block.providerMetadata?.anthropic !== undefined,
          ).length)
        : 0),
    0,
  )
  const off =
    isJsonObject(body.thinking) &&
    (body.thinking.type === "disabled" ||
      body.thinking.type === "between_tools")
  if (off) {
    // These two modes cannot carry block_binding. Drop only the request copy;
    // native text/tool blocks and durable signed history are left untouched.
    body.messages = body.messages.flatMap((message) => {
      if (message.role !== "assistant" || !Array.isArray(message.content))
        return [message]
      const content = message.content.filter(
        (block) =>
          block.type !== "thinking" && block.type !== "redacted_thinking",
      )
      return content.length ? [{ ...message, content }] : []
    })
  }
  const omitted = original - count(body.messages)
  if (omitted > 0)
    request.onWarning?.({
      code: "anthropic.thinking_not_replayed",
      message: `${omitted} earlier reasoning block(s) were not reused because the model/account changed or thinking was turned off. Original history is preserved; rebuilding reasoning can use extra tokens and affect continuity.`,
    })
  if (off) return false
  if (!isJsonObject(body.thinking) || body.thinking.type !== "adaptive")
    return false
  // An explicit caller policy (for example error for an evaluation) wins.
  body.thinking = {
    ...body.thinking,
    block_binding: body.thinking.block_binding ?? {
      prefix_mismatch_behavior: "drop_block",
    },
  }
  return true
}

// Streaming reports these in message_start, and replaces them on the final
// message_delta after server fallback. Warn on distinct entries, not on tokens.
// https://platform.claude.com/docs/en/build-with-claude/streaming
export function reportAnthropicThinkingChanges(
  value: unknown,
  request: ModelRequest,
  seen: Set<string>,
): void {
  if (!Array.isArray(value)) return
  const changes = value.filter((entry) => {
    if (
      !isJsonObject(entry) ||
      !["thinking_dropped", "thinking_mismatch_allowed"].includes(
        String(entry.type),
      ) ||
      ![
        "prefix_binding_mismatch",
        "model_binding_mismatch",
        "organization_binding_mismatch",
      ].includes(String(entry.reason))
    )
      return false
    if (
      entry.type === "thinking_mismatch_allowed" &&
      entry.reason !== "prefix_binding_mismatch"
    )
      return false
    const key = JSON.stringify(entry)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (changes.length)
    request.onWarning?.({
      code: "anthropic.thinking_transformed",
      message: `Anthropic reported ${changes.length} earlier reasoning block(s) that could not be reused normally after a conversation, model, or account change. The response may rebuild reasoning, use extra tokens, and lose continuity. Original history is preserved.`,
    })
}
