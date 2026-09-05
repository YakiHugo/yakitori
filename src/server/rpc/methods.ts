import {
  isYakitoriError,
  type StoredEventEnvelope,
} from "../../kernel/index.ts"
import type { LiveSessionEvent } from "../../runtime/live-events.ts"
import type { ServerHandlers } from "../handlers.ts"
import { requireUserModelPreference } from "../http.ts"
import type { ProjectRegistry } from "../project-registry.ts"
import {
  type ApiAddProjectResponse,
  type ApiAdmitInputRequest,
  type ApiAdmitInputResponse,
  type ApiCancelInputRequest,
  type ApiCancelInputResponse,
  type ApiCancelTurnRequest,
  type ApiCancelTurnResponse,
  type ApiCompactSessionResponse,
  type ApiCreateSessionRequest,
  type ApiCreateSessionResponse,
  type ApiDeleteSessionResponse,
  ApiErrorCode,
  type ApiForkSessionRequest,
  type ApiForkSessionResponse,
  type ApiHandlerResult,
  type ApiListProjectsResponse,
  type ApiListProvidersResponse,
  type ApiListSessionsResponse,
  type ApiPendingPermission,
  type ApiReadSessionRequest,
  type ApiReadSessionResponse,
  type ApiResolvePermissionRequest,
  type ApiUpdateUserModelPreferenceResponse,
  type ApiUserModelPreference,
} from "../protocol.ts"
import type { UserConfigStore } from "../user-config.ts"
import { INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND } from "./messages.ts"
import type { RequestSerializationScope } from "./serialization.ts"
import type { SessionSubscriptions } from "./subscriptions.ts"

// The C8-D1 method surface: Codex's <resource>/<method> naming with the
// Yakitori domain keeping `session` instead of `thread`. Params and response
// DTOs are reused from protocol.ts; validation stays at the handler boundary
// and invalid input maps to INVALID_PARAMS.

export type InitializeParams = Readonly<{
  clientInfo: Readonly<{ name: string; version: string }>
  capabilities?: Readonly<{
    experimentalApi?: boolean
    optOutNotificationMethods?: readonly string[]
  }>
}>

export type InitializeResponse = Readonly<{
  userAgent: string
  platformFamily: string
  platformOs: string
}>

export type SessionListParams = Readonly<{
  cursor?: string
  limit?: number
  workingDirectory?: string
}>

export type SessionSubscribeParams = Readonly<{
  sessionId: string
  after?: number
}>

export type SessionSubscribeResponse = ApiReadSessionResponse

export type SessionUnsubscribeParams = Readonly<{ sessionId: string }>

export type ProjectAddParams = Readonly<{ path: string }>

// Server→client notification payloads. Each event notification carries its
// durable cursor, so re-subscribe takes `after` and no cursor frame exists.
export type SessionEventNotification = Readonly<{
  sessionId: string
  seq: number
  event: StoredEventEnvelope
}>

export type SessionReplayCompleteNotification = Readonly<{
  sessionId: string
  seq: number
}>

export type SessionPermissionRequestedNotification = Readonly<
  { sessionId: string } & ApiPendingPermission
>

export type SessionTransientNotification = LiveSessionEvent

// The session/permission/request server→client method (Codex parity:
// approvals are correlated RPCs, not POST + notification). Params carry the
// same tool detail as the permission.requested transient; the response result
// is the resolve body the old REST route accepted.
export const sessionPermissionRequestMethod = "session/permission/request"

export type SessionPermissionRequestParams = Readonly<
  { sessionId: string } & ApiPendingPermission
>

export type SessionPermissionRequestResult = Readonly<
  Pick<ApiResolvePermissionRequest, "behavior" | "reason">
>

export type RpcMethodOutcome = Readonly<{
  result: unknown
  // Runs after the response frame is sent, detached from the connection gate
  // and the serialization queue: session/subscribe uses it so the snapshot
  // response precedes the replay notification chain on the wire, and a slow
  // multi-page replay must not hold the session queue (it honors the
  // subscription's closed flag instead).
  afterResponse?: () => Promise<void>
}>

