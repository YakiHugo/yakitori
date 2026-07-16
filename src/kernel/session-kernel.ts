import type { EventStore } from "./event-store.ts"
import { createYakitoriError, YakitoriErrorCode } from "./errors.ts"
import {
  EventType,
  InputRole,
  type EventEnvelope,
  type EventMetadata,
  type ItemContent,
  type ItemKind,
  ItemStatus,
  type JsonValue,
  type KernelError,
  type KernelEvent,
  PermissionBehavior,
  type PermissionDecisionReason,
  type TextContent,
} from "./events.ts"
import {
  createInputId,
  createItemId,
  createPermissionRequestId,
  createRequestId,
  createSessionId,
  createToolCallId,
  createTurnId,
  isRequestId,
} from "./ids.ts"
import { fingerprintOperation } from "./operation.ts"
import {
  InputState,
  PermissionState,
  projectSession,
  ToolState,
  TurnState,
  type InputProjection,
  type ItemProjection,
  type PermissionProjection,
  type SessionProjection,
  type ToolProjection,
  type TurnProjection,
} from "./session-projector.ts"

export type SessionKernel = {
  createSession(input?: CreateSessionInput): Promise<CreateSessionResult>
  updateSessionMetadata(
    input: UpdateSessionMetadataInput,
  ): Promise<UpdateSessionMetadataResult>
  listSessions(input?: ListSessionsInput): Promise<ListSessionsResult>
  readSession(input: ReadSessionInput): Promise<ReadSessionResult>
  replaySession(input: ReplaySessionInput): Promise<ReplaySessionResult>
  admitInput(input: AdmitInputInput): Promise<AdmitInputResult>
  cancelInput(input: CancelInputInput): Promise<CancelInputResult>
  startTurn(input: StartTurnInput): Promise<StartTurnResult>
  appendItem(input: AppendItemInput): Promise<AppendItemResult>
  updateItem(input: UpdateItemInput): Promise<UpdateItemResult>
  completeItem(input: CompleteItemInput): Promise<CompleteItemResult>
  requestPermission(
    input: RequestPermissionInput,
  ): Promise<RequestPermissionResult>
  resolvePermission(
    input: ResolvePermissionInput,
  ): Promise<ResolvePermissionResult>
  cancelPermission(
    input: CancelPermissionInput,
  ): Promise<CancelPermissionResult>
  requestTool(input: RequestToolInput): Promise<RequestToolResult>
  startTool(input: StartToolInput): Promise<StartToolResult>
  recordToolProgress(
    input: RecordToolProgressInput,
  ): Promise<RecordToolProgressResult>
  completeTool(input: CompleteToolInput): Promise<CompleteToolResult>
  failTool(input: FailToolInput): Promise<FailToolResult>
  cancelTool(input: CancelToolInput): Promise<CancelToolResult>
  completeTurn(input: CompleteTurnInput): Promise<CompleteTurnResult>
  failTurn(input: FailTurnInput): Promise<FailTurnResult>
  cancelTurn(input: CancelTurnInput): Promise<CancelTurnResult>
}

export type CreateSessionInput = {
  readonly title?: string
  readonly workingDirectory?: string
  readonly parentSessionId?: string
  readonly metadata?: EventMetadata
}

export type CreateSessionResult = {
  readonly sessionId: string
  readonly event: EventEnvelope
}

export type UpdateSessionMetadataInput = {
  readonly sessionId: string
  readonly title?: string
  readonly metadata?: EventMetadata
}

export type UpdateSessionMetadataResult = {
  readonly event: EventEnvelope
}

export type ListSessionsInput = {
  readonly limit?: number
  readonly cursor?: string
}

export type ListSessionsResult = {
  readonly sessions: readonly SessionSummary[]
  readonly nextCursor?: string
}

export type SessionSummary = {
  readonly sessionId: string
  readonly seq: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly title?: string
  readonly workingDirectory?: string
  readonly parentSessionId?: string
  readonly metadata?: EventMetadata
}

export type ReadSessionInput = {
  readonly sessionId: string
}

export type ReadSessionResult = {
  readonly session?: SessionProjection
}

export type ReplaySessionInput = {
  readonly sessionId: string
}

export type ReplaySessionResult = {
  readonly events: readonly EventEnvelope[]
  readonly session?: SessionProjection
}

export type AdmitInputInput = {
  readonly sessionId: string
  readonly requestId?: string
  readonly content: TextContent
  readonly role?: InputRole
  readonly parentInputId?: string
  readonly metadata?: EventMetadata
}

export type AdmitInputResult = {
  readonly requestId: string
  readonly inputId: string
  readonly event: EventEnvelope
  readonly created: boolean
}

export type CancelInputInput = {
  readonly sessionId: string
  readonly inputId: string
  readonly reason?: string
}

