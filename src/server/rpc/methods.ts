import { realpath } from "node:fs/promises"
import { basename, isAbsolute, normalize } from "node:path"
import {
  isYakitoriError,
  type StoredEventEnvelope,
  YakitoriErrorCode,
} from "../../kernel/index.ts"
import type { LiveSessionEvent } from "../../runtime/live-events.ts"
import type { ServerHandlers } from "../handlers.ts"
import { requireUserModelPreference } from "../http.ts"
import {
  type ApiAdmitInputRequest,
  type ApiAdmitInputResponse,
  type ApiCancelInputRequest,
  type ApiCancelInputResponse,
  type ApiCancelTurnRequest,
  type ApiCancelTurnResponse,
  type ApiCompactSessionResponse,
  type ApiCreateProjectResponse,
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
  type ApiReadProjectResponse,
  type ApiReadSessionRequest,
  type ApiReadSessionResponse,
  type ApiResolvePermissionRequest,
  type ApiUpdateProjectResponse,
  type ApiUpdateUserModelPreferenceResponse,
  type ApiUserModelPreference,
} from "../protocol.ts"
import {
  InvalidProjectCursorError,
  ProjectMoveOutcome,
  type ProjectStore,
} from "../sqlite-project-store.ts"
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
  projectId?: string
}>

export type SessionSubscribeParams = Readonly<{
  sessionId: string
  after?: number
}>

export type SessionSubscribeResponse = ApiReadSessionResponse

export type SessionUnsubscribeParams = Readonly<{ sessionId: string }>

export type ProjectListParams = Readonly<{
  cursor?: string
  limit?: number
}>

export type ProjectReadParams = Readonly<{ projectId: string }>

export type ProjectCreateParams = Readonly<{
  name?: string
  roots: readonly string[]
  idempotencyKey?: string
}>

export type ProjectUpdateParams = Readonly<{
  projectId: string
  name?: string
  metadata?: Readonly<Record<string, string>>
}>

export type ProjectMoveParams = Readonly<{
  projectId: string
  toPosition: number
}>

export type ProjectDeleteParams = Readonly<{ projectId: string }>

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

// Broadcast to every initialized connection when a Project changes; no-op
// updates suppress it, matching Codex's ProjectChangedNotification.
export const projectChangedMethod = "project/changed"

export type ProjectChangeType = "created" | "updated" | "deleted"

export type ProjectChangedNotification = Readonly<{
  projectId: string
  changeType: ProjectChangeType
}>

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
  projectStore: ProjectStore | undefined
  providers: (() => Promise<ApiListProvidersResponse>) | undefined
  userConfig: UserConfigStore | undefined
  availableProviders: readonly string[] | undefined
  // Emits a server→client notification to every initialized connection.
  broadcastNotification(method: string, params: unknown): void
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

function parseProjectListParams(params: unknown): ProjectListParams {
  // Missing params are an empty page request, matching session/list.
  const record = requireParamsRecord(params ?? {}, "project/list")
  const cursor = record.cursor
  if (cursor !== undefined && typeof cursor !== "string") {
    throw invalidParams("cursor must be a string.")
  }
  const limit = record.limit
  if (
    limit !== undefined &&
    (typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100)
  ) {
    throw invalidParams("limit must be an integer from 1 to 100.")
  }
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  }
}

function parseProjectIdParams(
  params: unknown,
  method: string,
): Readonly<{ projectId: string }> {
  const record = requireParamsRecord(params, method)
  const projectId = record.projectId
  if (typeof projectId !== "string" || projectId.trim() === "") {
    throw invalidParams("projectId must be a non-empty string.")
  }
  return { projectId }
}

