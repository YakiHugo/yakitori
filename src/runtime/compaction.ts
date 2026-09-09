import { ModelResponseError } from "./errors.ts"
import { estimateHistoryTokens } from "./model-request-budget.ts"
import type {
  ModelMessage,
  ModelRequest,
  ModelSystemSection,
  ModelTarget,
} from "./model.ts"

// Local compaction keeps the base instructions and appends a user request,
// following Codex. User-message retention is enforced separately by code.
const LOCAL_COMPACTION_PROMPT = `Write a concise checkpoint for the model that will continue this task. Include completed work and decisions, important constraints and user preferences, remaining actions, and the concrete paths, data, or references needed to proceed. Incorporate any earlier checkpoint into this summary. Return the checkpoint without continuing the task.`

// Matches provider messages for an over-long request (Anthropic "prompt is
// too long", OpenAI "context_length_exceeded" style text, HTTP 413). Used to
// retry compaction with a smaller source instead of giving up.
export function isContextOverflowError(error: unknown): boolean {
  if (
    error instanceof ModelResponseError &&
    ([
      "context_length_exceeded",
      "context_window_exceeded",
      "prompt_too_long",
    ].includes(error.providerError?.code ?? "") ||
      error.providerError?.details?.status === 413)
  )
    return true
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase()
  return (
    message.includes("prompt is too long") ||
    message.includes("context length") ||
    message.includes("context_length") ||
    message.includes("maximum context") ||
    message.includes("too many tokens") ||
    message.includes("request too large") ||
    message.includes("413")
  )
}

export function canRetryCompactionWithCurrentModel(error: unknown): boolean {
  if (!(error instanceof ModelResponseError)) return false
  const details = error.providerError?.details
  const status = details?.status
  return (
    isContextOverflowError(error) ||
    details?.retryable === true ||
    (typeof status === "number" && status >= 400 && status !== 401) ||
    [
      "invalid_request_error",
      "model_not_found",
      "context_length_exceeded",
      "rate_limit_exceeded",
      "usage_limit_reached",
      "server_error",
      "server_overloaded",
    ].includes(error.providerError?.code ?? "")
  )
}

// Match Codex's remote preflight: only shrink consecutive tool outputs at the
// end of history. Never remove a user request or cross the preceding model item.
export function trimRemoteCompactionToolTail(
  messages: readonly ModelMessage[],
  baseInstructions: string,
  contextWindowTokens: number | undefined,
): ModelMessage[] {
  const result = [...messages]
  if (contextWindowTokens === undefined) return result
  let tokens =
    estimateHistoryTokens(result) +
    Math.ceil(Buffer.byteLength(baseInstructions) / 4)
  for (
    let index = result.length - 1;
    index >= 0 && tokens > contextWindowTokens;
    index -= 1
  ) {
    const item = result[index]
    if (item?.role !== "tool") break
    const { images: _images, documents: _documents, ...textResult } = item
    const replacement: ModelMessage = {
      ...textResult,
      content: "Tool output omitted to fit the context window.",
      ...(item.toolSearch === undefined ? {} : { toolSearch: { tools: [] } }),
    }
    tokens +=
      estimateHistoryTokens([replacement]) - estimateHistoryTokens([item])
    result[index] = replacement
  }
  return result
}

export function buildCompactionRequest(input: {
  readonly source: readonly { readonly messages: readonly ModelMessage[] }[]
  readonly target: ModelTarget
  readonly baseInstructions: ModelSystemSection
  readonly cacheKey?: string
  readonly instruction?: string
  readonly signal?: AbortSignal
}): ModelRequest {
  return {
    target: input.target,
    ...(input.cacheKey === undefined ? {} : { cacheKey: input.cacheKey }),
    compaction: "local",
    system: [input.baseInstructions],
    messages: [
      ...input.source.flatMap((group) => group.messages),
      {
        role: "user",
        content: [
          {
            type: "text",
            text: input.instruction ?? LOCAL_COMPACTION_PROMPT,
          },
        ],
      },
    ],
    tools: [],
    toolWireProtocol: "eager",
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }
}
