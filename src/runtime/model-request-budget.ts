import { readImageDimensions } from "../kernel/image-metadata.ts"
import { nativeDeferredToolProtocol } from "./deferred-tool-loading.ts"
import {
  DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
  type ModelImageBlock,
  type ModelMessage,
  type ModelRequest,
} from "./model.ts"

const HIGH_DETAIL_IMAGE_TOKENS = 2_000
const ORIGINAL_IMAGE_PATCH_SIZE = 32
const ORIGINAL_IMAGE_MAX_PATCHES = 10_000
const APPROX_BYTES_PER_TOKEN = 4

export type ModelRequestBudget = Readonly<{
  envelopeTokens: number
  systemTokens: number
  messageTokens: number
  toolTokens: number
  imageTokens: number
  estimatedInputTokens: number
  outputReserveTokens: number
  requiredContextTokens: number
}>

export function estimateModelRequestBudget(
  request: ModelRequest,
): ModelRequestBudget {
  const envelopeTokens = estimateTextTokens(
    JSON.stringify({
      target: request.target,
      cacheKey: request.cacheKey,
      maxOutputTokens: request.maxOutputTokens,
    }),
  )
  const systemTokens = estimateTextTokens(JSON.stringify(request.system))
  const messageTokens = request.messages.reduce(
    (total, message) => total + estimateMessageTextTokens(message),
    0,
  )
  const budgetedTools =
    nativeDeferredToolProtocol(request) === undefined
      ? request.tools
      : request.tools.filter((tool) => tool.deferLoading !== true)
  const toolTokens = estimateTextTokens(JSON.stringify(budgetedTools))
  const imageTokens = request.messages.reduce(
    (total, message) =>
      message.role !== "user" && message.role !== "tool"
        ? total
        : total +
          (message.images ?? []).reduce(
            (subtotal, image) => subtotal + estimateImageTokens(image),
            0,
          ),
    0,
  )
  const estimatedInputTokens =
    envelopeTokens + systemTokens + messageTokens + toolTokens + imageTokens
  const outputReserveTokens =
    request.maxOutputTokens ?? DEFAULT_MODEL_MAX_OUTPUT_TOKENS
  return {
    envelopeTokens,
    systemTokens,
    messageTokens,
    toolTokens,
    imageTokens,
    estimatedInputTokens,
    outputReserveTokens,
    requiredContextTokens: estimatedInputTokens + outputReserveTokens,
  }
}

function estimateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / APPROX_BYTES_PER_TOKEN)
}

// Only history added since the provider's last measured response needs a
// local estimate. Image payload bytes are transport data, not text tokens.
export function estimateHistoryTokens(
  messages: readonly ModelMessage[],
): number {
  return messages.reduce(
    (total, message) =>
      total +
      estimateMessageTextTokens(message) +
      (message.role === "user" || message.role === "tool"
        ? (message.images ?? []).reduce(
            (tokens, image) => tokens + estimateImageTokens(image),
            0,
          )
        : 0),
    0,
  )
}

function estimateMessageTextTokens(message: ModelMessage): number {
  if (message.role !== "assistant")
    return (
      estimateTextTokens(JSON.stringify(message, omitImagePayload)) +
      (message.role === "tool"
        ? (message.documents ?? []).reduce(
            (total, document) =>
              total + Math.ceil(document.sizeBytes / APPROX_BYTES_PER_TOKEN),
            0,
          )
        : 0)
    )
  const native = message.content.filter((block) => block.type === "compaction")
  if (native.length === 0) return estimateTextTokens(JSON.stringify(message))
  // Codex estimates the decoded payload minus encryption overhead, rather
  // than charging base64 and IR provenance as model-visible text.
  const nativeTokens = native.reduce(
    (total, block) =>
      total +
      Math.ceil(
        Math.max(0, Math.floor((block.encryptedContent.length * 3) / 4) - 650) /
          4,
      ),
    0,
  )
  const content = message.content.filter((block) => block.type !== "compaction")
  return (
    nativeTokens +
    (content.length === 0
      ? 0
      : estimateTextTokens(JSON.stringify({ ...message, content })))
  )
}

function omitImagePayload(_key: string, value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "image" || value.type === "document") &&
    "data" in value &&
    typeof value.data === "string"
  ) {
    return { ...value, data: "" }
  }
  return value
}

export function estimateImageTokens(image: ModelImageBlock): number {
  if ((image.detail ?? "high") !== "original") {
    return HIGH_DETAIL_IMAGE_TOKENS
  }
  const bytes = "data" in image ? Buffer.from(image.data, "base64") : undefined
  const dimensions =
    bytes === undefined
      ? undefined
      : readImageDimensions(bytes, image.mediaType)
  if (dimensions === undefined) return HIGH_DETAIL_IMAGE_TOKENS
  const patchesWide = Math.ceil(dimensions.width / ORIGINAL_IMAGE_PATCH_SIZE)
  const patchesHigh = Math.ceil(dimensions.height / ORIGINAL_IMAGE_PATCH_SIZE)
  return Math.min(patchesWide * patchesHigh, ORIGINAL_IMAGE_MAX_PATCHES)
}