export type CancelInputResult = {
  readonly event: EventEnvelope
}

export type StartTurnInput = {
  readonly sessionId: string
  readonly inputId: string
  readonly parentTurnId?: string
  readonly metadata?: EventMetadata
}

export type StartTurnResult = {
  readonly turnId: string
  readonly events: readonly EventEnvelope[]
}

export type AppendItemInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly kind: ItemKind
  readonly content: ItemContent
  readonly parentItemId?: string
  readonly status?: ItemStatus
  readonly providerMetadata?: EventMetadata
}

export type AppendItemResult = {
  readonly itemId: string
  readonly event: EventEnvelope
}

export type UpdateItemInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly itemId: string
  readonly content?: ItemContent
  readonly metadata?: EventMetadata
}

export type UpdateItemResult = {
  readonly event: EventEnvelope
}

export type CompleteItemInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly itemId: string
  readonly status?: typeof ItemStatus.Completed | typeof ItemStatus.Failed
  readonly metadata?: EventMetadata
}

export type CompleteItemResult = {
  readonly event: EventEnvelope
}

export type RequestPermissionInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly action: string
  readonly subject?: string
  readonly toolCallId?: string
  readonly reason?: string
  readonly metadata?: EventMetadata
}

export type RequestPermissionResult = {
  readonly permissionRequestId: string
  readonly event: EventEnvelope
}

export type ResolvePermissionInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly permissionRequestId: string
  readonly behavior: PermissionBehavior
  readonly reason?: PermissionDecisionReason
  readonly metadata?: EventMetadata
}

export type ResolvePermissionResult = {
  readonly event: EventEnvelope
}

export type CancelPermissionInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly permissionRequestId: string
  readonly reason?: string
}

export type CancelPermissionResult = {
  readonly event: EventEnvelope
}

export type RequestToolInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly name: string
  readonly input: JsonValue
  readonly itemId?: string
  readonly permissionRequestId?: string
  readonly providerMetadata?: EventMetadata
}

export type RequestToolResult = {
  readonly toolCallId: string
  readonly event: EventEnvelope
}

export type StartToolInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly toolCallId: string
}

export type StartToolResult = {
  readonly event: EventEnvelope
}

export type RecordToolProgressInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly toolCallId: string
  readonly message?: string
  readonly data?: JsonValue
}

export type RecordToolProgressResult = {
  readonly event: EventEnvelope
}

export type CompleteToolInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly toolCallId: string
  readonly output: JsonValue
  readonly itemId?: string
  readonly metadata?: EventMetadata
}

export type CompleteToolResult = {
  readonly event: EventEnvelope
}

export type FailToolInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly toolCallId: string
  readonly error: KernelError
}

export type FailToolResult = {
  readonly event: EventEnvelope
}

export type CancelToolInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly toolCallId: string
  readonly reason?: string
}

export type CancelToolResult = {
  readonly event: EventEnvelope
}

export type CompleteTurnInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly outputItemId?: string
  readonly metadata?: EventMetadata
}

export type CompleteTurnResult = {
  readonly event: EventEnvelope
}

export type FailTurnInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly error: KernelError
}

export type FailTurnResult = {
  readonly event: EventEnvelope
  readonly events: readonly EventEnvelope[]
}

export type CancelTurnInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly reason?: string
}

export type CancelTurnResult = {
  readonly event: EventEnvelope
  readonly events: readonly EventEnvelope[]
}

