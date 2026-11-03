import { inspectImageBytes } from "../kernel/image-metadata.ts"
import { AssetMediaError } from "./asset-media.ts"
import { jsonRequestByteLength } from "./json-request-budget.ts"
import type { ModelImageBlock, ModelRequest } from "./model.ts"
import { validateModelImage } from "./prepare-model-image.ts"

export const nvidiaVisionModel = "nvidia/nemotron-3.5-super-vl-120b-a12b"

// Hosted Super VL contract, checked 2026-11-03:
// https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-super-vl-120b-a12b-infer
// https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b
// Build's exact-model schema documents high detail; its upload client sends
// FileReader data URLs as image_url.url and admits JPEG/PNG/WebP. Do not copy
// Playground-only file/count limits or another NIM model's NVCF asset policy.
// No published hosted image count/byte limit. Bound aggregate base64, history,
// text and tools locally to avoid unbounded allocations, NOT as a vendor quota.
const REQUEST_SAFETY_BYTES = 32_000_000

export function isNvidiaEndpoint(baseURL: string): boolean {
  return (
    URL.parse(baseURL)?.href.replace(/\/$/, "") ===
    "https://integrate.api.nvidia.com/v1"
  )
}

export function validateNvidiaRequest(
  request: ModelRequest,
  model: string,
): void {
  if (model !== nvidiaVisionModel)
    throw new AssetMediaError(
      "NVIDIA native requests currently support nvidia/nemotron-3.5-super-vl-120b-a12b only. Other Nemotron and third-party models have separate API contracts; select the documented Super VL model.",
    )
  if (
    request.target.effort !== undefined &&
    !["none", "low", "high"].includes(request.target.effort)
  )
    throw new AssetMediaError(
      "Nemotron Super VL reasoning effort must be none, low, or high.",
    )
  if (
    request.maxOutputTokens !== undefined &&
    (!Number.isInteger(request.maxOutputTokens) ||
      request.maxOutputTokens < 1 ||
      request.maxOutputTokens > 131_072)
  )
    throw new AssetMediaError(
      "NVIDIA hosted Super VL accepts an output budget from 1 to 131072 tokens.",
    )
  if (
    request.tools.some(
      (tool) =>
        tool.kind === "custom" && tool.customInputFallbackKey === undefined,
    ) ||
    request.providerOptions?.body.tools !== undefined
  )
    throw new AssetMediaError(
      "NVIDIA Super VL supports harness function tools, not native custom or provider-hosted tools.",
    )
  if (request.providerOptions?.body.chat_template_kwargs !== undefined)
    throw new AssetMediaError(
      "Use the captured Nemotron reasoning effort instead of chat_template_kwargs; template overrides could replace system or reasoning behavior.",
    )
}

export function createNvidiaImagePolicy(request: ModelRequest) {
  const hasImages = request.messages.some(
    (message) =>
      (message.role === "user" || message.role === "tool") &&
      message.content.some((block) => block.type === "image"),
  )
  if (!hasImages) return undefined
  let encodedBytes = 0
  return {
    async prepareImage(bytes: Buffer): Promise<ModelImageBlock> {
      encodedBytes += 4 * Math.ceil(bytes.length / 3)
      if (encodedBytes > REQUEST_SAFETY_BYTES) throw requestSizeError()
      const metadata = inspectImageBytes(bytes)
      if (
        !["image/jpeg", "image/png", "image/webp"].includes(metadata.mediaType)
      )
        throw new AssetMediaError(
          "NVIDIA Super VL image input currently admits JPEG, PNG, and WebP only. Export a copy; the original has not been changed.",
        )
      // Preserve source bytes, including alpha, EXIF and full dimensions.
      // The documented high detail mode lets the service own visual processing.
      await validateModelImage(bytes, request.signal)
      return {
        type: "image",
        mediaType: metadata.mediaType,
        data: bytes.toString("base64"),
      }
    },
    validateBody(body: unknown): void {
      if (jsonRequestByteLength(body, REQUEST_SAFETY_BYTES) === undefined)
        throw requestSizeError()
    },
  }
}

function requestSizeError() {
  return new AssetMediaError(
    "NVIDIA images were not sent: encoded images, text and tools exceed Yakitori's local 32 MB request safety budget (not a published NVIDIA quota). Send fewer images or reduce content; originals have not been changed.",
  )
}