export type RpcMethodContext = Readonly<{
  connectionId: number
  handlers: ServerHandlers
  subscriptions: SessionSubscriptions
  projectRegistry: ProjectRegistry | undefined
  providers: (() => Promise<ApiListProvidersResponse>) | undefined
  userConfig: UserConfigStore | undefined
  availableProviders: readonly string[] | undefined
}>

export type RpcMethodDefinition = Readonly<{
  method: string
  experimental?: boolean
  // An undefined scope means the method is unserialized (Codex
  // serialization: None): it still runs under the connection gate but skips
  // the serialization queues entirely.
  scope(params: unknown): RequestSerializationScope | undefined
  invoke(params: unknown, context: RpcMethodContext): Promise<RpcMethodOutcome>
}>

// Error path for method invocation: carries the JSON-RPC error the client
// receives; for handler failures `data.code` preserves the ApiErrorCode.
export class RpcMethodError extends Error {
  readonly rpcCode: number
  readonly data?: unknown

  constructor(rpcCode: number, message: string, data?: unknown) {
    super(message)
    this.name = "RpcMethodError"
    this.rpcCode = rpcCode
    if (data !== undefined) this.data = data
  }
}

export function parseInitializeParams(params: unknown): InitializeParams {
  const record = requireParamsRecord(params, "initialize")
  const clientInfo = record.clientInfo
  if (!isRecord(clientInfo)) {
    throw invalidParams("clientInfo must be an object.")
  }
  const name = clientInfo.name
  const version = clientInfo.version
  if (typeof name !== "string" || name.trim() === "") {
    throw invalidParams("clientInfo.name must be a non-empty string.")
  }
  if (typeof version !== "string" || version.trim() === "") {
    throw invalidParams("clientInfo.version must be a non-empty string.")
  }
  return {
    clientInfo: { name, version },
    ...(record.capabilities === undefined
      ? {}
      : { capabilities: parseInitializeCapabilities(record.capabilities) }),
  }
}

export function adaptHandlerResult<T>(result: ApiHandlerResult<T>): T {
  if (result.ok) return result.body
  const { error } = result.body
  const rpcCode =
    error.code === ApiErrorCode.InvalidInput ||
    error.code === ApiErrorCode.InvalidCursor
      ? INVALID_PARAMS
      : INTERNAL_ERROR
  throw new RpcMethodError(rpcCode, error.message, {
    code: error.code,
    ...(error.details === undefined ? {} : { details: error.details }),
  })
}

function parseInitializeCapabilities(
  value: unknown,
): NonNullable<InitializeParams["capabilities"]> {
  if (!isRecord(value)) {
    throw invalidParams("capabilities must be an object.")
  }
  const experimentalApi = value.experimentalApi
  if (experimentalApi !== undefined && typeof experimentalApi !== "boolean") {
    throw invalidParams("capabilities.experimentalApi must be a boolean.")
  }
  const optOut = value.optOutNotificationMethods
  if (
    optOut !== undefined &&
    (!Array.isArray(optOut) ||
      !optOut.every((entry) => typeof entry === "string"))
  ) {
    throw invalidParams(
      "capabilities.optOutNotificationMethods must be an array of strings.",
    )
  }
  return {
    ...(experimentalApi === undefined ? {} : { experimentalApi }),
    ...(optOut === undefined ? {} : { optOutNotificationMethods: optOut }),
  }
}

function parseSessionSubscribeParams(params: unknown): SessionSubscribeParams {
  const record = requireParamsRecord(params, "session/subscribe")
  const sessionId = record.sessionId
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw invalidParams("sessionId must be a non-empty string.")
  }
  const after = record.after
  if (
    after !== undefined &&
    (typeof after !== "number" || !Number.isInteger(after) || after < 0)
  ) {
    throw invalidParams("after must be a non-negative integer.")
  }
  return { sessionId, ...(after === undefined ? {} : { after }) }
}

