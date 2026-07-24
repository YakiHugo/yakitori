import type { EventStore } from "./event-store.ts"
import { createYakitoriError, YakitoriErrorCode } from "./errors.ts"
import {
  EventType,
  InputRole,
  PermissionBehavior,
  type AssistantContentBlock,
  type EventEnvelope,
  type EventMetadata,
  type ItemContent,
  type JsonValue,
  type KernelError,
  type KernelEvent,
  type PermissionDecisionReason,
  type StoredEventEnvelope,
  type TextContent,
  type TurnExecutionContext,
} from "./events.ts"
import {
  createInputId,
  createItemId,
  createPermissionRequestId,
  createRequestId,
  createSessionId,
  createTurnId,
  isRequestId,
} from "./ids.ts"
import { fingerprintOperation } from "./operation.ts"
import {
  InputState,
  PermissionState,
  ToolState,
  TurnState,
  projectSession,
  type InputProjection,
  type SessionProjection,
  type ToolProjection,
  type TurnProjection,
} from "./session-projector.ts"

export type SessionKernel = {
  createSession(input?: CreateSessionInput): Promise<CreateSessionResult>
  listSessions(input?: ListSessionsInput): Promise<ListSessionsResult>
  readSession(input: ReadSessionInput): Promise<ReadSessionResult>
  readEvents(input: ReadEventsInput): Promise<ReadEventsResult>
  replaySession(input: ReplaySessionInput): Promise<ReplaySessionResult>
  admitInput(input: AdmitInputInput): Promise<AdmitInputResult>
  cancelInput(input: CancelInputInput): Promise<CancelInputResult>
  startTurn(input: StartTurnInput): Promise<StartTurnResult>
  recordAssistantOutput(
    input: RecordAssistantOutputInput,
  ): Promise<RecordAssistantOutputResult>
  requestPermission(
    input: RequestPermissionInput,
  ): Promise<RequestPermissionResult>
  resolvePermission(
    input: ResolvePermissionInput,
  ): Promise<ResolvePermissionResult>
  requireToolExecutionAllowed(
    input: RequireToolExecutionAllowedInput,
  ): Promise<void>
  recordToolResult(
    input: RecordToolResultInput,
  ): Promise<RecordToolResultResult>
  completeTurn(input: CompleteTurnInput): Promise<CompleteTurnResult>
  completeTurnWithAssistantOutput(
    input: CompleteTurnWithAssistantOutputInput,
  ): Promise<CompleteTurnWithAssistantOutputResult>
  failTurn(input: FailTurnInput): Promise<FailTurnResult>
  cancelTurn(input: CancelTurnInput): Promise<CancelTurnResult>
  interruptTurn(input: InterruptTurnInput): Promise<InterruptTurnResult>
}