export function createSessionKernel(eventStore: EventStore): SessionKernel {
  const commandQueues = new Map<string, Promise<void>>()

  return {
    async createSession(input = {}) {
      const sessionId = createSessionId()
      const event = await eventStore.appendEvent(
        sessionId,
        {
          type: EventType.SessionCreated,
          data: {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.workingDirectory === undefined
              ? {}
              : { workingDirectory: input.workingDirectory }),
            ...(input.parentSessionId === undefined
              ? {}
              : { parentSessionId: input.parentSessionId }),
            ...(input.metadata === undefined
              ? {}
              : { metadata: input.metadata }),
          },
        },
        { expectedSeq: 0 },
      )

      return { sessionId, event }
    },

    async updateSessionMetadata(input) {
      return serializeSessionCommand(
        commandQueues,
        input.sessionId,
        async () => {
          const session = await readSessionProjection(
            eventStore,
            input.sessionId,
          )
          requireSessionMetadataUpdate(input)

          return {
            event: await appendSessionEvent(eventStore, session, {
              type: EventType.SessionMetadataUpdated,
              data: {
                ...(input.title === undefined ? {} : { title: input.title }),
                ...(input.metadata === undefined
                  ? {}
                  : { metadata: input.metadata }),
              },
            }),
          }
        },
      )
    },

    async listSessions(input = {}) {
      const result = await eventStore.listSessions(input)
      return {
        sessions: result.sessions.map((session) => ({ ...session })),
        ...(result.nextCursor === undefined
          ? {}
          : { nextCursor: result.nextCursor }),
      }
    },

    async readSession(input) {
      const session = await readOptionalSessionProjection(
        eventStore,
        input.sessionId,
      )
      if (session) return { session }
      return {}
    },

    async replaySession(input) {
      const events = await eventStore.readEvents(input.sessionId)
      const session = projectSession(events)
      if (session) return { events, session }
      return { events }
    },

    async admitInput(input) {
      return serializeSessionCommand(
        commandQueues,
        input.sessionId,
        async () => {
          const session = await readSessionProjection(
            eventStore,
            input.sessionId,
          )
          if (input.parentInputId !== undefined) {
            requireInput(session, input.parentInputId)
          }

          const requestId = input.requestId ?? createRequestId()
          requireRequestId(requestId)
          const role = input.role ?? InputRole.User
          const inputId = createInputId()
          const event = await eventStore.appendEvent(
            input.sessionId,
            {
              type: EventType.InputAdmitted,
              data: {
                requestId,
                inputId,
                role,
                content: input.content,
                ...(input.parentInputId === undefined
                  ? {}
                  : { parentInputId: input.parentInputId }),
                ...(input.metadata === undefined
                  ? {}
                  : { metadata: input.metadata }),
              },
            },
            {
              expectedSeq: session.seq,
              operation: {
                id: `input.admit:${requestId}`,
                fingerprint: fingerprintOperation({
                  role,
                  content: input.content,
                  parentInputId: input.parentInputId ?? null,
                  metadata: input.metadata ?? null,
                }),
              },
            },
          )
          if (event.type !== EventType.InputAdmitted) {
            throw createYakitoriError({
              code: YakitoriErrorCode.InvalidState,
              message: `Input admission ${requestId} resolved to an invalid event.`,
              details: { requestId, eventId: event.id, type: event.type },
            })
          }

          return {
            requestId,
            inputId: event.data.inputId,
            event,
            created: event.data.inputId === inputId,
          }
        },
      )
    },

    async cancelInput(input) {
      return serializeSessionCommand(
        commandQueues,
        input.sessionId,
        async () => {
          const session = await readSessionProjection(
            eventStore,
            input.sessionId,
          )
          requirePendingInput(requireInput(session, input.inputId))

          return {
            event: await appendSessionEvent(eventStore, session, {
              type: EventType.InputCancelled,
              data: {
                inputId: input.inputId,
                ...(input.reason === undefined ? {} : { reason: input.reason }),
              },
            }),
          }
        },
      )
    },

    async startTurn(input) {
      return serializeSessionCommand(
        commandQueues,
        input.sessionId,
        async () => {
          const session = await readSessionProjection(
            eventStore,
            input.sessionId,
          )
          requireInputReadyForTurn(requireInput(session, input.inputId))
          if (input.parentTurnId !== undefined) {
            requireTurnStarted(session, input.parentTurnId)
          }
          requireNoActiveTurn(session)

          const turnId = createTurnId()
          return {
            turnId,
            events: await appendSessionEvents(eventStore, session, [
              {
                type: EventType.InputPromoted,
                data: {
                  inputId: input.inputId,
                  turnId,
                },
              },
              {
                type: EventType.TurnStarted,
                data: {
                  turnId,
                  inputId: input.inputId,
                  ...(input.parentTurnId === undefined
                    ? {}
                    : { parentTurnId: input.parentTurnId }),
                  ...(input.metadata === undefined
                    ? {}
                    : { metadata: input.metadata }),
                },
              },
            ]),
          }
        },
      )
    },

    async appendItem(input) {
      return serializeSessionCommand(
        commandQueues,
        input.sessionId,
        async () => {
          const session = await readSessionProjection(
            eventStore,
            input.sessionId,
          )
          requireActiveTurn(session, input.turnId)
          if (input.parentItemId !== undefined) {
            requireItem(session, input.turnId, input.parentItemId)
          }

          const itemId = createItemId()
          const event = await appendSessionEvent(eventStore, session, {
            type: EventType.ItemAppended,
            data: {
              itemId,
              turnId: input.turnId,
              kind: input.kind,
              content: input.content,
              ...(input.parentItemId === undefined
                ? {}
                : { parentItemId: input.parentItemId }),
              ...(input.status === undefined ? {} : { status: input.status }),
              ...(input.providerMetadata === undefined
                ? {}
                : { providerMetadata: input.providerMetadata }),
            },
          })

          return { itemId, event }
        },
      )
    },

    async updateItem(input) {
      return serializeSessionCommand(
        commandQueues,
        input.sessionId,
        async () => {
          const session = await readSessionProjection(
            eventStore,
            input.sessionId,
          )
          requireActiveTurn(session, input.turnId)
          requireOpenItem(session, input.turnId, input.itemId)
          requireItemUpdate(input)

          return {
            event: await appendSessionEvent(eventStore, session, {
              type: EventType.ItemUpdated,
              data: {
                itemId: input.itemId,
                turnId: input.turnId,
                ...(input.content === undefined
                  ? {}
                  : { content: input.content }),
                ...(input.metadata === undefined
                  ? {}
                  : { metadata: input.metadata }),
              },
            }),
          }
        },
      )
    },

    async completeItem(input) {
      return serializeSessionCommand(
        commandQueues,
        input.sessionId,
        async () => {
          const session = await readSessionProjection(
            eventStore,
            input.sessionId,
          )
          requireActiveTurn(session, input.turnId)
          requireOpenItem(session, input.turnId, input.itemId)

          return {
            event: await appendSessionEvent(eventStore, session, {
              type: EventType.ItemCompleted,
              data: {
                itemId: input.itemId,
                turnId: input.turnId,
                status: input.status ?? ItemStatus.Completed,
                ...(input.metadata === undefined
                  ? {}
                  : { metadata: input.metadata }),
              },
            }),
          }
        },
      )
    },

    async requestPermission(input) {
      return serializeSessionCommand(
        commandQueues,
        input.sessionId,
        async () => {
          const session = await readSessionProjection(
            eventStore,
            input.sessionId,
          )
          requireActiveTurn(session, input.turnId)
          if (input.toolCallId !== undefined) {
            requireRequestedTool(session, input.turnId, input.toolCallId)
          }

          const permissionRequestId = createPermissionRequestId()
          const event = await appendSessionEvent(eventStore, session, {
            type: EventType.PermissionRequested,
            data: {
              permissionRequestId,
              turnId: input.turnId,
              action: input.action,
              ...(input.subject === undefined
                ? {}
                : { subject: input.subject }),
              ...(input.toolCallId === undefined
                ? {}
                : { toolCallId: input.toolCallId }),
              ...(input.reason === undefined ? {} : { reason: input.reason }),
              ...(input.metadata === undefined
                ? {}
                : { metadata: input.metadata }),
            },
          })

          return { permissionRequestId, event }
        },
      )
    },

    async resolvePermission(input) {
      return serializeSessionCommand(
        commandQueues,
        input.sessionId,
        async () => {
          const session = await readSessionProjection(
            eventStore,
            input.sessionId,
          )
          requireActiveTurn(session, input.turnId)
          requirePendingPermission(
            session,
            input.turnId,
            input.permissionRequestId,
          )

          return {
            event: await appendSessionEvent(eventStore, session, {
              type: EventType.PermissionResolved,
              data: {
                permissionRequestId: input.permissionRequestId,
                turnId: input.turnId,
                behavior: input.behavior,
                ...(input.reason === undefined ? {} : { reason: input.reason }),
                ...(input.metadata === undefined
                  ? {}
                  : { metadata: input.metadata }),
              },
            }),
          }
        },
      )
    },

    async cancelPermission(input) {
      return serializeSessionCommand(
        commandQueues,
        input.sessionId,
        async () => {
          const session = await readSessionProjection(
            eventStore,
            input.sessionId,
          )
          requireActiveTurn(session, input.turnId)
          requirePendingPermission(
            session,
            input.turnId,
            input.permissionRequestId,
          )

          return {
            event: await appendSessionEvent(eventStore, session, {
              type: EventType.PermissionCancelled,
              data: {
                permissionRequestId: input.permissionRequestId,
                turnId: input.turnId,
                ...(input.reason === undefined ? {} : { reason: input.reason }),
              },
            }),
          }
        },
      )
    },

    async requestTool(input) {
      return serializeSessionCommand(
        commandQueues,
        input.sessionId,
        async () => {
          const session = await readSessionProjection(
            eventStore,
            input.sessionId,
          )
          requireActiveTurn(session, input.turnId)
          if (input.itemId !== undefined) {
            requireItem(session, input.turnId, input.itemId)
          }
          if (input.permissionRequestId !== undefined) {
            requireUnboundPermission(
              session,
              input.turnId,
              input.permissionRequestId,
            )
          }

          const toolCallId = createToolCallId()
          const event = await appendSessionEvent(eventStore, session, {
            type: EventType.ToolRequested,
            data: {
              toolCallId,
              turnId: input.turnId,
              name: input.name,
              input: input.input,
              ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
              ...(input.permissionRequestId === undefined
                ? {}
                : { permissionRequestId: input.permissionRequestId }),
              ...(input.providerMetadata === undefined
                ? {}
                : { providerMetadata: input.providerMetadata }),
            },
          })

          return { toolCallId, event }
        },
      )
    },

    async startTool(input) {
      return serializeSessionCommand(
        commandQueues,
        input.sessionId,
        async () => {
          const session = await readSessionProjection(
            eventStore,
            input.sessionId,
          )
          requireActiveTurn(session, input.turnId)
          const tool = requireRequestedTool(
            session,
            input.turnId,
            input.toolCallId,
          )
          requireAllowedToolPermissions(session, input.turnId, tool)

          return {
            event: await appendSessionEvent(eventStore, session, {
              type: EventType.ToolStarted,
              data: {
                toolCallId: input.toolCallId,
                turnId: input.turnId,
              },
            }),
          }
        },
      )
    },

    async recordToolProgress(input) {
      return serializeSessionCommand(
        commandQueues,
        input.sessionId,
        async () => {
          const session = await readSessionProjection(
            eventStore,
            input.sessionId,
          )
          requireActiveTurn(session, input.turnId)
          requireStartedTool(session, input.turnId, input.toolCallId)
          requireToolProgress(input)

          return {
            event: await appendSessionEvent(eventStore, session, {
              type: EventType.ToolProgress,
              data: {
                toolCallId: input.toolCallId,
                turnId: input.turnId,
                ...(input.message === undefined
                  ? {}
                  : { message: input.message }),
                ...(input.data === undefined ? {} : { data: input.data }),
              },
            }),
          }
        },
      )
    },

    async completeTool(input) {
      return serializeSessionCommand(
        commandQueues,
        input.sessionId,
        async () => {
          const session = await readSessionProjection(
            eventStore,
            input.sessionId,
          )
          requireActiveTurn(session, input.turnId)
          requireStartedTool(session, input.turnId, input.toolCallId)
          if (input.itemId !== undefined) {
            requireItem(session, input.turnId, input.itemId)
          }

          return {
            event: await appendSessionEvent(eventStore, session, {
              type: EventType.ToolCompleted,
              data: {
                toolCallId: input.toolCallId,
                turnId: input.turnId,
                output: input.output,
                ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
                ...(input.metadata === undefined
                  ? {}
                  : { metadata: input.metadata }),
              },
            }),
          }
        },
      )
    },

    async failTool(input) {
      return serializeSessionCommand(
        commandQueues,
        input.sessionId,
        async () => {
          const session = await readSessionProjection(
            eventStore,
            input.sessionId,
          )
          requireActiveTurn(session, input.turnId)
          requireStartedTool(session, input.turnId, input.toolCallId)

          return {
            event: await appendSessionEvent(eventStore, session, {
              type: EventType.ToolFailed,
              data: {
                toolCallId: input.toolCallId,
                turnId: input.turnId,
                error: input.error,
              },
            }),
          }
        },
      )
    },

    async cancelTool(input) {
      return serializeSessionCommand(
        commandQueues,
        input.sessionId,
        async () => {
          const session = await readSessionProjection(
            eventStore,
            input.sessionId,
          )
          requireActiveTurn(session, input.turnId)
          requireOpenTool(session, input.turnId, input.toolCallId)

          return {
            event: await appendSessionEvent(eventStore, session, {
              type: EventType.ToolCancelled,
              data: {
                toolCallId: input.toolCallId,
                turnId: input.turnId,
                ...(input.reason === undefined ? {} : { reason: input.reason }),
              },
            }),
          }
        },
      )
    },

    async completeTurn(input) {
      return serializeSessionCommand(
        commandQueues,
        input.sessionId,
        async () => {
          const session = await readSessionProjection(
            eventStore,
            input.sessionId,
          )
          requireActiveTurn(session, input.turnId)
          if (input.outputItemId !== undefined) {
            requireCompletedItem(session, input.turnId, input.outputItemId)
          }
          requireNoOpenTurnWork(session, input.turnId)

          return {
            event: await appendSessionEvent(eventStore, session, {
              type: EventType.TurnCompleted,
              data: {
                turnId: input.turnId,
                ...(input.outputItemId === undefined
                  ? {}
                  : { outputItemId: input.outputItemId }),
                ...(input.metadata === undefined
                  ? {}
                  : { metadata: input.metadata }),
              },
            }),
          }
        },
      )
    },

    async failTurn(input) {
      return serializeSessionCommand(
        commandQueues,
        input.sessionId,
        async () => {
          const session = await readSessionProjection(
            eventStore,
            input.sessionId,
          )
          requireActiveTurn(session, input.turnId)
          const events = await appendSessionEvents(eventStore, session, [
            ...openTurnWorkClosureEvents(
              session,
              input.turnId,
              input.error.message,
            ),
            {
              type: EventType.TurnFailed,
              data: {
                turnId: input.turnId,
                error: input.error,
              },
            },
          ])

          return {
            event: requireLastEvent(events),
            events,
          }
        },
      )
    },

    async cancelTurn(input) {
      return serializeSessionCommand(
        commandQueues,
        input.sessionId,
        async () => {
          const session = await readSessionProjection(
            eventStore,
            input.sessionId,
          )
          requireActiveTurn(session, input.turnId)
          const events = await appendSessionEvents(eventStore, session, [
            ...openTurnWorkClosureEvents(session, input.turnId, input.reason),
            {
              type: EventType.TurnCancelled,
              data: {
                turnId: input.turnId,
                ...(input.reason === undefined ? {} : { reason: input.reason }),
              },
            },
          ])

          return {
            event: requireLastEvent(events),
            events,
          }
        },
      )
    },
  }
}

