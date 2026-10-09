// JSON-RPC-style envelope without the "jsonrpc" field, mirroring Codex's
// app-server-protocol rpc.rs: message kinds are discriminated by field shape
// rather than a tag field.

export type RequestId = string | number

export type JsonRpcRequest = Readonly<{
  id: RequestId
  method: string
  params?: unknown
  trace?: unknown
}>

export type JsonRpcNotification = Readonly<{
  method: string
  params?: unknown
}>

export type JsonRpcResponse = Readonly<{
  id: RequestId
  result: unknown
}>

export type JsonRpcErrorObject = Readonly<{
  code: number
  message: string
  data?: unknown
}>

export type JsonRpcErrorResponse = Readonly<{
  id: RequestId
  error: JsonRpcErrorObject
}>

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse
  | JsonRpcErrorResponse

export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603
// Codex's retryable inbound-overload code.
export const SERVER_OVERLOADED = -32001

export class JsonRpcParseError extends Error {
  readonly code: typeof PARSE_ERROR | typeof INVALID_REQUEST

  constructor(
    code: typeof PARSE_ERROR | typeof INVALID_REQUEST,
    message: string,
  ) {
    super(message)
    this.name = "JsonRpcParseError"
    this.code = code
  }
}

export function parseJsonRpcMessage(text: string): JsonRpcMessage {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new JsonRpcParseError(PARSE_ERROR, "message is not valid JSON")
  }
  return toJsonRpcMessage(value)
}

export function serializeJsonRpcMessage(message: JsonRpcMessage): string {
  return JSON.stringify(message)
}

export function resultResponse(
  id: RequestId,
  result: unknown,
): JsonRpcResponse {
  return { id, result }
}

export function errorResponse(
  id: RequestId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  }
}

function toJsonRpcMessage(value: unknown): JsonRpcMessage {
  if (!isRecord(value)) {
    throw new JsonRpcParseError(
      INVALID_REQUEST,
      "message must be a JSON object",
    )
  }
  if ("method" in value) {
    if (typeof value.method !== "string") {
      throw new JsonRpcParseError(INVALID_REQUEST, "method must be a string")
    }
    const method = value.method
    const params = "params" in value ? { params: value.params } : {}
    if (!("id" in value)) {
      return { method, ...params }
    }
    const id = value.id
    if (!isRequestId(id)) {
      throw new JsonRpcParseError(
        INVALID_REQUEST,
        "id must be a string or number",
      )
    }
    const trace = "trace" in value ? { trace: value.trace } : {}
    return { id, method, ...params, ...trace }
  }
  if (!("id" in value)) {
    throw new JsonRpcParseError(
      INVALID_REQUEST,
      "message carries neither method nor id",
    )
  }
  const id = value.id
  if (!isRequestId(id)) {
    throw new JsonRpcParseError(
      INVALID_REQUEST,
      "id must be a string or number",
    )
  }
  // A frame carrying both result and error classifies as a Response: Codex's
  // untagged enum tries the Response variant before Error.
  if ("result" in value) {
    return { id, result: value.result }
  }
  if ("error" in value) {
    return { id, error: toErrorObject(value.error) }
  }
  throw new JsonRpcParseError(
    INVALID_REQUEST,
    "message with id must carry a method, result, or error",
  )
}

function toErrorObject(value: unknown): JsonRpcErrorObject {
  if (
    !isRecord(value) ||
    typeof value.code !== "number" ||
    typeof value.message !== "string"
  ) {
    throw new JsonRpcParseError(
      INVALID_REQUEST,
      "error must carry a numeric code and a string message",
    )
  }
  return {
    code: value.code,
    message: value.message,
    ...("data" in value ? { data: value.data } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRequestId(value: unknown): value is RequestId {
  // Codex's RequestId is String | Integer(i64); fractional numbers are not
  // valid ids.
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isInteger(value))
  )
}
