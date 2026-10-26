import { randomUUID } from "node:crypto"
import { isJsonObject, type JsonValue } from "../kernel/index.ts"
import { AssetMediaError, prepareProviderMedia } from "./asset-media.ts"
import { toGeminiInteractionInput } from "./gemini-interactions-input.ts"
import {
  createGeminiInteractionOutput,
  GeminiInteractionFailedError,
} from "./gemini-interactions-output.ts"
import type { GeminiProviderOptions } from "./gemini-provider.ts"
import {
  GeminiIncompleteStreamError,
  GeminiProtocolError,
  geminiSse,
  readGeminiError,
} from "./gemini-transport.ts"
import {
  flattenModelSystem,
  type ModelFailureStage,
  type ModelRequest,
  type ModelStreamEvent,
  type StreamFn,
} from "./model.ts"
import {
  failureKindForStatus,
  modelFailureFromUnknown,
  providerErrorMessage,
} from "./model-failure.ts"
import {
  ModelHistoryScopeError,
  validateModelHistoryScope,
} from "./model-native.ts"
import {
  applyModelRequestControls,
  ModelRequestControlsError,
  validateModelRequestControls,
} from "./model-request-controls.ts"
import { GEMINI_INLINE_REQUEST_MAX_BYTES } from "./native-pdf-capabilities.ts"
import { parseRetryAfterMs } from "./retry-after.ts"

class InteractionsHttpError extends Error {}

export function createGeminiInteractionsProvider(
  options: GeminiProviderOptions,
): StreamFn {
  return (request) => streamInteractions(options, request)
}

