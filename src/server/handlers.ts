import { realpath, stat } from "node:fs/promises"
import {
  COMPACT_DIRECTIVE,
  type EventEnvelope,
  type EventMetadata,
  ForkReason,
  IdPrefix,
  type InlineImageAttachment,
  InputRole,
  isIdWithPrefix,
  isJsonValue,
  isRequestId,
  isYakitoriError,
  type ModelSelection,
  PermissionBehavior,
  type PermissionDecisionReason,
  type SessionKernel,
  type SessionFiles,
  type SessionProjection,
  type SessionSummary,
  type TextContent,
  YakitoriErrorCode,
} from "../kernel/index.ts"
import { RuntimeLimits } from "../runtime/limits.ts"
import {
  type ApiAdmitInputResponse,
  type ApiCancelInputResponse,
  type ApiCancelTurnResponse,
  type ApiCompactSessionResponse,
  type ApiCreateSessionResponse,
  type ApiDeleteSessionResponse,
  ApiErrorCode,
  type ApiForkSessionResponse,
  type ApiHandlerResult,
  type ApiListSessionsResponse,
  type ApiReadSessionEventsResponse,
  type ApiReadSessionResponse,
  type ApiResolvePermissionResponse,
  type ApiSessionDetail,
  type ApiSessionSummary,
} from "./protocol.ts"

export type SessionCreateDefaults = {
  readonly workingDirectory: string
  readonly mateId: string
  readonly mateRevisionId: string
}

export type ServerHandlerOptions = {
  readonly eventHub?: {
    publish(events: readonly EventEnvelope[]): void
  }
  readonly sessionDefaults?: SessionCreateDefaults
  readonly wakeSession?: (sessionId: string) => void
  readonly onPermissionResolved?: (input: {
    readonly sessionId: string
    readonly turnId: string
    readonly permissionRequestId: string
  }) => void
  readonly interruptTurn?: (input: {
    readonly sessionId: string
    readonly turnId: string
    readonly reason?: string
  }) => Promise<void>
  readonly maxInputBytes?: number
  readonly availableProviders?: readonly string[]
  readonly sessionFiles?: SessionFiles
}

export type ServerHandlers = {
  createSession(
    input?: unknown,
  ): Promise<ApiHandlerResult<ApiCreateSessionResponse>>
  listSessions(
    input?: unknown,
  ): Promise<ApiHandlerResult<ApiListSessionsResponse>>
  readSession(input: unknown): Promise<ApiHandlerResult<ApiReadSessionResponse>>
  deleteSession(
    input: unknown,
  ): Promise<ApiHandlerResult<ApiDeleteSessionResponse>>
  forkSession(input: unknown): Promise<ApiHandlerResult<ApiForkSessionResponse>>
  admitInput(input: unknown): Promise<ApiHandlerResult<ApiAdmitInputResponse>>
  compactSession(
    input: unknown,
  ): Promise<ApiHandlerResult<ApiCompactSessionResponse>>
  cancelInput(input: unknown): Promise<ApiHandlerResult<ApiCancelInputResponse>>
  cancelTurn(input: unknown): Promise<ApiHandlerResult<ApiCancelTurnResponse>>
  resolvePermission(
    input: unknown,
  ): Promise<ApiHandlerResult<ApiResolvePermissionResponse>>
  readSessionEvents(
    input: unknown,
  ): Promise<ApiHandlerResult<ApiReadSessionEventsResponse>>
}

const sessionListOrder = "updated_at_desc"
const maxCancelReasonLength = 512
const maxImageAttachments = 4
const maxImageAttachmentBytes = 4 * 1024 * 1024
const maxImageAttachmentsBytes = 10 * 1024 * 1024

type AdmissionTextContent = {
  readonly kind: "text"
  readonly text: string
  readonly attachments?: readonly InlineImageAttachment[]
}

