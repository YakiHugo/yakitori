import type { EventStore } from "./event-store.ts"
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
  createSessionId,
  createToolCallId,
  createTurnId,
} from "./ids.ts"
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
  readSession(input: ReadSessionInput): Promise<ReadSessionResult>
  replaySession(input: ReplaySessionInput): Promise<ReplaySessionResult>
  admitInput(input: AdmitInputInput): Promise<AdmitInputResult>
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
  readonly content: TextContent
  readonly role?: InputRole
  readonly parentInputId?: string
  readonly metadata?: EventMetadata
}

export type AdmitInputResult = {
  readonly inputId: string
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
  return {
    async createSession(input = {}) {
      const sessionId = createSessionId()
      const event = await eventStore.appendEvent(sessionId, {
        type: EventType.SessionCreated,
        data: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.workingDirectory === undefined
            ? {}
            : { workingDirectory: input.workingDirectory }),
          ...(input.parentSessionId === undefined
            ? {}
            : { parentSessionId: input.parentSessionId }),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        },
      })

      return { sessionId, event }
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
      const session = await readSessionProjection(eventStore, input.sessionId)
      if (input.parentInputId !== undefined) {
        requireInput(session, input.parentInputId)
      }

      const inputId = createInputId()
      const event = await eventStore.appendEvent(input.sessionId, {
        type: EventType.InputAdmitted,
        data: {
          inputId,
          role: input.role ?? InputRole.User,
          content: input.content,
          ...(input.parentInputId === undefined
            ? {}
            : { parentInputId: input.parentInputId }),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        },
      })

      return { inputId, event }
    },

    async startTurn(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireInputReadyForTurn(requireInput(session, input.inputId))
      if (input.parentTurnId !== undefined) {
        requireTurnStarted(session, input.parentTurnId)
      }
      requireNoActiveTurn(session)

      const turnId = createTurnId()
      return {
        turnId,
        events: await eventStore.appendEvents(input.sessionId, [
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

    async appendItem(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireActiveTurn(session, input.turnId)
      if (input.parentItemId !== undefined) {
        requireItem(session, input.turnId, input.parentItemId)
      }

      const itemId = createItemId()
      const event = await eventStore.appendEvent(input.sessionId, {
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

    async updateItem(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireActiveTurn(session, input.turnId)
      requireOpenItem(session, input.turnId, input.itemId)
      requireItemUpdate(input)

      return {
        event: await eventStore.appendEvent(input.sessionId, {
          type: EventType.ItemUpdated,
          data: {
            itemId: input.itemId,
            turnId: input.turnId,
            ...(input.content === undefined ? {} : { content: input.content }),
            ...(input.metadata === undefined
              ? {}
              : { metadata: input.metadata }),
          },
        }),
      }
    },

    async completeItem(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireActiveTurn(session, input.turnId)
      requireOpenItem(session, input.turnId, input.itemId)

      return {
        event: await eventStore.appendEvent(input.sessionId, {
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

    async requestPermission(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireActiveTurn(session, input.turnId)
      if (input.toolCallId !== undefined) {
        requireTool(session, input.turnId, input.toolCallId)
      }

      const permissionRequestId = createPermissionRequestId()
      const event = await eventStore.appendEvent(input.sessionId, {
        type: EventType.PermissionRequested,
        data: {
          permissionRequestId,
          turnId: input.turnId,
          action: input.action,
          ...(input.subject === undefined ? {} : { subject: input.subject }),
          ...(input.toolCallId === undefined
            ? {}
            : { toolCallId: input.toolCallId }),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        },
      })

      return { permissionRequestId, event }
    },

    async resolvePermission(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireActiveTurn(session, input.turnId)
      requirePendingPermission(session, input.turnId, input.permissionRequestId)

      return {
        event: await eventStore.appendEvent(input.sessionId, {
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

    async cancelPermission(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireActiveTurn(session, input.turnId)
      requirePendingPermission(session, input.turnId, input.permissionRequestId)

      return {
        event: await eventStore.appendEvent(input.sessionId, {
          type: EventType.PermissionCancelled,
          data: {
            permissionRequestId: input.permissionRequestId,
            turnId: input.turnId,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          },
        }),
      }
    },

    async requestTool(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireActiveTurn(session, input.turnId)
      if (input.itemId !== undefined) {
        requireItem(session, input.turnId, input.itemId)
      }
      if (input.permissionRequestId !== undefined) {
        requirePermission(session, input.turnId, input.permissionRequestId)
      }

      const toolCallId = createToolCallId()
      const event = await eventStore.appendEvent(input.sessionId, {
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

    async startTool(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireActiveTurn(session, input.turnId)
      const tool = requireRequestedTool(session, input.turnId, input.toolCallId)
      if (tool.permissionRequestId !== undefined) {
        requireAllowedPermission(
          session,
          input.turnId,
          tool.permissionRequestId,
        )
      }

      return {
        event: await eventStore.appendEvent(input.sessionId, {
          type: EventType.ToolStarted,
          data: {
            toolCallId: input.toolCallId,
            turnId: input.turnId,
          },
        }),
      }
    },

    async recordToolProgress(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireActiveTurn(session, input.turnId)
      requireStartedTool(session, input.turnId, input.toolCallId)
      requireToolProgress(input)

      return {
        event: await eventStore.appendEvent(input.sessionId, {
          type: EventType.ToolProgress,
          data: {
            toolCallId: input.toolCallId,
            turnId: input.turnId,
            ...(input.message === undefined ? {} : { message: input.message }),
            ...(input.data === undefined ? {} : { data: input.data }),
          },
        }),
      }
    },

    async completeTool(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireActiveTurn(session, input.turnId)
      requireStartedTool(session, input.turnId, input.toolCallId)
      if (input.itemId !== undefined) {
        requireItem(session, input.turnId, input.itemId)
      }

      return {
        event: await eventStore.appendEvent(input.sessionId, {
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

    async failTool(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireActiveTurn(session, input.turnId)
      requireStartedTool(session, input.turnId, input.toolCallId)

      return {
        event: await eventStore.appendEvent(input.sessionId, {
          type: EventType.ToolFailed,
          data: {
            toolCallId: input.toolCallId,
            turnId: input.turnId,
            error: input.error,
          },
        }),
      }
    },

    async cancelTool(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireActiveTurn(session, input.turnId)
      requireOpenTool(session, input.turnId, input.toolCallId)

      return {
        event: await eventStore.appendEvent(input.sessionId, {
          type: EventType.ToolCancelled,
          data: {
            toolCallId: input.toolCallId,
            turnId: input.turnId,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          },
        }),
      }
    },

    async completeTurn(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireActiveTurn(session, input.turnId)
      if (input.outputItemId !== undefined) {
        requireCompletedItem(session, input.turnId, input.outputItemId)
      }
      requireNoOpenTurnWork(session, input.turnId)

      return {
        event: await eventStore.appendEvent(input.sessionId, {
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

    async failTurn(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireActiveTurn(session, input.turnId)
      const events = await eventStore.appendEvents(input.sessionId, [
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

    async cancelTurn(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireActiveTurn(session, input.turnId)
      const events = await eventStore.appendEvents(input.sessionId, [
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
  }
}

async function readSessionProjection(
  eventStore: EventStore,
  sessionId: string,
): Promise<SessionProjection> {
  const session = await readOptionalSessionProjection(eventStore, sessionId)
  if (session) return session
  throw new Error(`Session ${sessionId} has not been created.`)
}

async function readOptionalSessionProjection(
  eventStore: EventStore,
  sessionId: string,
): Promise<SessionProjection | undefined> {
  return projectSession(await eventStore.readEvents(sessionId))
}

function requireInputReadyForTurn(input: InputProjection): void {
  if (input.state === InputState.Cancelled) {
    throw new Error(`Input ${input.inputId} has been cancelled.`)
  }
  if (input.state === InputState.Promoted) {
    throw new Error(`Input ${input.inputId} has already been promoted.`)
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
  throw new Error(`Input ${inputId} has not been admitted.`)
}

function requireTurnStarted(
  session: SessionProjection,
  turnId: string,
): TurnProjection {
  const turn = session.turns.find((candidate) => candidate.turnId === turnId)
  if (turn) return turn

  throw new Error(`Turn ${turnId} has not been started.`)
}

function requireItem(
  session: SessionProjection,
  turnId: string,
  itemId: string,
): ItemProjection {
  const item = session.items.find((candidate) => candidate.itemId === itemId)
  if (!item) throw new Error(`Item ${itemId} has not been appended.`)
  if (item.turnId === turnId) return item
  throw new Error(`Item ${itemId} does not belong to turn ${turnId}.`)
}

function requireOpenItem(
  session: SessionProjection,
  turnId: string,
  itemId: string,
): ItemProjection {
  const item = requireItem(session, turnId, itemId)
  if (item.status === ItemStatus.InProgress) return item
  throw new Error(`Item ${itemId} is already ${item.status}.`)
}

function requireCompletedItem(
  session: SessionProjection,
  turnId: string,
  itemId: string,
): ItemProjection {
  const item = requireItem(session, turnId, itemId)
  if (item.status === ItemStatus.Completed) return item
  throw new Error(`Item ${itemId} is ${item.status}.`)
}

function requireItemUpdate(input: UpdateItemInput): void {
  if (input.content !== undefined || input.metadata !== undefined) return
  throw new Error(`Item ${input.itemId} update has no changes.`)
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
    throw new Error(`Permission ${permissionRequestId} has not been requested.`)
  }
  if (permission.turnId === turnId) return permission
  throw new Error(
    `Permission ${permissionRequestId} does not belong to turn ${turnId}.`,
  )
}

function requirePendingPermission(
  session: SessionProjection,
  turnId: string,
  permissionRequestId: string,
): PermissionProjection {
  const permission = requirePermission(session, turnId, permissionRequestId)
  if (permission.state === PermissionState.Requested) return permission
  throw new Error(
    `Permission ${permissionRequestId} is already ${permission.state}.`,
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
    throw new Error(
      `Permission ${permissionRequestId} resolved with ${permission.behavior}.`,
    )
  }
  throw new Error(`Permission ${permissionRequestId} has not been allowed.`)
}

function requireTool(
  session: SessionProjection,
  turnId: string,
  toolCallId: string,
): ToolProjection {
  const tool = session.tools.find(
    (candidate) => candidate.toolCallId === toolCallId,
  )
  if (!tool) throw new Error(`Tool ${toolCallId} has not been requested.`)
  if (tool.turnId === turnId) return tool
  throw new Error(`Tool ${toolCallId} does not belong to turn ${turnId}.`)
}

function requireRequestedTool(
  session: SessionProjection,
  turnId: string,
  toolCallId: string,
): ToolProjection {
  const tool = requireTool(session, turnId, toolCallId)
  if (tool.state === ToolState.Requested) return tool
  throw new Error(`Tool ${toolCallId} is already ${tool.state}.`)
}

function requireStartedTool(
  session: SessionProjection,
  turnId: string,
  toolCallId: string,
): ToolProjection {
  const tool = requireTool(session, turnId, toolCallId)
  if (tool.state === ToolState.Started) return tool
  throw new Error(`Tool ${toolCallId} is already ${tool.state}.`)
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
  throw new Error(`Tool ${toolCallId} is already ${tool.state}.`)
}

function requireToolProgress(input: RecordToolProgressInput): void {
  if (input.message !== undefined || input.data !== undefined) return
  throw new Error(`Tool ${input.toolCallId} progress has no changes.`)
}

function requireNoOpenTurnWork(
  session: SessionProjection,
  turnId: string,
): void {
  const item = session.items.find(
    (candidate) =>
      candidate.turnId === turnId && candidate.status === ItemStatus.InProgress,
  )
  if (item) throw new Error(`Turn ${turnId} has open item ${item.itemId}.`)

  const permission = session.permissions.find(
    (candidate) =>
      candidate.turnId === turnId &&
      candidate.state === PermissionState.Requested,
  )
  if (permission) {
    throw new Error(
      `Turn ${turnId} has pending permission ${permission.permissionRequestId}.`,
    )
  }

  const tool = session.tools.find(
    (candidate) =>
      candidate.turnId === turnId &&
      (candidate.state === ToolState.Requested ||
        candidate.state === ToolState.Started),
  )
  if (tool) throw new Error(`Turn ${turnId} has open tool ${tool.toolCallId}.`)
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
  throw new Error(
    `Session ${session.id} already has active turn ${turn.turnId}.`,
  )
}

function requireActiveTurn(
  session: SessionProjection,
  turnId: string,
): TurnProjection {
  const turn = requireTurnStarted(session, turnId)
  if (turn.state === TurnState.Started) return turn
  throw new Error(`Turn ${turnId} is already ${turn.state}.`)
}

function requireLastEvent(events: readonly EventEnvelope[]): EventEnvelope {
  const event = events.at(-1)
  if (event) return event
  throw new Error("Expected appended events.")
}