function parseSessionUnsubscribeParams(
  params: unknown,
): SessionUnsubscribeParams {
  const record = requireParamsRecord(params, "session/unsubscribe")
  const sessionId = record.sessionId
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw invalidParams("sessionId must be a non-empty string.")
  }
  return { sessionId }
}

function parseProjectAddParams(params: unknown): ProjectAddParams {
  const record = requireParamsRecord(params, "project/add")
  const path = record.path
  if (typeof path !== "string" || path.trim() === "") {
    throw invalidParams("path must be a non-empty string.")
  }
  return { path }
}

function requireParamsRecord(
  params: unknown,
  method: string,
): Record<string, unknown> {
  if (isRecord(params)) return params
  throw invalidParams(`${method} params must be an object.`)
}

function invalidParams(message: string): RpcMethodError {
  return new RpcMethodError(INVALID_PARAMS, message, {
    code: ApiErrorCode.InvalidInput,
  })
}

function unavailable(method: string): RpcMethodError {
  return new RpcMethodError(
    METHOD_NOT_FOUND,
    `${method} is not available on this server.`,
    { code: ApiErrorCode.NotFound },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sessionScope(params: unknown): RequestSerializationScope {
  // The scope key is derived before handler-side validation; malformed params
  // share an inert key and the handler rejects them with invalid_input.
  const sessionId =
    isRecord(params) && typeof params.sessionId === "string"
      ? params.sessionId
      : ""
  return { kind: "session", sessionId }
}

function handlerEntry<TResult>(
  method: string,
  scope: (params: unknown) => RequestSerializationScope | undefined,
  call: (
    handlers: ServerHandlers,
    params: unknown,
  ) => Promise<ApiHandlerResult<TResult>>,
): RpcMethodDefinition {
  return {
    method,
    scope,
    invoke: async (params, context) => ({
      result: adaptHandlerResult(await call(context.handlers, params)),
    }),
  }
}

export const rpcMethods: readonly RpcMethodDefinition[] = [
  handlerEntry<ApiListSessionsResponse>(
    "session/list",
    // Unserialized, mirroring Codex's thread/list.
    () => undefined,
    (handlers, params) => handlers.listSessions(params),
  ),
  handlerEntry<ApiCreateSessionResponse>(
    "session/create",
    // Unserialized, mirroring Codex's thread/start.
    () => undefined,
    (handlers, params) => handlers.createSession(params),
  ),
  handlerEntry<ApiReadSessionResponse>(
    "session/read",
    sessionScope,
    (handlers, params) => handlers.readSession(params),
  ),
  handlerEntry<ApiDeleteSessionResponse>(
    "session/delete",
    sessionScope,
    (handlers, params) => handlers.deleteSession(params),
  ),
  handlerEntry<ApiForkSessionResponse>(
    "session/fork",
    sessionScope,
    (handlers, params) => handlers.forkSession(params),
  ),
  handlerEntry<ApiCompactSessionResponse>(
    "session/compact",
    sessionScope,
    (handlers, params) => handlers.compactSession(params),
  ),
  handlerEntry<ApiAdmitInputResponse>(
    "session/input",
    sessionScope,
    (handlers, params) => handlers.admitInput(params),
  ),
  handlerEntry<ApiCancelInputResponse>(
    "session/input/cancel",
    sessionScope,
    (handlers, params) => handlers.cancelInput(params),
  ),
  handlerEntry<ApiCancelTurnResponse>(
    "session/turn/cancel",
    sessionScope,
    (handlers, params) => handlers.cancelTurn(params),
  ),
  {
    method: "session/subscribe",
    scope: sessionScope,
    async invoke(params, context) {
      const request = parseSessionSubscribeParams(params)
      const outcome = await context.subscriptions.subscribe({
        connectionId: context.connectionId,
        sessionId: request.sessionId,
        after: request.after ?? 0,
      })
      if (!outcome.ok) return { result: adaptHandlerResult(outcome.result) }
      return { result: outcome.response, afterResponse: outcome.replay }
    },
  },
  {
    method: "session/unsubscribe",
    scope: sessionScope,
    async invoke(params, context) {
      const request = parseSessionUnsubscribeParams(params)
      context.subscriptions.unsubscribe(context.connectionId, request.sessionId)
      return { result: {} }
    },
  },
  {
    method: "project/list",
    scope: () => ({ kind: "globalSharedRead", name: "projects" }),
    async invoke(_params, context) {
      if (context.projectRegistry === undefined) {
        throw unavailable("project/list")
      }
      const projects = await context.projectRegistry.list()
      return { result: { projects } satisfies ApiListProjectsResponse }
    },
  },
  {
    method: "project/add",
    scope: () => ({ kind: "global", name: "projects" }),
    async invoke(params, context) {
      if (context.projectRegistry === undefined) {
        throw unavailable("project/add")
      }
      const request = parseProjectAddParams(params)
      try {
        const projects = await context.projectRegistry.add(request.path)
        return { result: { projects } satisfies ApiAddProjectResponse }
      } catch (error) {
        // resolveWorkspaceDirectory rejects invalid paths with a plain Error;
        // anything else is an unexpected registry failure.
        if (error instanceof Error && !isYakitoriError(error)) {
          throw invalidParams(error.message)
        }
        throw error
      }
    },
  },
  {
    method: "provider/list",
    // The response embeds the user preference read from the config store, so
    // it shares the config queue key with userPreference/write (Codex keys
    // config reads and writes on one name).
    scope: () => ({ kind: "globalSharedRead", name: "config" }),
    async invoke(_params, context) {
      if (context.providers === undefined) throw unavailable("provider/list")
      return { result: await context.providers() }
    },
  },
  {
    method: "userPreference/write",
    scope: () => ({ kind: "global", name: "config" }),
    async invoke(params, context) {
      if (context.userConfig === undefined) {
        throw unavailable("userPreference/write")
      }
      const preference = requireUserModelPreference(
        params,
        context.availableProviders ?? [],
      )
      if (!preference.ok)
        return { result: adaptHandlerResult(preference.result) }
      const userPreference = await context.userConfig.write(preference.value)
      return {
        result: {
          userPreference,
        } satisfies ApiUpdateUserModelPreferenceResponse,
      }
    },
  },
]

// Typed wire contract of the table above, one entry per method. Params the
// table passes through unchanged reuse the protocol.ts request DTOs; the
// handlers own their validation.
export type RpcMethodParams = Readonly<{
  initialize: InitializeParams
  "session/list": SessionListParams
  "session/create": ApiCreateSessionRequest
  "session/read": ApiReadSessionRequest
  "session/delete": ApiReadSessionRequest
  "session/fork": ApiForkSessionRequest & Readonly<{ sessionId: string }>
  "session/compact": Readonly<{ sessionId: string; requestId?: string }>
  "session/input": ApiAdmitInputRequest
  "session/input/cancel": ApiCancelInputRequest
  "session/turn/cancel": ApiCancelTurnRequest
  "session/subscribe": SessionSubscribeParams
  "session/unsubscribe": SessionUnsubscribeParams
  "project/list": Readonly<Record<string, never>>
  "project/add": ProjectAddParams
  "provider/list": Readonly<Record<string, never>>
  "userPreference/write": ApiUserModelPreference
}>

export type RpcMethodResponses = Readonly<{
  initialize: InitializeResponse
  "session/list": ApiListSessionsResponse
  "session/create": ApiCreateSessionResponse
  "session/read": ApiReadSessionResponse
  "session/delete": ApiDeleteSessionResponse
  "session/fork": ApiForkSessionResponse
  "session/compact": ApiCompactSessionResponse
  "session/input": ApiAdmitInputResponse
  "session/input/cancel": ApiCancelInputResponse
  "session/turn/cancel": ApiCancelTurnResponse
  "session/subscribe": SessionSubscribeResponse
  "session/unsubscribe": Readonly<Record<string, never>>
  "project/list": ApiListProjectsResponse
  "project/add": ApiAddProjectResponse
  "provider/list": ApiListProvidersResponse
  "userPreference/write": ApiUpdateUserModelPreferenceResponse
}>
