import { ModelFailureError } from "./errors.ts"
import type {
  ModelMessage,
  ModelRequest,
  ModelSystemSection,
  ModelTarget,
} from "./model.ts"
import { estimateHistoryTokens } from "./model-request-budget.ts"

// Local compaction keeps the base instructions and appends a user request,
// following Codex. User-message retention is enforced separately by code.
const LOCAL_COMPACTION_PROMPT = `Write a concise checkpoint for the model that will continue this task. Include completed work and decisions, important constraints and user preferences, remaining actions, and the concrete paths, data, or references needed to proceed. Incorporate any earlier checkpoint into this summary. Return the checkpoint without continuing the task.`

// Structured overflow signals take precedence. Prose is only a fallback for
// request rejections, so unrelated failures cannot trigger history trimming.
export function isContextOverflowError(error: unknown): boolean {
  if (error instanceof ModelFailureError) {
    const { kind, stage, status, providerCode, details } = error.failure
    if (
      [
        "context_length_exceeded",
        "context_window_exceeded",
        "prompt_too_long",
      ].includes(providerCode ?? "") ||
      status === 413
    )
      return true
    if (
      (kind !== "invalid_request" && kind !== "provider_error") ||
      stage === "request_build" ||
      (status !== undefined && status !== 400 && status !== 422) ||
      compactionBillingCodes.has(providerCode ?? "") ||
      [
        "authentication_error",
        "permission_error",
        "rate_limit_error",
        "rate_limit_exceeded",
        "server_error",
        "server_overloaded",
        "overloaded_error",
      ].includes(providerCode ?? "") ||
      // A transport cause without a provider response is not overflow evidence.
      (status === undefined &&
        providerCode === undefined &&
        details?.causeCode !== undefined)
    )
      return false
  }
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase()
  return (
    message.includes("prompt is too long") ||
    /\bcontext[ _-](?:length|window)[ _-](?:is[ _-])?(?:exceeded|exceeds)\b/.test(
      message,
    ) ||
    /\b(?:exceeds?|exceeded)\b[^.\n]*\bcontext (?:length|window)\b/.test(
      message,
    ) ||
    /\bmaximum context (?:length|window)\b/.test(message) ||
    message.includes("too many tokens") ||
    message.includes("request too large")
  )
}

const compactionBillingCodes = new Set([
  "credit_balance_exhausted",
  "insufficient_quota",
  "usage_limit_reached",
])

// Billing and reachability failures mean the previous model cannot prepare a
// checkpoint. A portable history can move to the selected model; an opaque
// native checkpoint cannot.
export function isCompactionSourceUnavailable(error: unknown): boolean {
  if (!(error instanceof ModelFailureError)) return false
  const { kind, providerCode } = error.failure
  return (
    kind === "connection_failed" ||
    kind === "rate_limited" ||
    (providerCode !== undefined && compactionBillingCodes.has(providerCode))
  )
}

export function canRetryCompactionWithCurrentModel(error: unknown): boolean {
  if (!(error instanceof ModelFailureError)) return false
  const status = error.failure.status
  return (
    isContextOverflowError(error) ||
    isCompactionSourceUnavailable(error) ||
    error.failure.kind === "server_error" ||
    error.failure.kind === "stream_disconnected" ||
    (typeof status === "number" && status >= 400 && status !== 401) ||
    [
      "invalid_request_error",
      "model_not_found",
      "context_length_exceeded",
      "rate_limit_exceeded",
      "server_error",
      "server_overloaded",
    ].includes(error.failure.providerCode ?? "")
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
    const replacement: ModelMessage = {
      ...item,
      content: [
        {
          type: "text",
          text: "Tool output omitted to fit the context window.",
        },
      ],
      ...(item.toolSearch === undefined ? {} : { toolSearch: { tools: [] } }),
    }
    tokens +=
      estimateHistoryTokens([replacement]) - estimateHistoryTokens([item])
    result[index] = replacement
  }
  return result
}

export function buildCompactionRequest(input: {
  readonly assets?: ModelRequest["assets"]
  readonly source: readonly { readonly messages: readonly ModelMessage[] }[]
  readonly target: ModelTarget
  readonly baseInstructions: ModelSystemSection
  readonly cacheKey?: string
  readonly maxOutputTokens?: number
  readonly instruction?: string
  readonly signal?: AbortSignal
}): ModelRequest {
  return {
    target: input.target,
    ...(input.assets === undefined ? {} : { assets: input.assets }),
    ...(input.cacheKey === undefined ? {} : { cacheKey: input.cacheKey }),
    ...(input.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: input.maxOutputTokens }),
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