export function createServerHandlers(
  kernel: SessionKernel,
  options: ServerHandlerOptions = {},
): ServerHandlers {
  async function forkAfterSettlingActiveTurn(
    request: Parameters<SessionKernel["forkSession"]>[0],
  ) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const source = await kernel.readSession({ sessionId: request.sessionId })
      if (source.session?.activeTurn !== undefined && options.interruptTurn) {
        await options.interruptTurn({
          sessionId: request.sessionId,
          turnId: source.session.activeTurn.turnId,
          reason: "conversation_fork",
        })
      }
      try {
        return await kernel.forkSession(request)
      } catch (error) {
        if (
          options.interruptTurn === undefined ||
          !isYakitoriError(error) ||
          error.code !== YakitoriErrorCode.InvalidState ||
          error.details?.operation !== "fork_session" ||
          attempt === 3
        ) {
          throw error
        }
      }
    }
    throw new Error("Fork retry loop exited unexpectedly.")
  }

  return {
    async createSession(input = {}) {
      try {
        const created = await kernel.createSession(
          await applySessionCreateDefaults(
            requireCreateSessionRequest(input),
            options.sessionDefaults,
          ),
        )
        options.eventHub?.publish([created.event])
        const read = await kernel.readSession({ sessionId: created.sessionId })
        return ok(201, {
          session: mapRequiredSession(created.sessionId, read.session),
          event: created.event,
        })
      } catch (error) {
        return fail(error)
      }
    },

    async listSessions(input = {}) {
      try {
        const request = requireListSessionsRequest(input)
        const result = await kernel.listSessions({
          limit: request.limit,
          ...(request.workingDirectory === undefined
            ? {}
            : { workingDirectory: request.workingDirectory }),
          ...(request.cursor === undefined
            ? {}
            : {
                cursor: decodeSessionListCursor(
                  request.cursor,
                  request.limit,
                  request.workingDirectory,
                ),
              }),
        })

        return ok(200, {
          sessions: result.sessions.map(mapSessionSummary),
          ...(result.nextCursor === undefined
            ? {}
            : {
                nextCursor: encodeSessionListCursor(
                  result.nextCursor,
                  request.limit,
                  request.workingDirectory,
                ),
              }),
        })
      } catch (error) {
        return fail(error)
      }
    },

    async readSession(input) {
      try {
        const request = requireReadSessionRequest(input)
        const result = await kernel.readSession({
          sessionId: request.sessionId,
        })

        if (!result.session) {
          throw notFound(`Session ${request.sessionId} was not found.`, {
            sessionId: request.sessionId,
          })
        }

        return ok(200, {
          session: mapSessionDetail(result.session),
        })
      } catch (error) {
        return fail(error)
      }
    },

    async deleteSession(input) {
      try {
        const request = requireDeleteSessionRequest(input)
        await kernel.deleteSession({ sessionId: request.sessionId })
        return ok(200, { sessionId: request.sessionId })
      } catch (error) {
        return fail(error)
      }
    },

    async forkSession(input) {
      try {
        const request = requireForkSessionRequest(
          input,
          options.maxInputBytes ?? RuntimeLimits.modelVisibleContextBytes,
        )
        requireAvailableProvider(
          request.modelSelection?.provider,
          options.availableProviders,
        )
        const forked = await forkAfterSettlingActiveTurn(request)
        options.eventHub?.publish(forked.sourceEvents)
        if (request.content !== undefined) {
          options.wakeSession?.(forked.sessionId)
        }
        const read = await kernel.readSession({ sessionId: forked.sessionId })
        return ok(201, {
          session: mapRequiredSession(forked.sessionId, read.session),
          historyEndSeqExclusive: forked.historyEndSeqExclusive,
          events: forked.localEvents,
        })
      } catch (error) {
        return fail(error)
      }
    },

    async admitInput(input) {
      try {
        const request = requireAdmitInputRequest(
          input,
          options.maxInputBytes ?? RuntimeLimits.modelVisibleContextBytes,
        )
        requireAvailableProvider(
          request.modelSelection?.provider,
          options.availableProviders,
        )
        let content: TextContent = {
          kind: "text",
          text: request.content.text,
        }
        if (request.content.attachments !== undefined) {
          if (options.sessionFiles === undefined) {
            throw invalidInput(
              "Image attachments require Session file storage.",
            )
          }
          content = {
            ...content,
            attachments: await options.sessionFiles.persistImageAttachments(
              request.sessionId,
              request.requestId,
              request.content.attachments,
            ),
          }
        }
        const admitted = await kernel.admitInput({ ...request, content })
        if (admitted.created) options.eventHub?.publish([admitted.event])
        // Wake even on idempotent replay: original process may have crashed
        // after commit and before scheduling.
        options.wakeSession?.(request.sessionId)
        return ok(admitted.created ? 201 : 200, {
          requestId: admitted.requestId,
          inputId: admitted.inputId,
          event: admitted.event,
        })
      } catch (error) {
        return fail(error)
      }
    },

    async compactSession(input) {
      try {
        const request = requireCompactSessionRequest(input)
        const read = await kernel.readSession({ sessionId: request.sessionId })
        if (!read.session) {
          throw notFound(`Session ${request.sessionId} was not found.`, {
            sessionId: request.sessionId,
          })
        }
        const admitted = await kernel.admitInput({
          sessionId: request.sessionId,
          role: InputRole.Runtime,
          content: { kind: "text", text: COMPACT_DIRECTIVE },
          ...(request.requestId === undefined
            ? {}
            : { requestId: request.requestId }),
        })
        if (admitted.created) options.eventHub?.publish([admitted.event])
        options.wakeSession?.(request.sessionId)
        return ok(admitted.created ? 201 : 200, {
          requestId: admitted.requestId,
          inputId: admitted.inputId,
          event: admitted.event,
        })
      } catch (error) {
        return fail(error)
      }
    },

    async cancelInput(input) {
      try {
        const request = requireCancelInputRequest(input)
        const cancelled = await kernel.cancelInput(request)
        options.eventHub?.publish([cancelled.event])
        return ok(200, {
          sessionId: request.sessionId,
          inputId: request.inputId,
          event: cancelled.event,
        })
      } catch (error) {
        return fail(error)
      }
    },

    async cancelTurn(input) {
      try {
        const request = requireCancelTurnRequest(input)
        if (options.interruptTurn) {
          await options.interruptTurn(request)
        } else {
          const cancelled = await kernel.cancelTurn(request)
          options.eventHub?.publish(cancelled.events)
        }
        return ok(200, {
          sessionId: request.sessionId,
          turnId: request.turnId,
        })
      } catch (error) {
        return fail(error)
      }
    },

    async resolvePermission(input) {
      try {
        const request = requireResolvePermissionRequest(input)
        const resolved = await kernel.resolvePermission(request)
        options.eventHub?.publish([resolved.event])
        options.onPermissionResolved?.({
          sessionId: request.sessionId,
          turnId: request.turnId,
          permissionRequestId: request.permissionRequestId,
        })
        return ok(200, {
          sessionId: request.sessionId,
          turnId: request.turnId,
          permissionRequestId: request.permissionRequestId,
          event: resolved.event,
        })
      } catch (error) {
        return fail(error)
      }
    },

    async readSessionEvents(input) {
      try {
        const request = requireReadSessionEventsRequest(input)
        const result = await kernel.readSession({
          sessionId: request.sessionId,
        })

        if (!result.session) {
          throw notFound(`Session ${request.sessionId} was not found.`, {
            sessionId: request.sessionId,
          })
        }

        const read = await kernel.readEvents({
          sessionId: request.sessionId,
          ...(request.after === undefined ? {} : { after: request.after }),
          ...(request.through === undefined
            ? {}
            : { through: request.through }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
        })

        return ok(200, {
          events: read.events,
          ...(read.nextAfter === undefined
            ? {}
            : { nextAfter: read.nextAfter }),
        })
      } catch (error) {
        return fail(error)
      }
    },
  }
}