function appendSessionEvent(
  eventStore: EventStore,
  session: SessionProjection,
  event: KernelEvent,
): Promise<EventEnvelope> {
  return eventStore.appendEvent(session.id, event, {
    expectedSeq: session.seq,
  })
}

function appendSessionEvents(
  eventStore: EventStore,
  session: SessionProjection,
  events: readonly KernelEvent[],
): Promise<EventEnvelope[]> {
  return eventStore.appendEvents(session.id, events, {
    expectedSeq: session.seq,
  })
}

function serializeSessionCommand<T>(
  commandQueues: Map<string, Promise<void>>,
  sessionId: string,
  command: () => Promise<T>,
): Promise<T> {
  const previous = commandQueues.get(sessionId) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(command)
  const next = current.then(
    () => undefined,
    () => undefined,
  )

  commandQueues.set(sessionId, next)
  void next.then(() => {
    if (commandQueues.get(sessionId) === next) commandQueues.delete(sessionId)
  })

  return current
}

function requireRequestId(requestId: string): void {
  if (isRequestId(requestId)) return
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidArgument,
    message:
      "Request id must be 1 to 128 letters, numbers, dots, underscores, colons, or hyphens.",
    details: { requestId },
  })
}

async function readSessionProjection(
  eventStore: EventStore,
  sessionId: string,
): Promise<SessionProjection> {
  const session = await readOptionalSessionProjection(eventStore, sessionId)
  if (session) return session
  throw notFound(`Session ${sessionId} has not been created.`, {
    sessionId,
  })
}

