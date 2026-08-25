import { createHash } from "node:crypto"
import { readImageDimensions } from "../kernel/image-metadata.ts"
import {
  DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
  type ModelImageBlock,
  type ModelRequest,
  type ModelUsage,
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
  )
  const systemTokens = estimateTextTokens(JSON.stringify(request.system))
  const messageTokens = estimateTextTokens(
    JSON.stringify(request.messages, omitImagePayload),
  )
  const toolTokens = estimateTextTokens(JSON.stringify(request.tools))
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

function estimateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / APPROX_BYTES_PER_TOKEN)
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

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}