function mapSessionSummary(summary: SessionSummary): ApiSessionSummary {
  return {
    id: summary.sessionId,
    conversationId: summary.conversationId,
    seq: summary.seq,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    ...(summary.title === undefined ? {} : { title: summary.title }),
    ...(summary.workingDirectory === undefined
      ? {}
      : { workingDirectory: summary.workingDirectory }),
    ...(summary.mateId === undefined ? {} : { mateId: summary.mateId }),
    ...(summary.mateRevisionId === undefined
      ? {}
      : { mateRevisionId: summary.mateRevisionId }),
    ...(summary.parentSessionId === undefined
      ? {}
      : { parentSessionId: summary.parentSessionId }),
    ...(summary.forkedFromInputId === undefined
      ? {}
      : { forkedFromInputId: summary.forkedFromInputId }),
    ...(summary.forkReason === undefined
      ? {}
      : { forkReason: summary.forkReason }),
    ...(summary.metadata === undefined ? {} : { metadata: summary.metadata }),
  }
}

function mapSessionDetail(session: SessionProjection): ApiSessionDetail {
  return {
    id: session.id,
    conversationId: session.conversationId,
    seq: session.seq,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.workingDirectory === undefined
      ? {}
      : { workingDirectory: session.workingDirectory }),
    ...(session.mateId === undefined ? {} : { mateId: session.mateId }),
    ...(session.mateRevisionId === undefined
      ? {}
      : { mateRevisionId: session.mateRevisionId }),
    ...(session.parentSessionId === undefined
      ? {}
      : { parentSessionId: session.parentSessionId }),
    ...(session.forkedFromInputId === undefined
      ? {}
      : { forkedFromInputId: session.forkedFromInputId }),
    ...(session.forkReason === undefined
      ? {}
      : { forkReason: session.forkReason }),
    ...(session.metadata === undefined ? {} : { metadata: session.metadata }),
    ...(session.activeTurn === undefined
      ? {}
      : { activeTurnId: session.activeTurn.turnId }),
    counts: {
      inputs: session.inputs.length,
      pendingInputs: session.pendingInputs.length,
      turns: session.turns.length,
      items: session.items.length,
      permissions: session.permissions.length,
      tools: session.tools.length,
    },
  }
}