async function readOptionalSessionProjection(
  eventStore: EventStore,
  sessionId: string,
): Promise<SessionProjection | undefined> {
  return projectSession(await eventStore.readEvents(sessionId))
}

function requireSessionMetadataUpdate(input: UpdateSessionMetadataInput): void {
  if (input.title !== undefined || input.metadata !== undefined) return
  throw invalidArgument(`Session ${input.sessionId} update has no changes.`, {
    sessionId: input.sessionId,
  })
}

function requirePendingInput(input: InputProjection): void {
  if (input.state === InputState.Admitted) return
  throw invalidState(`Input ${input.inputId} is already ${input.state}.`, {
    inputId: input.inputId,
    state: input.state,
  })
}

function requireInputReadyForTurn(input: InputProjection): void {
  if (input.state === InputState.Cancelled) {
    throw invalidState(`Input ${input.inputId} has been cancelled.`, {
      inputId: input.inputId,
      state: input.state,
    })
  }
  if (input.state === InputState.Promoted) {
    throw invalidState(`Input ${input.inputId} has already been promoted.`, {
      inputId: input.inputId,
      state: input.state,
    })
  }
}

function requireInput(
  session: SessionProjection,
  inputId: string,
): InputProjection {
  const input = session.inputs.find(
    (candidate) => candidate.inputId === inputId,
  )
  if (input) return input
  throw notFound(`Input ${inputId} has not been admitted.`, {
    inputId,
  })
}