export type CreateSessionInput = {
  readonly title?: string
  readonly workingDirectory?: string
  readonly mateId?: string
  readonly mateRevisionId?: string
  readonly parentSessionId?: string
  readonly metadata?: EventMetadata
}
export type CreateSessionResult = {
  readonly sessionId: string
  readonly event: EventEnvelope
}
export type ListSessionsInput = {
  readonly limit?: number
  readonly cursor?: string
  readonly order?: "recent" | "created"
}
export type SessionSummary = {
  readonly sessionId: string
  readonly seq: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly title?: string
  readonly workingDirectory?: string
  readonly mateId?: string
  readonly mateRevisionId?: string
  readonly parentSessionId?: string
  readonly metadata?: EventMetadata
}
export type ListSessionsResult = {
  readonly sessions: readonly SessionSummary[]
  readonly nextCursor?: string
}
export type ReadSessionInput = { readonly sessionId: string }
export type ReadSessionResult = { readonly session?: SessionProjection }
export type ReadEventsInput = {
  readonly sessionId: string
  readonly after?: number
}
export type ReadEventsResult = {
  readonly events: readonly StoredEventEnvelope[]
}
export type ReplaySessionInput = { readonly sessionId: string }
export type ReplaySessionResult = {
  readonly events: readonly StoredEventEnvelope[]
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
export type CancelInputResult = { readonly event: EventEnvelope }
export type StartTurnInput = {
  readonly sessionId: string
  readonly inputId: string
  readonly parentTurnId?: string
  readonly executionContext?: TurnExecutionContext
  readonly metadata?: EventMetadata
}
export type StartTurnResult = {
  readonly turnId: string
  readonly events: readonly EventEnvelope[]
}
export type AssistantToolCallInput = {
  readonly id: string
  readonly name: string
  readonly input: JsonValue
  readonly requiresPermission: boolean
  readonly providerMetadata?: EventMetadata
}
export type RecordAssistantOutputInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly content?: readonly AssistantContentBlock[]
  readonly providerMetadata?: EventMetadata
  readonly toolCalls?: readonly AssistantToolCallInput[]
}
export type RecordedToolCall = {
  readonly toolCallId: string
  readonly itemId: string
  readonly event: EventEnvelope
}
export type RecordAssistantOutputResult = {
  readonly messageId?: string
  readonly toolCalls: readonly RecordedToolCall[]
  readonly events: readonly EventEnvelope[]
}
export type RequestPermissionInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly toolCallId: string
  readonly action: string
  readonly subject?: string
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
export type ResolvePermissionResult = { readonly event: EventEnvelope }
export type RequireToolExecutionAllowedInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly toolCallId: string
}
export type RecordToolResultInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly toolCallId: string
  readonly content: ItemContent
  readonly output?: JsonValue
  readonly error?: KernelError
}
export type RecordToolResultResult = {
  readonly itemId: string
  readonly event: EventEnvelope
  readonly events: readonly EventEnvelope[]
}
export type CompleteTurnInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly outputMessageId?: string
  readonly metadata?: EventMetadata
}
export type CompleteTurnResult = {
  readonly event: EventEnvelope
  readonly events: readonly EventEnvelope[]
}
export type CompleteTurnWithAssistantOutputInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly content: TextContent
  readonly providerMetadata?: EventMetadata
  readonly metadata?: EventMetadata
}
export type CompleteTurnWithAssistantOutputResult = {
  readonly itemId: string
  readonly event: EventEnvelope
  readonly events: readonly EventEnvelope[]
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
export type InterruptTurnInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly reason?: string
}
export type InterruptTurnResult = {
  readonly event?: EventEnvelope
  readonly events: readonly EventEnvelope[]
  readonly created: boolean
}