function mapRequiredSession(
  sessionId: string,
  session: SessionProjection | undefined,
): ApiSessionDetail {
  if (session) return mapSessionDetail(session)
  throw internalError(
    `Session ${sessionId} was created but could not be read.`,
    {
      sessionId,
    },
  )
}

function requireCreateSessionRequest(input: unknown) {
  const record = requireRecord(
    input,
    "Session create request must be an object.",
  )
  return {
    ...optionalStringField(record, "title"),
    ...optionalStringField(record, "workingDirectory"),
    ...optionalStringField(record, "mateId"),
    ...optionalStringField(record, "mateRevisionId"),
    ...optionalSessionIdField(record, "parentSessionId"),
    ...optionalMetadataField(record, "metadata"),
  }
}

async function applySessionCreateDefaults(
  request: {
    readonly title?: string
    readonly workingDirectory?: string
    readonly mateId?: string
    readonly mateRevisionId?: string
    readonly parentSessionId?: string
    readonly metadata?: EventMetadata
  },
  defaults: SessionCreateDefaults | undefined,
) {
  if (defaults === undefined) return request

  const workingDirectory = await resolveSessionWorkspace(
    request.workingDirectory,
    defaults.workingDirectory,
  )

  if (request.mateId !== undefined && request.mateId !== defaults.mateId) {
    throw invalidInput(
      "mateId cannot override the configured active Mate in the current single-Mate stage.",
      { field: "mateId" },
    )
  }

  if (
    request.mateRevisionId !== undefined &&
    request.mateRevisionId !== defaults.mateRevisionId
  ) {
    throw invalidInput(
      "mateRevisionId cannot override the configured active Mate revision in the current single-Mate stage.",
      { field: "mateRevisionId" },
    )
  }

  return {
    ...request,
    workingDirectory,
    mateId: defaults.mateId,
    mateRevisionId: defaults.mateRevisionId,
  }
}

async function resolveSessionWorkspace(
  requested: string | undefined,
  fallback: string,
): Promise<string> {
  if (requested === undefined) return fallback
  const resolved = await resolveOptionalWorkspace(requested)
  if (resolved === undefined) {
    throw invalidInput("workingDirectory must be an existing directory.", {
      field: "workingDirectory",
      requested,
    })
  }
  return resolved
}

async function resolveOptionalWorkspace(
  workspace: string,
): Promise<string | undefined> {
  try {
    const resolved = await realpath(workspace)
    return (await stat(resolved)).isDirectory() ? resolved : undefined
  } catch {
    return undefined
  }
}

function requireListSessionsRequest(input: unknown) {
  const record = requireRecord(input, "Session list request must be an object.")
  const limit = requireOptionalLimit(record.limit)
  const cursor = requireOptionalString(record.cursor, "cursor")
  const workingDirectory = requireOptionalString(
    record.workingDirectory,
    "workingDirectory",
  )

  return {
    limit,
    ...(cursor === undefined ? {} : { cursor }),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
  }
}