function requireTurnStarted(
  session: SessionProjection,
  turnId: string,
): TurnProjection {
  const turn = session.turns.find((candidate) => candidate.turnId === turnId)
  if (turn) return turn

  throw notFound(`Turn ${turnId} has not been started.`, {
    turnId,
  })
}

function requireItem(
  session: SessionProjection,
  turnId: string,
  itemId: string,
): ItemProjection {
  const item = session.items.find((candidate) => candidate.itemId === itemId)
  if (!item) {
    throw notFound(`Item ${itemId} has not been appended.`, {
      itemId,
    })
  }
  if (item.turnId === turnId) return item
  throw invalidArgument(`Item ${itemId} does not belong to turn ${turnId}.`, {
    itemId,
    turnId,
    actualTurnId: item.turnId,
  })
}

function requireOpenItem(
  session: SessionProjection,
  turnId: string,
  itemId: string,
): ItemProjection {
  const item = requireItem(session, turnId, itemId)
  if (item.status === ItemStatus.InProgress) return item
  throw invalidState(`Item ${itemId} is already ${item.status}.`, {
    itemId,
    status: item.status,
  })
}

function requireCompletedItem(
  session: SessionProjection,
  turnId: string,
  itemId: string,
): ItemProjection {
  const item = requireItem(session, turnId, itemId)
  if (item.status === ItemStatus.Completed) return item
  throw invalidState(`Item ${itemId} is ${item.status}.`, {
    itemId,
    status: item.status,
  })
}