export function createSessionKernel(eventStore: EventStore): SessionKernel {
  const commandQueues = new Map<string, Promise<void>>()
  const command = <T>(sessionId: string, run: () => Promise<T>) =>
    serializeSessionCommand(commandQueues, sessionId, run)

  return {
    async createSession(input = {}) {
      const sessionId = createSessionId()
      const event = await eventStore.appendEvent(
        sessionId,
        {
          type: EventType.SessionCreated,
          data: compact({
            title: input.title,
            workingDirectory: input.workingDirectory,
            mateId: input.mateId,
            mateRevisionId: input.mateRevisionId,
            parentSessionId: input.parentSessionId,
            metadata: input.metadata,
          }),
        },
        { expectedSeq: 0 },
      )
      return { sessionId, event }
    },

    async listSessions(input = {}) {
      return eventStore.listSessions(input)
    },

    async readSession(input) {
      const session = await eventStore.readProjection(input.sessionId)
      return session ? { session } : {}
    },

    async readEvents(input) {
      return {
        events: await eventStore.readEvents(input.sessionId, {
          after: input.after ?? 0,
        }),
      }
    },

    async replaySession(input) {
      const events = await eventStore.readEvents(input.sessionId)
      const session = projectSession(events)
      return session ? { events, session } : { events }
    },

    admitInput(input) {
      return command(input.sessionId, async () => {
        const session = await requireSession(eventStore, input.sessionId)
        if (input.parentInputId !== undefined)
          requireInput(session, input.parentInputId)
        const requestId = input.requestId ?? createRequestId()
        if (!isRequestId(requestId))
          invalidArgument("Invalid request id.", { requestId })
        const inputId = createInputId()
        const event = await eventStore.appendEvent(
          input.sessionId,
          {
            type: EventType.InputAdmitted,
            data: compact({
              requestId,
              inputId,
              role: input.role ?? InputRole.User,
              content: input.content,
              parentInputId: input.parentInputId,
              metadata: input.metadata,
            }),
          },
          {
            expectedSeq: session.seq,
            operation: {
              id: `input.admit:${requestId}`,
              fingerprint: fingerprintOperation({
                role: input.role ?? InputRole.User,
                content: input.content,
                parentInputId: input.parentInputId ?? null,
                metadata: input.metadata ?? null,
              }),
            },
          },
        )
        if (event.type !== EventType.InputAdmitted)
          invalidState("Admission receipt did not reference input.admitted.")
        return {
          requestId,
          inputId: event.data.inputId,
          event,
          created: event.data.inputId === inputId,
        }
      })
    },

    cancelInput(input) {
      return command(input.sessionId, async () => {
        const session = await requireSession(eventStore, input.sessionId)
        const admitted = requireInput(session, input.inputId)
        if (admitted.state !== InputState.Admitted)
          invalidState(`Input ${input.inputId} is already ${admitted.state}.`)
        const event = await append(eventStore, session, {
          type: EventType.InputCancelled,
          data: compact({ inputId: input.inputId, reason: input.reason }),
        })
        return { event }
      })
    },

    startTurn(input) {
      return command(input.sessionId, async () => {
        const session = await requireSession(eventStore, input.sessionId)
        const admitted = requireInput(session, input.inputId)
        if (admitted.state !== InputState.Admitted)
          invalidState(`Input ${input.inputId} is already ${admitted.state}.`)
        if (session.activeTurn)
          invalidState(
            `Session ${session.id} already has active Turn ${session.activeTurn.turnId}.`,
          )
        if (input.parentTurnId !== undefined)
          requireTurn(session, input.parentTurnId)
        const turnId = createTurnId()
        const event = await append(eventStore, session, {
          type: EventType.TurnStarted,
          data: compact({
            turnId,
            inputId: input.inputId,
            parentTurnId: input.parentTurnId,
            executionContext: input.executionContext,
            metadata: input.metadata,
          }),
        })
        return { turnId, events: [event] }
      })
    },

    recordAssistantOutput(input) {
      return command(input.sessionId, async () => {
        const session = await requireSession(eventStore, input.sessionId)
        requireActiveTurn(session, input.turnId)
        const content = input.content ?? []
        const messageId = content.length === 0 ? undefined : createItemId()
        const callRows = (input.toolCalls ?? []).map((call) => ({
          call,
          itemId: createItemId(),
        }))
        for (const row of callRows) {
          if (session.tools.some((tool) => tool.toolCallId === row.call.id)) {
            invalidState(`Tool call ${row.call.id} already exists.`)
          }
        }
        const events: KernelEvent[] = [
          ...(messageId === undefined
            ? []
            : [
                {
                  type: EventType.AssistantMessage,
                  data: compact({
                    messageId,
                    turnId: input.turnId,
                    content,
                    providerMetadata: input.providerMetadata,
                  }),
                },
              ]),
          ...callRows.map((row) => ({
            type: EventType.ToolCall,
            data: compact({
              toolCallId: row.call.id,
              itemId: row.itemId,
              turnId: input.turnId,
              name: row.call.name,
              input: row.call.input,
              requiresPermission: row.call.requiresPermission,
              providerMetadata: row.call.providerMetadata,
            }),
          })),
        ]
        if (events.length === 0)
          invalidArgument("Assistant output has no facts to record.")
        const envelopes = await appendMany(eventStore, session, events)
        return {
          ...(messageId === undefined ? {} : { messageId }),
          toolCalls: callRows.map((row, index) => ({
            toolCallId: row.call.id,
            itemId: row.itemId,
            event: requireEnvelope(
              envelopes[(messageId === undefined ? 0 : 1) + index],
            ),
          })),
          events: envelopes,
        }
      })
    },

    requestPermission(input) {
      return command(input.sessionId, async () => {
        const session = await requireSession(eventStore, input.sessionId)
        requireActiveTurn(session, input.turnId)
        const tool = requireTool(session, input.turnId, input.toolCallId)
        if (!tool.requiresPermission)
          invalidState(
            `Tool call ${input.toolCallId} does not require permission.`,
          )
        if (tool.permissionRequestId !== undefined)
          invalidState(
            `Tool call ${input.toolCallId} already has a permission request.`,
          )
        const permissionRequestId = createPermissionRequestId()
        const event = await append(eventStore, session, {
          type: EventType.PermissionRequested,
          data: compact({
            permissionRequestId,
            turnId: input.turnId,
            toolCallId: input.toolCallId,
            action: input.action,
            subject: input.subject,
            reason: input.reason,
            metadata: input.metadata,
          }),
        })
        return { permissionRequestId, event }
      })
    },

    resolvePermission(input) {
      return command(input.sessionId, async () => {
        const session = await requireSession(eventStore, input.sessionId)
        requireActiveTurn(session, input.turnId)
        const permission = session.permissions.find(
          (candidate) =>
            candidate.permissionRequestId === input.permissionRequestId,
        )
        if (!permission || permission.turnId !== input.turnId)
          notFound(`Permission ${input.permissionRequestId} was not found.`)
        if (permission.state !== PermissionState.Pending)
          invalidState(
            `Permission ${input.permissionRequestId} is already resolved.`,
          )
        const event = await append(eventStore, session, {
          type: EventType.PermissionResolved,
          data: compact({
            permissionRequestId: input.permissionRequestId,
            turnId: input.turnId,
            behavior: input.behavior,
            reason: input.reason,
            metadata: input.metadata,
          }),
        })
        return { event }
      })
    },

    requireToolExecutionAllowed(input) {
      return command(input.sessionId, async () => {
        const session = await requireSession(eventStore, input.sessionId)
        const tool = requireTool(session, input.turnId, input.toolCallId)
        requireAllowedTool(session, tool)
      })
    },

    recordToolResult(input) {
      return command(input.sessionId, async () => {
        const session = await requireSession(eventStore, input.sessionId)
        const tool = requireTool(session, input.turnId, input.toolCallId)
        if (tool.state !== ToolState.Requested)
          invalidState(`Tool call ${input.toolCallId} already has a result.`)
        const itemId = createItemId()
        const event = await append(eventStore, session, {
          type: EventType.ToolResult,
          data: compact({
            toolResultId: itemId,
            toolCallId: input.toolCallId,
            turnId: input.turnId,
            content: input.content,
            output: input.output,
            error: input.error,
          }),
        })
        return { itemId, event, events: [event] }
      })
    },

    completeTurn(input) {
      return terminal(command, eventStore, input.sessionId, input.turnId, {
        type: EventType.TurnCompleted,
        data: compact({
          turnId: input.turnId,
          outputMessageId: input.outputMessageId,
          metadata: input.metadata,
        }),
      })
    },

    completeTurnWithAssistantOutput(input) {
      return command(input.sessionId, async () => {
        const session = await requireSession(eventStore, input.sessionId)
        requireActiveTurn(session, input.turnId)
        const itemId = createItemId()
        const events = await appendMany(eventStore, session, [
          {
            type: EventType.AssistantMessage,
            data: compact({
              messageId: itemId,
              turnId: input.turnId,
              content: [{ type: "text" as const, text: input.content.text }],
              providerMetadata: input.providerMetadata,
            }),
          },
          {
            type: EventType.TurnCompleted,
            data: compact({
              turnId: input.turnId,
              outputMessageId: itemId,
              metadata: input.metadata,
            }),
          },
        ])
        return { itemId, event: requireLast(events), events }
      })
    },

    failTurn(input) {
      return terminal(command, eventStore, input.sessionId, input.turnId, {
        type: EventType.TurnFailed,
        data: { turnId: input.turnId, error: input.error },
      })
    },

    cancelTurn(input) {
      return terminal(command, eventStore, input.sessionId, input.turnId, {
        type: EventType.TurnCancelled,
        data: compact({ turnId: input.turnId, reason: input.reason }),
      })
    },

    interruptTurn(input) {
      return command(input.sessionId, async () => {
        const session = await requireSession(eventStore, input.sessionId)
        const turn = requireTurn(session, input.turnId)
        if (turn.state === TurnState.Interrupted)
          return { events: [], created: false }
        if (turn.state !== TurnState.Started)
          invalidState(`Turn ${input.turnId} is already ${turn.state}.`)
        const event = await append(eventStore, session, {
          type: EventType.TurnInterrupted,
          data: compact({ turnId: input.turnId, reason: input.reason }),
        })
        return { event, events: [event], created: true }
      })
    },
  }
}

