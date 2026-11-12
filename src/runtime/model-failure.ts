import type {
  ModelFailure,
  ModelFailureKind,
  ModelFailureStage,
  ModelWireApi,
} from "./model.ts"

const disconnectedCodes = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_SOCKET",
])

// These describe local arguments, configuration, or resource ownership.
// SDKs can wrap them in APIConnectionError; reconnecting cannot repair them.
const terminalTransportCodes = new Set([
  "UND_ERR_INVALID_ARG",
  "UND_ERR_INVALID_RETURN_VALUE",
  "UND_ERR_NOT_SUPPORTED",
  "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
  "UND_ERR_CLOSED",
  "UND_ERR_DESTROYED",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_ARG_VALUE",
  "ERR_MISSING_ARGS",
  "ERR_OUT_OF_RANGE",
  "ERR_INVALID_URL",
  "ERR_INVALID_PROTOCOL",
  "ERR_UNESCAPED_CHARACTERS",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
])

// Inspect only a structured provider payload. SDK Error.message can contain
// headers or the whole response body and is not a durable diagnostic source.
// xAI often returns `{ code, error: "<reason>" }` with a string `error` field
// instead of OpenAI's `{ error: { message } }` object.
// OpenAI SDK callers must rewrap APIError.error: the SDK already extracted it
// from the response object, so xAI's reason arrives as a bare string there.
export function providerErrorMessage(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  if (
    "error" in payload &&
    typeof payload.error === "string" &&
    payload.error.trim() !== ""
  ) {
    return payload.error
  }
  const error =
    "error" in payload &&
    typeof payload.error === "object" &&
    payload.error !== null
      ? payload.error
      : payload
  if ("message" in error && typeof error.message === "string") {
    return error.message
  }
  return undefined
}

export function modelFailureFromUnknown(
  error: unknown,
  input: Readonly<{
    provider: string
    wireApi: ModelWireApi
    stage: ModelFailureStage
    fallbackMessage: string
    kind?: ModelFailureKind
    status?: number
    providerCode?: string
    providerMessage?: string | undefined
    providerRequestId?: string
    providerResponseId?: string
    retryAfterMs?: number
    serverShouldRetry?: boolean
  }>,
): ModelFailure {
  const chain = errorChain(error)
  const codes = chain.map(errorCode)
  const localCode = codes.find(
    (code) => code !== undefined && terminalTransportCodes.has(code),
  )
  const disconnectedCode = codes.find(
    (code) => code !== undefined && disconnectedCodes.has(code),
  )
  const causeCode =
    localCode ?? disconnectedCode ?? codes.find((code) => code !== undefined)
  const disconnected = disconnectedCode !== undefined
  const rootCause = chain.at(-1)
  const localFailure =
    localCode !== undefined ||
    (!disconnected &&
      (rootCause instanceof TypeError ||
        rootCause instanceof RangeError ||
        rootCause instanceof ReferenceError))
  const kind =
    (localFailure ? "invalid_request" : input.kind) ??
    (disconnected
      ? input.stage === "connect" || input.stage === "response_headers"
        ? "connection_failed"
        : "stream_disconnected"
      : "provider_error")
  // Keep only an adapter-selected error reason, never the SDK's formatted
  // Error.message, which can include an entire response body.
  // Bound diagnostic text so a provider cannot inflate durable failure records.
  const providerMessage = input.providerMessage?.trim().slice(0, 2_000)
  const summary = localFailure
    ? "The model request failed because of a local transport or configuration error."
    : stableFailureMessage(kind, input.fallbackMessage)
  const serverShouldRetry =
    localFailure ||
    input.providerCode === "insufficient_quota" ||
    input.providerCode === "usage_limit_reached" ||
    input.providerCode === "credit_balance_exhausted"
      ? false
      : input.serverShouldRetry
  const context = [
    ...(input.status === undefined ? [] : [`HTTP ${input.status}`]),
    ...(input.providerCode === undefined ? [] : [input.providerCode]),
  ].join(", ")
  const message = providerMessage
    ? `${summary}${context ? ` (${context})` : ""} ${providerMessage}`
    : summary
  return {
    kind,
    stage: input.stage,
    provider: input.provider,
    wireApi: input.wireApi,
    message,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.providerCode === undefined
      ? {}
      : { providerCode: input.providerCode }),
    ...(input.providerRequestId === undefined
      ? {}
      : { providerRequestId: input.providerRequestId }),
    ...(input.providerResponseId === undefined
      ? {}
      : { providerResponseId: input.providerResponseId }),
    ...(input.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: input.retryAfterMs }),
    ...(serverShouldRetry === undefined ? {} : { serverShouldRetry }),
    ...(causeCode === undefined && !providerMessage
      ? {}
      : {
          details: {
            ...(causeCode === undefined ? {} : { causeCode }),
            ...(providerMessage ? { providerMessage } : {}),
          },
        }),
  }
}

export function failureKindForStatus(
  status: number | undefined,
): ModelFailureKind {
  if (status === 401) return "authentication"
  if (status === 408) return "connection_failed"
  if (status === 409) return "server_error"
  if (status === 429) return "rate_limited"
  if (status !== undefined && status >= 500) return "server_error"
  if (status !== undefined && status >= 400) return "invalid_request"
  return "provider_error"
}

function stableFailureMessage(
  kind: ModelFailureKind,
  fallback: string,
): string {
  if (kind === "connection_failed")
    return "Could not connect to the model provider."
  if (kind === "stream_disconnected")
    return "The model response stream disconnected before completion."
  if (kind === "idle_timeout")
    return "The model response stream timed out while waiting for data."
  if (kind === "rate_limited")
    return "The model provider rate limited the request."
  if (kind === "server_error")
    return "The model provider encountered a temporary server error."
  if (kind === "authentication")
    return "The model provider rejected the configured credentials."
  if (kind === "invalid_request")
    return "The model provider rejected the request."
  if (kind === "protocol_error")
    return "The model provider returned an invalid streaming response."
  return fallback
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code
  }
  return undefined
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== undefined && current !== null && chain.length < 8) {
    if (seen.has(current)) break
    seen.add(current)
    chain.push(current)
    current =
      typeof current === "object" && "cause" in current
        ? current.cause
        : undefined
  }
  return chain
}