function requireReadSessionRequest(input: unknown) {
  const record = requireRecord(input, "Session read request must be an object.")
  return {
    sessionId: requireSessionId(record.sessionId, "sessionId"),
  }
}

function requireDeleteSessionRequest(input: unknown) {
  const record = requireRecord(
    input,
    "Session delete request must be an object.",
  )
  return {
    sessionId: requireSessionId(record.sessionId, "sessionId"),
  }
}

function requireForkSessionRequest(input: unknown, maxInputBytes: number) {
  const record = requireRecord(input, "Session fork request must be an object.")
  const reason = record.reason
  if (reason !== ForkReason.Undo && reason !== ForkReason.Edit) {
    throw invalidInput('reason must be "undo" or "edit".', { field: "reason" })
  }
  const content =
    record.content === undefined
      ? undefined
      : requireForkTextContent(record.content, maxInputBytes)
  const modelSelection = optionalModelSelectionField(record, "modelSelection")
  if (reason === ForkReason.Edit && content === undefined) {
    throw invalidInput("content is required when reason is edit.", {
      field: "content",
    })
  }
  if (reason === ForkReason.Undo && content !== undefined) {
    throw invalidInput("content is not allowed when reason is undo.", {
      field: "content",
    })
  }
  if (
    reason === ForkReason.Undo &&
    modelSelection.modelSelection !== undefined
  ) {
    throw invalidInput("modelSelection is not allowed when reason is undo.", {
      field: "modelSelection",
    })
  }
  return {
    sessionId: requireSessionId(record.sessionId, "sessionId"),
    atInputId: requireInputId(record.atInputId, "atInputId"),
    reason,
    ...(content === undefined ? {} : { content }),
    ...modelSelection,
  }
}

function requireAdmitInputRequest(input: unknown, maxInputBytes: number) {
  const record = requireRecord(
    input,
    "Input admission request must be an object.",
  )
  return {
    sessionId: requireSessionId(record.sessionId, "sessionId"),
    requestId: requireRequestId(record.requestId),
    content: requireAdmissionTextContent(record.content, maxInputBytes),
    ...optionalModelSelectionField(record, "modelSelection"),
    ...optionalInputRoleField(record, "role"),
    ...optionalStringField(record, "parentInputId"),
    ...optionalMetadataField(record, "metadata"),
  }
}

function optionalModelSelectionField(
  record: Record<string, unknown>,
  field: string,
): { readonly modelSelection?: ModelSelection } {
  const value = record[field]
  if (value === undefined) return {}
  if (!isRecord(value)) {
    throw invalidInput(`${field} must be an object.`, { field })
  }
  return {
    modelSelection: {
      provider: requireString(value.provider, `${field}.provider`),
      model: requireString(value.model, `${field}.model`),
      ...(value.effort === undefined
        ? {}
        : { effort: requireString(value.effort, `${field}.effort`) }),
      ...(value.speed === undefined
        ? {}
        : { speed: requireString(value.speed, `${field}.speed`) }),
    },
  }
}

function requireAvailableProvider(
  provider: string | undefined,
  availableProviders: readonly string[] | undefined,
): void {
  if (
    provider === undefined ||
    availableProviders === undefined ||
    availableProviders.includes(provider)
  ) {
    return
  }
  throw invalidInput(`Provider ${provider} is not configured.`, {
    field: "modelSelection.provider",
    provider,
    availableProviders,
  })
}

function requireCompactSessionRequest(input: unknown) {
  const record = requireRecord(
    input,
    "Session compact request must be an object.",
  )
  return {
    sessionId: requireSessionId(record.sessionId, "sessionId"),
    // Optional so older clients keep working; when present it gives the
    // admission the same idempotent-replay guarantee as regular inputs.
    ...(record.requestId === undefined
      ? {}
      : { requestId: requireRequestId(record.requestId) }),
  }
}

function requireCancelInputRequest(input: unknown) {
  const record = requireRecord(input, "Input cancel request must be an object.")
  return {
    sessionId: requireSessionId(record.sessionId, "sessionId"),
    inputId: requireInputId(record.inputId, "inputId"),
    ...optionalReasonField(record, "reason"),
  }
}