function terminal<
  T extends CompleteTurnResult | FailTurnResult | CancelTurnResult,
>(
  command: <R>(sessionId: string, run: () => Promise<R>) => Promise<R>,
  eventStore: EventStore,
  sessionId: string,
  turnId: string,
  fact: KernelEvent,
): Promise<T> {
  return command(sessionId, async () => {
    const session = await requireSession(eventStore, sessionId)
    requireActiveTurn(session, turnId)
    const event = await append(eventStore, session, fact)
    return { event, events: [event] } as unknown as T
  })
}

function append(
  eventStore: EventStore,
  session: SessionProjection,
  event: KernelEvent,
) {
  return eventStore.appendEvent(session.id, event, { expectedSeq: session.seq })
}

function appendMany(
  eventStore: EventStore,
  session: SessionProjection,
  events: readonly KernelEvent[],
) {
  return eventStore.appendEvents(session.id, events, {
    expectedSeq: session.seq,
  })
}

async function requireSession(
  eventStore: EventStore,
  sessionId: string,
): Promise<SessionProjection> {
  const session = await eventStore.readProjection(sessionId)
  if (session) return session
  return notFound(`Session ${sessionId} has not been created.`, { sessionId })
}

function requireInput(
  session: SessionProjection,
  inputId: string,
): InputProjection {
  const input = session.inputs.find(
    (candidate) => candidate.inputId === inputId,
  )
  if (input) return input
  return notFound(`Input ${inputId} was not found.`, { inputId })
}