function parseProjectCreateParams(params: unknown): ProjectCreateParams {
  const record = requireParamsRecord(params, "project/create")
  const roots = record.roots
  if (
    !Array.isArray(roots) ||
    roots.length === 0 ||
    !roots.every((root) => typeof root === "string" && root.trim() !== "")
  ) {
    throw invalidParams("roots must be a non-empty array of absolute paths.")
  }
  const name = record.name
  if (name !== undefined && typeof name !== "string") {
    throw invalidParams("name must be a string.")
  }
  const idempotencyKey = record.idempotencyKey
  if (idempotencyKey !== undefined && typeof idempotencyKey !== "string") {
    throw invalidParams("idempotencyKey must be a string.")
  }
  return {
    roots: roots as string[],
    ...(name === undefined ? {} : { name: name.trim() }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  }
}

function parseProjectUpdateParams(params: unknown): ProjectUpdateParams {
  const { projectId } = parseProjectIdParams(params, "project/update")
  const record = requireParamsRecord(params, "project/update")
  const name = record.name
  if (name !== undefined && (typeof name !== "string" || name.trim() === "")) {
    throw invalidParams("name must be a non-empty string.")
  }
  const metadata = record.metadata
  if (metadata !== undefined && !isStringRecord(metadata)) {
    throw invalidParams("metadata must be an object with string values.")
  }
  return {
    projectId,
    ...(name === undefined ? {} : { name: name.trim() }),
    ...(metadata === undefined ? {} : { metadata }),
  }
}

function parseProjectMoveParams(params: unknown): ProjectMoveParams {
  const { projectId } = parseProjectIdParams(params, "project/move")
  const record = requireParamsRecord(params, "project/move")
  const toPosition = record.toPosition
  if (
    typeof toPosition !== "number" ||
    !Number.isInteger(toPosition) ||
    toPosition < 0
  ) {
    throw invalidParams("toPosition must be a non-negative integer.")
  }
  return { projectId, toPosition }
}

function isStringRecord(
  value: unknown,
): value is Readonly<Record<string, string>> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  )
}

// Logical dedupe first, then a realpath pass: distinct paths that resolve to
// the same directory are rejected (Codex validate_roots). Roots that do not
// exist keep their logical path — canonicalization is best-effort.
async function canonicalizeProjectRoots(
  roots: readonly string[],
): Promise<string[]> {
  const logical = new Set<string>()
  const canonical = new Set<string>()
  const result: string[] = []
  for (const root of roots) {
    if (!isAbsolute(root)) {
      throw invalidParams(`Project root must be an absolute path: ${root}`)
    }
    const normalized = normalize(root)
    if (logical.has(normalized)) {
      throw invalidParams(`Duplicate project root: ${normalized}`)
    }
    logical.add(normalized)
    let resolved: string | undefined
    try {
      resolved = await realpath(normalized)
    } catch {
      resolved = undefined
    }
    if (resolved !== undefined) {
      if (canonical.has(resolved)) {
        throw invalidParams(`Duplicate resolved project root: ${normalized}`)
      }
      canonical.add(resolved)
    }
    result.push(normalized)
  }
  return result
}

function requireProjectStore(context: RpcMethodContext, method: string) {
  if (context.projectStore === undefined) throw unavailable(method)
  return context.projectStore
}

function projectNotFound(projectId: string): RpcMethodError {
  return new RpcMethodError(
    INTERNAL_ERROR,
    `Project ${projectId} was not found.`,
    { code: ApiErrorCode.NotFound, details: { projectId } },
  )
}

// Store failures map onto the same wire shape as adaptHandlerResult: input
// and cursor problems are INVALID_PARAMS, everything else keeps its
// ApiErrorCode in error.data under INTERNAL_ERROR.
function mapProjectStoreError(error: unknown): never {
  if (error instanceof InvalidProjectCursorError) {
    throw new RpcMethodError(INVALID_PARAMS, error.message, {
      code: ApiErrorCode.InvalidCursor,
    })
  }
  if (isYakitoriError(error)) {
    if (error.code === YakitoriErrorCode.InvalidArgument) {
      throw new RpcMethodError(INVALID_PARAMS, error.message, {
        code: ApiErrorCode.InvalidInput,
        ...(error.details === undefined ? {} : { details: error.details }),
      })
    }
    if (error.code === YakitoriErrorCode.InvalidState) {
      throw new RpcMethodError(INTERNAL_ERROR, error.message, {
        code: ApiErrorCode.Conflict,
        ...(error.details === undefined ? {} : { details: error.details }),
      })
    }
  }
  throw error
}