function requireCancelTurnRequest(input: unknown) {
  const record = requireRecord(input, "Turn cancel request must be an object.")
  return {
    sessionId: requireSessionId(record.sessionId, "sessionId"),
    turnId: requireString(record.turnId, "turnId"),
    ...optionalReasonField(record, "reason"),
  }
}

function requireResolvePermissionRequest(input: unknown) {
  const record = requireRecord(
    input,
    "Permission resolve request must be an object.",
  )
  const behavior = record.behavior
  if (
    behavior !== PermissionBehavior.Allow &&
    behavior !== PermissionBehavior.Deny
  ) {
    throw invalidInput('behavior must be "allow" or "deny".', {
      field: "behavior",
    })
  }
  return {
    sessionId: requireSessionId(record.sessionId, "sessionId"),
    turnId: requireString(record.turnId, "turnId"),
    permissionRequestId: requireString(
      record.permissionRequestId,
      "permissionRequestId",
    ),
    behavior,
    ...(record.reason === undefined
      ? {}
      : { reason: requireDecisionReason(record.reason) }),
  }
}

function requireDecisionReason(value: unknown): PermissionDecisionReason {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidInput("reason must be an object.")
  }
  const record = value as Record<string, unknown>
  if (typeof record.kind !== "string" || record.kind.trim().length === 0) {
    throw invalidInput("reason.kind must be a non-empty string.")
  }
  return {
    kind: record.kind,
    ...(typeof record.message === "string" ? { message: record.message } : {}),
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value
  throw invalidInput(`${field} must be a non-empty string.`, { field })
}

function requireRequestId(value: unknown): string {
  if (typeof value === "string" && isRequestId(value)) return value
  throw invalidInput(
    "requestId must be 1 to 128 letters, numbers, dots, underscores, colons, or hyphens.",
    { field: "requestId" },
  )
}

function requireReadSessionEventsRequest(input: unknown) {
  const record = requireRecord(
    input,
    "Session events request must be an object.",
  )
  return {
    sessionId: requireSessionId(record.sessionId, "sessionId"),
    after: requireOptionalSequence(record.after, "after"),
    through: requireOptionalSequence(record.through, "through"),
    limit: requireOptionalEventLimit(record.limit),
  }
}

function requireOptionalEventLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined
  const parsed = typeof value === "string" ? Number(value) : value
  if (
    Number.isInteger(parsed) &&
    (parsed as number) > 0 &&
    (parsed as number) <= 1_000
  ) {
    return parsed as number
  }
  throw invalidInput("limit must be an integer from 1 to 1000.", {
    field: "limit",
  })
}

function requireRecord(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (isRecord(value)) return value
  throw invalidInput(message)
}

function requireSessionId(value: unknown, field: string): string {
  if (
    typeof value === "string" &&
    isIdWithPrefix(value, IdPrefix.Session) &&
    isGeneratedSessionId(value)
  ) {
    return value
  }
  throw invalidInput(`${field} must be a session id.`, {
    field,
  })
}

function requireInputId(value: unknown, field: string): string {
  if (
    typeof value === "string" &&
    isIdWithPrefix(value, IdPrefix.Input) &&
    isGeneratedInputId(value)
  ) {
    return value
  }
  throw invalidInput(`${field} must be an input id.`, {
    field,
  })
}

function requireOptionalLimit(value: unknown): number {
  if (value === undefined) return 50
  if (Number.isInteger(value) && typeof value === "number" && value > 0) {
    if (value <= 100) return value
  }
  throw invalidInput("Session list limit must be an integer from 1 to 100.", {
    limit: isJsonValue(value) ? value : null,
  })
}

function requireOptionalSequence(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return Number(value)
  }
  throw invalidInput(`${field} must be a non-negative integer sequence.`, {
    [field]: isJsonValue(value) ? value : null,
  })
}

function requireForkTextContent(
  value: unknown,
  maxInputBytes: number,
): TextContent {
  if (isRecord(value) && value.attachments !== undefined) {
    throw invalidInput(
      "Fork content attachments are inherited and must not be provided.",
      { field: "content.attachments" },
    )
  }
  const content = requireAdmissionTextContent(value, maxInputBytes)
  return { kind: "text", text: content.text }
}

