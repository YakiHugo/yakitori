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
    providerRequestId?: string
    retryAfterMs?: number
    serverShouldRetry?: boolean
  }>,
): ModelFailure {
  const causeCode = errorCodeFromChain(error)
  const disconnected =
    (causeCode !== undefined && disconnectedCodes.has(causeCode)) ||
    errorMessageFromChain(error, (message) =>
      /(?:^terminated$|socket hang up|connection (?:closed|reset)|other side closed)/i.test(
        message.trim(),
      ),
    )
  const kind =
    input.kind ??
    (disconnected
      ? input.stage === "connect" || input.stage === "response_headers"
        ? "connection_failed"
        : "stream_disconnected"
      : "provider_error")
  const message = stableFailureMessage(kind, input.fallbackMessage)
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
    ...(input.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: input.retryAfterMs }),
    ...(input.serverShouldRetry === undefined
      ? {}
      : { serverShouldRetry: input.serverShouldRetry }),
    ...(causeCode === undefined ? {} : { details: { causeCode } }),
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

function errorCodeFromChain(error: unknown): string | undefined {
  for (const current of errorChain(error)) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      typeof current.code === "string"
    ) {
      return current.code
    }
  }
  return undefined
}

function errorMessageFromChain(
  error: unknown,
  matches: (message: string) => boolean,
): boolean {
  return errorChain(error).some(
    (current) => current instanceof Error && matches(current.message),
  )
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