function requireItemUpdate(input: UpdateItemInput): void {
  if (input.content !== undefined || input.metadata !== undefined) return
  throw invalidArgument(`Item ${input.itemId} update has no changes.`, {
    itemId: input.itemId,
  })
}

function requirePermission(
  session: SessionProjection,
  turnId: string,
  permissionRequestId: string,
): PermissionProjection {
  const permission = session.permissions.find(
    (candidate) => candidate.permissionRequestId === permissionRequestId,
  )
  if (!permission) {
    throw notFound(
      `Permission ${permissionRequestId} has not been requested.`,
      {
        permissionRequestId,
      },
    )
  }
  if (permission.turnId === turnId) return permission
  throw invalidArgument(
    `Permission ${permissionRequestId} does not belong to turn ${turnId}.`,
    {
      permissionRequestId,
      turnId,
      actualTurnId: permission.turnId,
    },
  )
}

function requireUnboundPermission(
  session: SessionProjection,
  turnId: string,
  permissionRequestId: string,
): PermissionProjection {
  const permission = requirePermission(session, turnId, permissionRequestId)
  if (permission.toolCallId === undefined) return permission
  throw invalidState(
    `Permission ${permissionRequestId} is already bound to tool ${permission.toolCallId}.`,
    {
      permissionRequestId,
      toolCallId: permission.toolCallId,
    },
  )
}

function requirePendingPermission(
  session: SessionProjection,
  turnId: string,
  permissionRequestId: string,
): PermissionProjection {
  const permission = requirePermission(session, turnId, permissionRequestId)
  if (permission.state === PermissionState.Requested) return permission
  throw invalidState(
    `Permission ${permissionRequestId} is already ${permission.state}.`,
    {
      permissionRequestId,
      state: permission.state,
    },
  )
}

function requireAllowedPermission(
  session: SessionProjection,
  turnId: string,
  permissionRequestId: string,
): PermissionProjection {
  const permission = requirePermission(session, turnId, permissionRequestId)
  if (
    permission.state === PermissionState.Resolved &&
    permission.behavior === PermissionBehavior.Allow
  ) {
    return permission
  }
  if (permission.state === PermissionState.Resolved) {
    throw invalidState(
      `Permission ${permissionRequestId} resolved with ${permission.behavior}.`,
      {
        permissionRequestId,
        behavior: permission.behavior ?? null,
      },
    )
  }
  throw invalidState(
    `Permission ${permissionRequestId} has not been allowed.`,
    {
      permissionRequestId,
      state: permission.state,
    },
  )
}

function requireAllowedToolPermissions(
  session: SessionProjection,
  turnId: string,
  tool: ToolProjection,
): void {
  const permissions = session.permissions.filter(
    (permission) =>
      permission.turnId === turnId &&
      (permission.permissionRequestId === tool.permissionRequestId ||
        permission.toolCallId === tool.toolCallId),
  )

  for (const permission of permissions) {
    requireAllowedPermission(session, turnId, permission.permissionRequestId)
  }
}

function requireTool(
  session: SessionProjection,
  turnId: string,
  toolCallId: string,
): ToolProjection {
  const tool = session.tools.find(
    (candidate) => candidate.toolCallId === toolCallId,
  )
  if (!tool) {
    throw notFound(`Tool ${toolCallId} has not been requested.`, {
      toolCallId,
    })
  }
  if (tool.turnId === turnId) return tool
  throw invalidArgument(
    `Tool ${toolCallId} does not belong to turn ${turnId}.`,
    {
      toolCallId,
      turnId,
      actualTurnId: tool.turnId,
    },
  )
}

function requireRequestedTool(
  session: SessionProjection,
  turnId: string,
  toolCallId: string,
): ToolProjection {
  const tool = requireTool(session, turnId, toolCallId)
  if (tool.state === ToolState.Requested) return tool
  throw invalidState(`Tool ${toolCallId} is already ${tool.state}.`, {
    toolCallId,
    state: tool.state,
  })
}

function requireStartedTool(
  session: SessionProjection,
  turnId: string,
  toolCallId: string,
): ToolProjection {
  const tool = requireTool(session, turnId, toolCallId)
  if (tool.state === ToolState.Started) return tool
  throw invalidState(`Tool ${toolCallId} is already ${tool.state}.`, {
    toolCallId,
    state: tool.state,
  })
}

