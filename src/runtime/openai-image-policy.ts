import {
  openAIVisionPolicy,
  hasOpenAIImagePreparation,
} from "./openai-vision-models.ts"
import {
  inspectImageBytes,
  InvalidImageDataError,
} from "../kernel/image-metadata.ts"
import { AssetMediaError } from "./asset-media.ts"
import { jsonRequestByteLength } from "./json-request-budget.ts"
import type { ModelImageBlock } from "./model.ts"
import { validateModelImage } from "./prepare-model-image.ts"

// Verified native Responses models only; not the ChatGPT/Codex proxy or compatible APIs.
// https://developers.openai.com/api/docs/guides/images-vision (2026-11-02)
// API ceiling: 512 MB / 1500 images. This lower local serialization guard fits
// one existing 50 MB attachment after base64 plus framing, without accumulating
// hundreds of MB of encoded history in the process. It is NOT an API quota.
export const OPENAI_IMAGE_REQUEST_SAFETY_BYTES = 80 * 1024 * 1024

export class OpenAIImageRequestSizeError extends AssetMediaError {
  constructor() {
    super(
      "Request was not sent: exceeds Yakitori's 80 MiB local OpenAI image request budget. Send fewer images or reduce other request content; originals have not been changed.",
    )
  }
}

export function validateOpenAIImageRequest(
  body: unknown,
  originalSupported = true,
): void {
  if (
    jsonRequestByteLength(body, OPENAI_IMAGE_REQUEST_SAFETY_BYTES) === undefined
  )
    throw new OpenAIImageRequestSizeError()
  const input =
    typeof body === "object" && body !== null && "input" in body
      ? body.input
      : undefined
  let images = 0
  // Count only protocol content, not image-shaped JSON in tool-search schemas,
  // tool arguments or other opaque native fields replayed inside input.
  for (const item of Array.isArray(input) ? input : []) {
    if (typeof item !== "object" || item === null) continue
    const content =
      item.type === "function_call_output" ||
      item.type === "custom_tool_call_output"
        ? item.output
        : item.role === "user" &&
            (item.type === undefined || item.type === "message")
          ? item.content
          : undefined
    for (const block of Array.isArray(content) ? content : []) {
      if (
        !originalSupported &&
        typeof block === "object" &&
        block !== null &&
        block.type === "input_image" &&
        block.detail === "original"
      )
        throw new AssetMediaError(
          "Original image detail is not verified for this native OpenAI model. Choose high detail; the original image has not been changed.",
        )
      if (
        typeof block === "object" &&
        block !== null &&
        block.type === "input_image" &&
        ++images > 1500
      )
        throw new AssetMediaError(
          "OpenAI allows at most 1500 images in one request, including history and tool results. Send fewer images; originals have not been changed.",
        )
    }
  }
}

export async function prepareOpenAIImage(
  bytes: Buffer,
  image: ModelImageBlock,
  model: string,
  signal?: AbortSignal,
): Promise<ModelImageBlock> {
  signal?.throwIfAborted()
  const policy = openAIVisionPolicy(model)
  if (!hasOpenAIImagePreparation(model))
    throw new Error("Unverified native OpenAI image policy.")
  const metadata = inspectImageBytes(bytes)
  const detail = image.detail ?? "high"
  if (detail === "original" && policy === undefined)
    throw new InvalidImageDataError(
      "Original image detail is not verified for this native OpenAI model. Choose high detail; the original image has not been changed.",
    )
  // Models with a verified patch policy use its server-side sizing rules.
  // No patch size, budget or original mode is inferred for GPT-6.1.
  // GPT-5.4/5.5 original is also resized server-side (6000 edge/10000 patches).
  // Astra/GPT-5.6 original instead has
  // a hard 30000-patch rejection after the 65535-edge adjustment, not a resize
  // budget. Never secretly switch detail or shrink original to evade rejection.
  if (
    detail === "original" &&
    policy !== undefined &&
    policy.originalPatchBudget === undefined
  ) {
    const scale = Math.min(
      1,
      policy.originalMaxDimension / Math.max(metadata.width, metadata.height),
    )
    const width = Math.max(1, Math.round(metadata.width * scale))
    const height = Math.max(1, Math.round(metadata.height * scale))
    if (Math.ceil(width / 32) * Math.ceil(height / 32) > 30000)
      throw new InvalidImageDataError(
        "OpenAI original detail exceeds the 30000-patch input limit. Export a smaller copy or explicitly choose high detail; the original has not been changed.",
      )
  }
  await validateModelImage(bytes, signal)
  if (metadata.mediaType === "image/gif") {
    const { default: sharp } = await import("sharp")
    const gif = await sharp(bytes).metadata()
    signal?.throwIfAborted()
    if ((gif.pages ?? 1) !== 1)
      throw new InvalidImageDataError(
        "OpenAI supports non-animated GIF only. Export a static copy; the animation was not flattened and the original has not been changed.",
      )
  }
  // Preserve format, metadata and every original byte, including high-detail
  // inputs. Provider preprocessing does not mutate the durable source asset.
  return {
    type: "image",
    mediaType: metadata.mediaType,
    detail,
    data: bytes.toString("base64"),
  }
}
