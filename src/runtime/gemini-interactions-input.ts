import { isJsonObject, type JsonObject } from "../kernel/index.ts"
import {
  type ModelMessage,
  type ModelUserContentBlock,
  requireModelDocumentData,
  requireModelImageData,
} from "./model.ts"
import { groupModelResponses } from "./model-history.ts"
import { portableModelContent, replayModelNativeItems } from "./model-native.ts"
import { ModelRequestControlsError } from "./model-request-controls.ts"

// Interactions accepts a chronological Step list in stateless mode. Thought
// signatures belong to that list, not to a server-side conversation handle.
// https://ai.google.dev/api/interactions-api-v1
export function toGeminiInteractionInput(
  messages: readonly ModelMessage[],
  provider: string,
  scope: string | undefined,
  model: string,
): JsonObject[] {
  const input: JsonObject[] = []
  const calls = new Map<string, string>()
  for (const message of groupModelResponses(messages)) {
    if (message.role === "user" || message.role === "developer") {
      input.push({
        type: "user_input",
        content: [
          ...(message.role === "developer"
            ? [{ type: "text", text: "[Developer instruction]" }]
            : []),
          ...message.content.map(interactionContent),
        ],
      })
      continue
    }
    if (message.role === "tool") {
      const name = calls.get(message.toolCallId)
      if (name === undefined)
        throw new ModelRequestControlsError(
          "Unmatched Interactions tool result.",
        )
      calls.delete(message.toolCallId)
      // FunctionResult's content array accepts text/images, unlike UserInput.
      // The tool plan must render PDF results before this wire boundary.
      if (message.content.some((block) => block.type === "document"))
        throw new ModelRequestControlsError(
          "Interactions function results require PDF content to be rendered first.",
        )
      input.push({
        type: "function_result",
        call_id: message.toolCallId,
        name,
        result: message.content.map(interactionContent),
        ...(message.isError === undefined ? {} : { is_error: message.isError }),
      })
      continue
    }
    const native = replayModelNativeItems(
      message,
      "gemini_interactions",
      provider,
      scope,
      model,
    )
    const steps =
      native ??
      portableModelContent(message).flatMap((block): JsonObject[] => {
        if (block.type === "compaction")
          throw new ModelRequestControlsError(
            "Opaque compaction cannot be sent to Interactions.",
          )
        if (block.type === "reasoning") return []
        if (block.type === "text")
          return [
            {
              type: "model_output",
              content: [{ type: "text", text: block.text }],
            },
          ]
        const args =
          block.toolKind === "custom" &&
          block.customInputFallbackKey !== undefined
            ? { [block.customInputFallbackKey]: block.input }
            : block.input
        if (!isJsonObject(args))
          throw new ModelRequestControlsError(
            "Interactions function arguments must be an object.",
          )
        return [
          {
            type: "function_call",
            id: block.id,
            name: block.name,
            arguments: args,
          },
        ]
      })
    for (const step of steps) {
      if (step.type === "function_call") {
        if (
          typeof step.id !== "string" ||
          !step.id ||
          typeof step.name !== "string" ||
          !step.name ||
          !isJsonObject(step.arguments) ||
          calls.has(step.id)
        )
          throw new ModelRequestControlsError(
            "Invalid Interactions function call history.",
          )
        calls.set(step.id, step.name)
      }
      input.push(step)
    }
  }
  return input
}

function interactionContent(block: ModelUserContentBlock): JsonObject {
  if (block.type === "text") return { type: "text", text: block.text }
  return {
    type: block.type,
    mime_type: block.mediaType,
    data:
      block.type === "image"
        ? requireModelImageData(block)
        : requireModelDocumentData(block),
  }
}