function requireOpenTool(
  session: SessionProjection,
  turnId: string,
  toolCallId: string,
): ToolProjection {
  const tool = requireTool(session, turnId, toolCallId)
  if (tool.state === ToolState.Requested || tool.state === ToolState.Started) {
    return tool
  }
  throw invalidState(`Tool ${toolCallId} is already ${tool.state}.`, {
    toolCallId,
    state: tool.state,
  })
}

function requireToolProgress(input: RecordToolProgressInput): void {
  if (input.message !== undefined || input.data !== undefined) return
  throw invalidArgument(`Tool ${input.toolCallId} progress has no changes.`, {
    toolCallId: input.toolCallId,
  })
}

function requireNoOpenTurnWork(
  session: SessionProjection,
  turnId: string,
): void {
  const item = session.items.find(
    (candidate) =>
      candidate.turnId === turnId && candidate.status === ItemStatus.InProgress,
  )
  if (item) {
    throw invalidState(`Turn ${turnId} has open item ${item.itemId}.`, {
      turnId,
      itemId: item.itemId,
    })
  }

  const permission = session.permissions.find(
    (candidate) =>
      candidate.turnId === turnId &&
      candidate.state === PermissionState.Requested,
  )
  if (permission) {
    throw invalidState(
      `Turn ${turnId} has pending permission ${permission.permissionRequestId}.`,
      {
        turnId,
        permissionRequestId: permission.permissionRequestId,
      },
    )
  }

  const tool = session.tools.find(
    (candidate) =>
      candidate.turnId === turnId &&
      (candidate.state === ToolState.Requested ||
        candidate.state === ToolState.Started),
  )
  if (tool) {
    throw invalidState(`Turn ${turnId} has open tool ${tool.toolCallId}.`, {
      turnId,
      toolCallId: tool.toolCallId,
    })
  }
}

function openTurnWorkClosureEvents(
  session: SessionProjection,
  turnId: string,
  reason: string | undefined,
): KernelEvent[] {
  return [
    ...session.tools
      .filter((tool) => isOpenTool(tool, turnId))
      .map((tool) => ({
        type: EventType.ToolCancelled,
        data: {
          toolCallId: tool.toolCallId,
          turnId,
          ...(reason === undefined ? {} : { reason }),
        },
      })),
    ...session.permissions
      .filter((permission) => isPendingPermission(permission, turnId))
      .map((permission) => ({
        type: EventType.PermissionCancelled,
        data: {
          permissionRequestId: permission.permissionRequestId,
          turnId,
          ...(reason === undefined ? {} : { reason }),
        },
      })),
    ...session.items
      .filter((item) => isOpenItem(item, turnId))
      .map((item) => ({
        type: EventType.ItemCompleted,
        data: {
          itemId: item.itemId,
          turnId,
          status: ItemStatus.Failed,
          ...(reason === undefined
            ? {}
            : {
                metadata: {
                  reason,
                },
              }),
        },
      })),
  ]
}

function isOpenItem(item: ItemProjection, turnId: string): boolean {
  return item.turnId === turnId && item.status === ItemStatus.InProgress
}

function isPendingPermission(
  permission: PermissionProjection,
  turnId: string,
): boolean {
  return (
    permission.turnId === turnId &&
    permission.state === PermissionState.Requested
  )
}

function isOpenTool(tool: ToolProjection, turnId: string): boolean {
  return (
    tool.turnId === turnId &&
    (tool.state === ToolState.Requested || tool.state === ToolState.Started)
  )
}

function requireNoActiveTurn(session: SessionProjection): void {
  const turn = session.turns.find(
    (candidate) => candidate.state === TurnState.Started,
  )
  if (!turn) return
  throw invalidState(
    `Session ${session.id} already has active turn ${turn.turnId}.`,
    {
      sessionId: session.id,
      turnId: turn.turnId,
    },
  )
}

function requireActiveTurn(
  session: SessionProjection,
  turnId: string,
): TurnProjection {
  const turn = requireTurnStarted(session, turnId)
  if (turn.state === TurnState.Started) return turn
  throw invalidState(`Turn ${turnId} is already ${turn.state}.`, {
    turnId,
    state: turn.state,
  })
}

function requireLastEvent(events: readonly EventEnvelope[]): EventEnvelope {
  const event = events.at(-1)
  if (event) return event
  throw invalidState("Expected appended events.")
}

function invalidArgument(message: string, details?: EventMetadata): Error {
  return createYakitoriError({
    code: YakitoriErrorCode.InvalidArgument,
    message,
    ...(details === undefined ? {} : { details }),
  })
}

function invalidState(message: string, details?: EventMetadata): Error {
  return createYakitoriError({
    code: YakitoriErrorCode.InvalidState,
    message,
    ...(details === undefined ? {} : { details }),
  })
}

function notFound(message: string, details?: EventMetadata): Error {
  return createYakitoriError({
    code: YakitoriErrorCode.NotFound,
    message,
    ...(details === undefined ? {} : { details }),
  })
}