function requireAdmissionTextContent(
  value: unknown,
  maxInputBytes: number,
): AdmissionTextContent {
  if (!isRecord(value)) {
    throw invalidInput("content must be a text content object.")
  }
  if (value.kind === "text" && typeof value.text === "string") {
    if (Buffer.byteLength(value.text, "utf8") > maxInputBytes) {
      throw invalidInput(
        `content.text must not exceed ${maxInputBytes} bytes.`,
        {
          field: "content.text",
          maxBytes: maxInputBytes,
        },
      )
    }
    const attachments = requireImageAttachments(value.attachments)
    return {
      kind: "text",
      text: value.text,
      ...(attachments.length === 0 ? {} : { attachments }),
    }
  }
  throw invalidInput("content must include kind text and a string text value.")
}

function requireImageAttachments(
  value: unknown,
): readonly InlineImageAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maxImageAttachments) {
    throw invalidInput(
      `content.attachments must contain at most ${maxImageAttachments} images.`,
      { field: "content.attachments", maxItems: maxImageAttachments },
    )
  }

  const attachments = value.map((item, index) =>
    requireImageAttachment(item, index),
  )
  const totalBytes = attachments.reduce(
    (total, attachment) => total + attachment.sizeBytes,
    0,
  )
  if (totalBytes > maxImageAttachmentsBytes) {
    throw invalidInput(
      `content.attachments must not exceed ${maxImageAttachmentsBytes} decoded bytes in total.`,
      {
        field: "content.attachments",
        maxBytes: maxImageAttachmentsBytes,
      },
    )
  }
  return attachments
}

function requireImageAttachment(
  value: unknown,
  index: number,
): InlineImageAttachment {
  if (!isRecord(value)) {
    throw invalidInput(`content.attachments[${index}] must be an image object.`)
  }
  const name = requireString(value.name, `content.attachments[${index}].name`)
  if (Buffer.byteLength(name, "utf8") > 255) {
    throw invalidInput(`content.attachments[${index}].name is too long.`)
  }
  const mediaType = value.mediaType
  if (
    mediaType !== "image/gif" &&
    mediaType !== "image/jpeg" &&
    mediaType !== "image/png" &&
    mediaType !== "image/webp"
  ) {
    throw invalidInput(
      `content.attachments[${index}].mediaType is not a supported image type.`,
    )
  }
  if (
    typeof value.data !== "string" ||
    value.data.length === 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)
  ) {
    throw invalidInput(
      `content.attachments[${index}].data must be base64 image data.`,
    )
  }
  const decoded = Buffer.from(value.data, "base64")
  if (decoded.length === 0 || decoded.length > maxImageAttachmentBytes) {
    throw invalidInput(
      `content.attachments[${index}] must not exceed ${maxImageAttachmentBytes} decoded bytes.`,
    )
  }
  if (value.sizeBytes !== decoded.length) {
    throw invalidInput(
      `content.attachments[${index}].sizeBytes does not match its data.`,
    )
  }
  return { name, mediaType, data: value.data, sizeBytes: decoded.length }
}

function optionalStringField(
  record: Record<string, unknown>,
  field: string,
): Record<string, string> {
  const value = requireOptionalString(record[field], field)
  if (value === undefined) return {}
  return { [field]: value }
}

function optionalReasonField(
  record: Record<string, unknown>,
  field: string,
): Record<string, string> {
  const value = requireOptionalString(record[field], field)
  if (value === undefined) return {}
  if (value.length > maxCancelReasonLength) {
    throw invalidInput(
      `${field} must not exceed ${maxCancelReasonLength} characters.`,
      { field },
    )
  }
  return { [field]: value }
}

function requireOptionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string") return value
  throw invalidInput(`${field} must be a string.`, {
    field,
  })
}

function optionalSessionIdField(
  record: Record<string, unknown>,
  field: string,
): Record<string, string> {
  if (record[field] === undefined) return {}
  return { [field]: requireSessionId(record[field], field) }
}

function optionalInputRoleField(
  record: Record<string, unknown>,
  field: string,
): { readonly role?: InputRole } {
  if (record[field] === undefined) return {}
  if (isInputRole(record[field])) return { role: record[field] }
  throw invalidInput(`${field} must be a valid input role.`, {
    field,
  })
}