async function* streamInteractions(
  options: GeminiProviderOptions,
  request: ModelRequest,
): AsyncGenerator<ModelStreamEvent> {
  if (request.signal?.aborted) {
    yield { type: "cancelled" }
    return
  }
  const itemId = `gemini_interaction_${randomUUID()}`
  const output = createGeminiInteractionOutput(request, itemId)
  let stage: ModelFailureStage = "request_build"
  let response: Response | undefined
  let errorPayload: unknown
  let providerRequestId: string | undefined
  try {
    validateModelHistoryScope(request, "gemini_interactions")
    validateModelRequestControls(request, "gemini_interactions")
    if (request.compaction !== undefined && request.compaction !== "local")
      throw new ModelRequestControlsError(
        "Interactions does not support remote compaction.",
      )
    if (request.parallelToolCalls === false)
      throw new ModelRequestControlsError(
        "Interactions cannot guarantee serial function calls.",
      )
    const model = (request.target.model || options.model).replace(
      /^models\//,
      "",
    )
    if (!/^[a-zA-Z0-9._-]+$/.test(model))
      throw new ModelRequestControlsError("Invalid Gemini model ID.")
    const media = await prepareProviderMedia(request, {
      inlineImageUrls: true,
      inlineDocumentUrls: true,
    })
    const generation: Record<string, JsonValue> = { thinking_summaries: "auto" }
    if (request.target.effort !== undefined) {
      if (!["minimal", "low", "medium", "high"].includes(request.target.effort))
        throw new ModelRequestControlsError(
          "Unsupported Interactions thinking level.",
        )
      generation.thinking_level = request.target.effort
    }
    if (request.maxOutputTokens !== undefined)
      generation.max_output_tokens = request.maxOutputTokens
    if (request.toolChoice !== undefined)
      generation.tool_choice =
        typeof request.toolChoice === "object"
          ? { allowed_tools: { mode: "any", tools: [request.toolChoice.name] } }
          : request.toolChoice === "required"
            ? "any"
            : request.toolChoice
    const tools = request.tools.map((tool) => {
      if (tool.kind === "custom" && tool.customInputFallbackKey === undefined)
        throw new ModelRequestControlsError(
          "Interactions custom tools require a JSON fallback.",
        )
      return {
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      }
    })
    const body = applyModelRequestControls(request, "gemini_interactions", {
      model,
      input: toGeminiInteractionInput(
        media.messages,
        request.target.provider,
        request.continuationScope,
        request.target.model || options.model,
      ),
      system_instruction: flattenModelSystem(request.system),
      tools,
      generation_config: generation,
      response_format:
        request.outputFormat === undefined
          ? { type: "text", mime_type: "text/plain" }
          : {
              type: "text",
              mime_type: "application/json",
              schema: request.outputFormat.schema,
            },
      // The harness owns durable history and the tool loop; no server-side
      // conversation, managed agent, or background execution is involved.
      store: false,
      stream: true,
    })
    const serialized = JSON.stringify(body)
    if (
      request.messages.some(
        (message) =>
          (message.role === "user" || message.role === "tool") &&
          message.content.some((block) => block.type === "document"),
      ) &&
      Buffer.byteLength(serialized, "utf8") > GEMINI_INLINE_REQUEST_MAX_BYTES
    )
      throw new ModelRequestControlsError(
        "Interactions request exceeds the 100 MB inline limit.",
      )
    stage = "connect"
    response = await (options.fetchFn ?? fetch)(
      `${options.baseURL.replace(/\/$/, "")}/interactions`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          ...(options.apiKey ? { "x-goog-api-key": options.apiKey } : {}),
        },
        body: serialized,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
    )
    stage = "response_headers"
    providerRequestId = response.headers.get("x-request-id") ?? undefined
    if (!response.ok) {
      errorPayload = await readGeminiError(response)
      throw new InteractionsHttpError("Interactions HTTP request failed.")
    }
    if (
      !response.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("text/event-stream") ||
      response.body === null
    )
      throw new GeminiProtocolError("Interactions did not return an SSE body.")
    stage = "response_body"
    for await (const payload of geminiSse(response.body, true)) {
      if (
        isJsonObject(payload) &&
        payload.event_type === "error" &&
        !request.signal?.aborted
      ) {
        const error = isJsonObject(payload.error) ? payload.error : {}
        yield {
          type: "failure",
          failure: modelFailureFromUnknown(undefined, {
            provider: request.target.provider,
            wireApi: "gemini_interactions",
            stage: "model_event",
            fallbackMessage: "Gemini Interactions request failed.",
            providerMessage: providerErrorMessage(error),
            ...(typeof error.code === "string"
              ? { providerCode: error.code }
              : {}),
            ...(providerRequestId === undefined ? {} : { providerRequestId }),
            ...(output.responseId === undefined
              ? {}
              : { providerResponseId: output.responseId }),
          }),
          ...(output.usage === undefined ? {} : { usage: output.usage }),
        }
        return
      }
      for (const event of output.accept(payload)) yield event
      if (request.signal?.aborted) {
        yield {
          type: "cancelled",
          ...(output.usage === undefined ? {} : { usage: output.usage }),
        }
        return
      }
    }
    if (request.signal?.aborted) {
      yield {
        type: "cancelled",
        ...(output.usage === undefined ? {} : { usage: output.usage }),
      }
      return
    }
    const result = output.finish()
    if (
      request.streamOutputItems &&
      (result.content.length > 0 || (result.native?.length ?? 0) > 0)
    )
      yield {
        type: "output_item",
        itemId,
        content: result.content,
        ...(result.native === undefined ? {} : { native: result.native }),
      }
    yield {
      type: "response",
      response: {
        ...result,
        ...(providerRequestId === undefined ? {} : { providerRequestId }),
      },
    }
  } catch (error) {
    if (request.signal?.aborted) {
      yield {
        type: "cancelled",
        ...(output.usage === undefined ? {} : { usage: output.usage }),
      }
      return
    }
    if (
      error instanceof ModelRequestControlsError ||
      error instanceof ModelHistoryScopeError ||
      error instanceof AssetMediaError
    ) {
      yield {
        type: "failure",
        failure: {
          provider: request.target.provider,
          wireApi: "gemini_interactions",
          stage: "request_build",
          kind: "invalid_request",
          message: error.message,
          ...(error instanceof ModelHistoryScopeError
            ? { providerCode: error.code }
            : {}),
        },
      }
      return
    }
    if (
      !(
        error instanceof GeminiProtocolError ||
        error instanceof GeminiInteractionFailedError ||
        error instanceof GeminiIncompleteStreamError ||
        error instanceof InteractionsHttpError ||
        error instanceof SyntaxError ||
        error instanceof TypeError ||
        error instanceof DOMException
      )
    )
      throw error
    const status =
      response !== undefined && !response.ok ? response.status : undefined
    const retryAfterMs = parseRetryAfterMs(response?.headers)
    yield {
      type: "failure",
      failure: modelFailureFromUnknown(error, {
        provider: request.target.provider,
        wireApi: "gemini_interactions",
        stage:
          error instanceof GeminiInteractionFailedError
            ? "model_event"
            : error instanceof SyntaxError
              ? "sse_decode"
              : stage,
        fallbackMessage: "Gemini Interactions request failed.",
        kind:
          error instanceof GeminiInteractionFailedError
            ? "provider_error"
            : status !== undefined
              ? failureKindForStatus(status)
              : error instanceof GeminiProtocolError ||
                  error instanceof SyntaxError
                ? "protocol_error"
                : stage === "connect"
                  ? "connection_failed"
                  : "stream_disconnected",
        ...(status === undefined ? {} : { status }),
        ...(error instanceof GeminiInteractionFailedError
          ? { providerCode: error.status }
          : {}),
        providerMessage: providerErrorMessage(errorPayload),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        ...(providerRequestId === undefined ? {} : { providerRequestId }),
        ...(output.responseId === undefined
          ? {}
          : { providerResponseId: output.responseId }),
      }),
      ...(output.usage === undefined ? {} : { usage: output.usage }),
      cause: error,
    }
  }
}
