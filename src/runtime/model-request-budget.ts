import { createHash } from "node:crypto"
import {
  DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
  type ModelImageBlock,
  type ModelRequest,
  type ModelUsage,
} from "./model.ts"

const HIGH_DETAIL_IMAGE_TOKENS = 1_844
const ORIGINAL_IMAGE_PATCH_SIZE = 32
const ORIGINAL_IMAGE_MAX_PATCHES = 10_000
// Codex and Grok both use a 4-bytes/token local fallback. Keep that reference
// baseline, but reserve 20% for tokenizer/language variance until the first
// provider usage replaces it with a model-specific measurement.
const FALLBACK_BYTES_PER_TOKEN = 3.2

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

export type ModelUsageBaseline = Readonly<{
  provider: string
  model: string
  contextWindowId: string
  systemRevisions: readonly string[]
  toolContract: string
  messagePrefixDigests: readonly string[]
  providerInputTokens: number
  estimatedInputTokens: number
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
    FALLBACK_BYTES_PER_TOKEN,
  )
  const systemTokens = estimateTextTokens(
    JSON.stringify(request.system),
    FALLBACK_BYTES_PER_TOKEN,
  )
  const messageTokens = estimateTextTokens(
    JSON.stringify(request.messages, omitImagePayload),
    FALLBACK_BYTES_PER_TOKEN,
  )
  const toolTokens = estimateTextTokens(
    JSON.stringify(request.tools),
    FALLBACK_BYTES_PER_TOKEN,
  )
  const imageTokens = request.messages.reduce(
    (total, message) =>
      message.role !== "user"
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

export function effectiveRequestInputTokens(input: {
  readonly request: ModelRequest
  readonly contextWindowId: string
  readonly budget: ModelRequestBudget
  readonly baseline?: ModelUsageBaseline
}): number {
  const baseline = input.baseline
  if (
    baseline === undefined ||
    !canReuseUsageBaseline(baseline, input.request, input.contextWindowId) ||
    input.budget.estimatedInputTokens < baseline.estimatedInputTokens
  ) {
    return input.budget.estimatedInputTokens
  }
  const estimatedDelta =
    input.budget.estimatedInputTokens - baseline.estimatedInputTokens
  return Math.max(
    input.budget.estimatedInputTokens,
    baseline.providerInputTokens + estimatedDelta,
  )
}

export function createModelUsageBaseline(input: {
  readonly request: ModelRequest
  readonly contextWindowId: string
  readonly budget: ModelRequestBudget
  readonly usage: ModelUsage
}): ModelUsageBaseline | undefined {
  const providerInputTokens = input.usage.inputTokens
  if (providerInputTokens === undefined) return undefined
  return {
    provider: input.request.target.provider,
    model: input.request.target.model,
    contextWindowId: input.contextWindowId,
    systemRevisions: systemRevisions(input.request),
    toolContract: JSON.stringify(input.request.tools),
    messagePrefixDigests: input.request.messages.map(messageDigest),
    providerInputTokens,
    estimatedInputTokens: input.budget.estimatedInputTokens,
  }
}

function canReuseUsageBaseline(
  baseline: ModelUsageBaseline,
  request: ModelRequest,
  contextWindowId: string,
): boolean {
  return (
    baseline.provider === request.target.provider &&
    baseline.model === request.target.model &&
    baseline.contextWindowId === contextWindowId &&
    arraysEqual(baseline.systemRevisions, systemRevisions(request)) &&
    baseline.toolContract === JSON.stringify(request.tools) &&
    baseline.messagePrefixDigests.length <= request.messages.length &&
    baseline.messagePrefixDigests.every(
      (digest, index) => digest === messageDigest(request.messages[index]),
    )
  )
}

function messageDigest(message: ModelRequest["messages"][number] | undefined) {
  return createHash("sha256").update(JSON.stringify(message)).digest("hex")
}

function systemRevisions(request: ModelRequest): readonly string[] {
  return request.system.map((section) => `${section.id}:${section.revision}`)
}

function estimateTextTokens(text: string, bytesPerToken: number): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / bytesPerToken)
}

function omitImagePayload(_key: string, value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "image" &&
    "data" in value &&
    typeof value.data === "string"
  ) {
    return { ...value, data: "" }
  }
  return value
}

function estimateImageTokens(image: ModelImageBlock): number {
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

function readImageDimensions(
  bytes: Buffer,
  mediaType: ModelImageBlock["mediaType"],
): { readonly width: number; readonly height: number } | undefined {
  if (
    mediaType === "image/png" &&
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
  }
  if (
    mediaType === "image/gif" &&
    bytes.length >= 10 &&
    (bytes.toString("ascii", 0, 6) === "GIF87a" ||
      bytes.toString("ascii", 0, 6) === "GIF89a")
  ) {
    return dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8))
  }
  if (mediaType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return readJpegDimensions(bytes)
  }
  if (mediaType === "image/webp") return readWebpDimensions(bytes)
  return undefined
}

function readJpegDimensions(
  bytes: Buffer,
): { readonly width: number; readonly height: number } | undefined {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    if (marker === undefined) return undefined
    if (marker >= 0xc0 && marker <= 0xc3) {
      return dimensions(
        bytes.readUInt16BE(offset + 7),
        bytes.readUInt16BE(offset + 5),
      )
    }
    const segmentLength = bytes.readUInt16BE(offset + 2)
    if (segmentLength < 2) return undefined
    offset += segmentLength + 2
  }
  return undefined
}

function readWebpDimensions(
  bytes: Buffer,
): { readonly width: number; readonly height: number } | undefined {
  if (
    bytes.length < 30 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return undefined
  }
  const kind = bytes.toString("ascii", 12, 16)
  if (kind === "VP8X") {
    const width = 1 + bytes.readUIntLE(24, 3)
    const height = 1 + bytes.readUIntLE(27, 3)
    return dimensions(width, height)
  }
  if (kind === "VP8 " && bytes.length >= 30) {
    return dimensions(
      bytes.readUInt16LE(26) & 0x3fff,
      bytes.readUInt16LE(28) & 0x3fff,
    )
  }
  if (kind === "VP8L" && bytes.length >= 25) {
    const packed = bytes.readUInt32LE(21)
    const width = (packed & 0x3fff) + 1
    const height = ((packed >> 14) & 0x3fff) + 1
    return dimensions(width, height)
  }
  return undefined
}

function dimensions(
  width: number,
  height: number,
): { readonly width: number; readonly height: number } | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}
