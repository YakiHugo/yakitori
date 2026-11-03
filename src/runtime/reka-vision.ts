import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions"
import { inspectImageBytes } from "../kernel/image-metadata.ts"
import { AssetMediaError } from "./asset-media.ts"
import { jsonRequestByteLength } from "./json-request-budget.ts"
import type { ModelImageBlock, ModelRequest } from "./model.ts"
import { validateModelImage } from "./prepare-model-image.ts"

export const rekaVisionModel = "reka-edge-2603"

export function isRekaEndpoint(baseURL: string): boolean {
  return (
    URL.parse(baseURL)?.href.replace(/\/$/, "") === "https://api.reka.ai/v1"
  )
}

// Hosted API contracts, checked 2026-11-03 (not the self-hosted vLLM defaults):
// https://docs.reka.ai/chat/models
// https://docs.reka.ai/chat/multimodal
// https://docs.reka.ai/chat/api-reference/create-chat-completion
// Reka documents data URLs and a three-image prompt limit, but no complete MIME
// allowlist, pixel limit or byte quota. Preserve locally decodable image bytes;
// the service owns format admission. Do not infer an OpenAI detail parameter.
// Bound aggregate encoding and JSON allocation locally, NOT as a Reka quota.
const REQUEST_SAFETY_BYTES = 64_000_000

export function createRekaVisionPolicy(request: ModelRequest, model: string) {
  if (model !== rekaVisionModel)
    throw new AssetMediaError(
      "Reka currently supports reka-edge-2603 in this adapter. Other models are not assumed compatible; select the documented Edge model.",
    )
  if (
    typeof request.toolChoice === "object" ||
    request.parallelToolCalls !== undefined ||
    request.target.effort !== undefined
  )
    throw new AssetMediaError(
      "Reka documents auto, none and required tool choice. Named tool selection, parallel-tool and reasoning-effort overrides are not enabled in this adapter. Remove those overrides; the request was not sent.",
    )
  for (const key of Object.keys(request.providerOptions?.body ?? {})) {
    if (
      ![
        "temperature",
        "top_p",
        "top_k",
        "stop",
        "seed",
        "frequency_penalty",
        "presence_penalty",
        // Tool validation below rejects hosted extensions after conversion.
        "tools",
      ].includes(key)
    )
      throw new AssetMediaError(
        `Reka Edge does not document the ${key} request control. Remove that override; the request was not sent.`,
      )
  }
  let imageCount = 0
  for (const message of request.messages) {
    if (message.role !== "user" && message.role !== "tool") continue
    for (const block of message.content) {
      if (block.type === "document")
        throw new AssetMediaError("Reka Chat does not document PDF input.")
      if (block.type === "image") imageCount += 1
    }
  }
  if (imageCount > 3)
    throw new AssetMediaError(
      "Reka Edge accepts at most three images across the whole prompt, including tool results and history. Send fewer images or start a new conversation; originals have not been changed.",
    )
  let encodedBytes = 0
  return {
    async prepareImage(
      bytes: Buffer,
      _image: ModelImageBlock,
    ): Promise<ModelImageBlock> {
      encodedBytes += 4 * Math.ceil(bytes.length / 3)
      if (encodedBytes > REQUEST_SAFETY_BYTES) throw requestSizeError()
      const metadata = inspectImageBytes(bytes)
      await validateModelImage(bytes, request.signal)
      return {
        type: "image",
        mediaType: metadata.mediaType,
        data: bytes.toString("base64"),
      }
    },
    validateBody(body: object, messages: ChatCompletionMessageParam[]): void {
      if (
        request.tools.some(
          (tool) =>
            (tool.kind === "custom" &&
              tool.customInputFallbackKey === undefined) ||
            tool.strict !== undefined,
        ) ||
        messages.some(
          (message) =>
            message.role === "assistant" &&
            message.tool_calls?.some((call) => call.type !== "function"),
        ) ||
        request.providerOptions?.body.tools !== undefined
      )
        throw new AssetMediaError(
          "Reka Chat admits documented function tools without strict overrides. Native custom and hosted tools are not enabled in this adapter. Configure a function fallback or remove unsupported overrides; history has not been changed.",
        )
      if (jsonRequestByteLength(body, REQUEST_SAFETY_BYTES) === undefined)
        throw requestSizeError()
    },
  }
}

function requestSizeError() {
  return new AssetMediaError(
    "Reka request exceeds Yakitori's local 64 MB safety budget for images, text and tools (not a published Reka quota). Send fewer images or reduce content; originals have not been changed.",
  )
}