function optionalMetadataField(
  record: Record<string, unknown>,
  field: string,
): { readonly metadata?: EventMetadata } {
  if (record[field] === undefined) return {}
  if (isJsonObject(record[field])) return { metadata: record[field] }
  throw invalidInput(`${field} must be a JSON object.`, {
    field,
  })
}

function encodeSessionListCursor(
  anchor: string,
  limit: number,
  workingDirectory: string | undefined,
): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      resource: "sessions",
      order: sessionListOrder,
      limit,
      anchor,
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
    }),
    "utf8",
  ).toString("base64url")
}

function decodeSessionListCursor(
  cursor: string,
  limit: number,
  workingDirectory: string | undefined,
): string {
  const payload = parseCursorPayload(cursor)
  if (
    payload.version === 1 &&
    payload.resource === "sessions" &&
    payload.order === sessionListOrder &&
    payload.limit === limit &&
    payload.workingDirectory === workingDirectory &&
    typeof payload.anchor === "string"
  ) {
    return payload.anchor
  }

  throw invalidCursor("Session list cursor does not match this request.", {
    cursor,
  })
}

function parseCursorPayload(cursor: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    if (isRecord(parsed)) return parsed
  } catch {
    throw invalidCursor("Session list cursor is invalid.", {
      cursor,
    })
  }

  throw invalidCursor("Session list cursor is invalid.", {
    cursor,
  })
}

function ok<T>(status: number, body: T): ApiHandlerResult<T> {
  return {
    ok: true,
    status,
    body,
  }
}

function fail(error: unknown): ApiHandlerResult<never> {
  const mapped = mapError(error)
  return {
    ok: false,
    status: mapped.status,
    body: {
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details === undefined ? {} : { details: mapped.details }),
      },
    },
  }
}

function mapError(error: unknown): ApiBoundaryError {
  if (error instanceof ApiBoundaryError) return error
  if (!isYakitoriError(error)) {
    return internalError("Unexpected server error.")
  }

  if (error.code === YakitoriErrorCode.InvalidArgument) {
    return invalidInput(error.message, error.details)
  }
  if (error.code === YakitoriErrorCode.NotFound) {
    return notFound(error.message, error.details)
  }
  if (error.code === YakitoriErrorCode.InvalidState) {
    return conflict(error.message, error.details)
  }

  return internalError(error.message, error.details)
}

function invalidInput(
  message: string,
  details?: EventMetadata,
): ApiBoundaryError {
  return new ApiBoundaryError(ApiErrorCode.InvalidInput, 400, message, details)
}

function invalidCursor(
  message: string,
  details?: EventMetadata,
): ApiBoundaryError {
  return new ApiBoundaryError(ApiErrorCode.InvalidCursor, 400, message, details)
}

function notFound(message: string, details?: EventMetadata): ApiBoundaryError {
  return new ApiBoundaryError(ApiErrorCode.NotFound, 404, message, details)
}

function conflict(message: string, details?: EventMetadata): ApiBoundaryError {
  return new ApiBoundaryError(ApiErrorCode.Conflict, 409, message, details)
}

function internalError(
  message: string,
  details?: EventMetadata,
): ApiBoundaryError {
  return new ApiBoundaryError(ApiErrorCode.InternalError, 500, message, details)
}

class ApiBoundaryError extends Error {
  readonly code: ApiErrorCode
  readonly status: number
  readonly details?: EventMetadata

  constructor(
    code: ApiErrorCode,
    status: number,
    message: string,
    details?: EventMetadata,
  ) {
    super(message)
    this.name = "ApiBoundaryError"
    this.code = code
    this.status = status
    if (details !== undefined) this.details = details
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isGeneratedSessionId(value: string): boolean {
  return /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  )
}

function isGeneratedInputId(value: string): boolean {
  return /^input_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  )
}

function isInputRole(value: unknown): value is InputRole {
  return (
    value === InputRole.Runtime ||
    value === InputRole.System ||
    value === InputRole.User
  )
}

function isJsonObject(value: unknown): value is EventMetadata {
  if (!isRecord(value)) return false
  return Object.values(value).every(isJsonValue)
}