function requireTurn(
  session: SessionProjection,
  turnId: string,
): TurnProjection {
  const turn = session.turns.find((candidate) => candidate.turnId === turnId)
  if (turn) return turn
  return notFound(`Turn ${turnId} was not found.`, { turnId })
}

function requireActiveTurn(
  session: SessionProjection,
  turnId: string,
): TurnProjection {
  const turn = requireTurn(session, turnId)
  if (turn.state === TurnState.Started && session.activeTurn?.turnId === turnId)
    return turn
  return invalidState(`Turn ${turnId} is not active.`, {
    turnId,
    state: turn.state,
  })
}

function requireTool(
  session: SessionProjection,
  turnId: string,
  toolCallId: string,
): ToolProjection {
  const tool = session.tools.find(
    (candidate) => candidate.toolCallId === toolCallId,
  )
  if (tool && tool.turnId === turnId) return tool
  return notFound(`Tool call ${toolCallId} was not found.`, {
    toolCallId,
    turnId,
  })
}

function requireAllowedTool(
  session: SessionProjection,
  tool: ToolProjection,
): void {
  if (!tool.requiresPermission) return
  const permission = session.permissions.find(
    (candidate) => candidate.permissionRequestId === tool.permissionRequestId,
  )
  if (
    permission?.toolCallId === tool.toolCallId &&
    permission.state === PermissionState.Resolved &&
    permission.behavior === PermissionBehavior.Allow
  )
    return
  invalidState(`Tool call ${tool.toolCallId} has not been allowed.`)
}

function serializeSessionCommand<T>(
  queues: Map<string, Promise<void>>,
  sessionId: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(sessionId) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(run)
  const settled = current.then(
    () => undefined,
    () => undefined,
  )
  queues.set(sessionId, settled)
  void settled.then(() => {
    if (queues.get(sessionId) === settled) queues.delete(sessionId)
  })
  return current
}

type Compact<T extends Record<string, unknown>> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K]
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<
    T[K],
    undefined
  >
}

function compact<T extends Record<string, unknown>>(value: T): Compact<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Compact<T>
}

function requireLast(events: readonly EventEnvelope[]): EventEnvelope {
  const event = events.at(-1)
  if (event) return event
  throw new Error("Expected at least one event.")
}

function requireEnvelope(event: EventEnvelope | undefined): EventEnvelope {
  if (event) return event
  throw new Error("Expected event envelope.")
}

function invalidArgument(message: string, details?: EventMetadata): never {
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidArgument,
    message,
    ...(details ? { details } : {}),
  })
}

function invalidState(message: string, details?: EventMetadata): never {
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidState,
    message,
    ...(details ? { details } : {}),
  })
}

function notFound(message: string, details?: EventMetadata): never {
  throw createYakitoriError({
    code: YakitoriErrorCode.NotFound,
    message,
    ...(details ? { details } : {}),
  })
}