function notifyProjectChanged(
  context: RpcMethodContext,
  projectId: string,
  changeType: ProjectChangeType,
): () => Promise<void> {
  return async () => {
    context.broadcastNotification(projectChangedMethod, {
      projectId,
      changeType,
    } satisfies ProjectChangedNotification)
  }
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
    async invoke(params, context) {
      const store = requireProjectStore(context, "project/list")
      const request = parseProjectListParams(params)
      try {
        const page = await store.listProjects(request)
        return {
          result: {
            projects: page.projects,
            ...(page.nextCursor === undefined
              ? {}
              : { nextCursor: page.nextCursor }),
          } satisfies ApiListProjectsResponse,
        }
      } catch (error) {
        mapProjectStoreError(error)
      }
    },
  },
  {
    method: "project/read",
    scope: () => ({ kind: "globalSharedRead", name: "projects" }),
    async invoke(params, context) {
      const store = requireProjectStore(context, "project/read")
      const request = parseProjectIdParams(params, "project/read")
      try {
        const project = await store.readProject(request.projectId)
        if (project === undefined) throw projectNotFound(request.projectId)
        return { result: { project } satisfies ApiReadProjectResponse }
      } catch (error) {
        mapProjectStoreError(error)
      }
    },
  },
  {
    method: "project/create",
    scope: () => ({ kind: "global", name: "projects" }),
    async invoke(params, context) {
      const store = requireProjectStore(context, "project/create")
      const request = parseProjectCreateParams(params)
      const roots = await canonicalizeProjectRoots(request.roots)
      try {
        const created = await store.createProject({
          name: request.name ?? basename(roots[0] ?? ""),
          roots,
          ...(request.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: request.idempotencyKey }),
        })
        return {
          result: {
            project: created.project,
          } satisfies ApiCreateProjectResponse,
          ...(created.created
            ? {
                afterResponse: notifyProjectChanged(
                  context,
                  created.project.id,
                  "created",
                ),
              }
            : {}),
        }
      } catch (error) {
        mapProjectStoreError(error)
      }
    },
  },
  {
    method: "project/update",
    scope: () => ({ kind: "global", name: "projects" }),
    async invoke(params, context) {
      const store = requireProjectStore(context, "project/update")
      const request = parseProjectUpdateParams(params)
      try {
        const updated = await store.updateProject(request.projectId, {
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.metadata === undefined
            ? {}
            : { metadata: request.metadata }),
        })
        if (updated === undefined) throw projectNotFound(request.projectId)
        return {
          result: {
            project: updated.project,
          } satisfies ApiUpdateProjectResponse,
          // No-op updates suppress the notification, Codex-style.
          ...(updated.changed
            ? {
                afterResponse: notifyProjectChanged(
                  context,
                  request.projectId,
                  "updated",
                ),
              }
            : {}),
        }
      } catch (error) {
        mapProjectStoreError(error)
      }
    },
  },
  {
    method: "project/move",
    scope: () => ({ kind: "global", name: "projects" }),
    async invoke(params, context) {
      const store = requireProjectStore(context, "project/move")
      const request = parseProjectMoveParams(params)
      try {
        const outcome = await store.moveProject(
          request.projectId,
          request.toPosition,
        )
        if (outcome === undefined) throw projectNotFound(request.projectId)
        return {
          result: {},
          ...(outcome === ProjectMoveOutcome.Moved
            ? {
                afterResponse: notifyProjectChanged(
                  context,
                  request.projectId,
                  "updated",
                ),
              }
            : {}),
        }
      } catch (error) {
        mapProjectStoreError(error)
      }
    },
  },
  {
    method: "project/delete",
    scope: () => ({ kind: "global", name: "projects" }),
    async invoke(params, context) {
      const store = requireProjectStore(context, "project/delete")
      const request = parseProjectIdParams(params, "project/delete")
      try {
        if (!(await store.deleteProject(request.projectId))) {
          throw projectNotFound(request.projectId)
        }
        return {
          result: {},
          afterResponse: notifyProjectChanged(
            context,
            request.projectId,
            "deleted",
          ),
        }
      } catch (error) {
        mapProjectStoreError(error)
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
  "project/list": ProjectListParams
  "project/read": ProjectReadParams
  "project/create": ProjectCreateParams
  "project/update": ProjectUpdateParams
  "project/move": ProjectMoveParams
  "project/delete": ProjectDeleteParams
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
  "project/read": ApiReadProjectResponse
  "project/create": ApiCreateProjectResponse
  "project/update": ApiUpdateProjectResponse
  "project/move": Readonly<Record<string, never>>
  "project/delete": Readonly<Record<string, never>>
  "provider/list": ApiListProvidersResponse
  "userPreference/write": ApiUpdateUserModelPreferenceResponse
}>
