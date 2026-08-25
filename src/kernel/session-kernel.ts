import { createYakitoriError, YakitoriErrorCode } from "./errors.ts"
import type { EventStore } from "./event-store.ts"
import {
  type AssistantContentBlock,
  type ContextWindowReplacement,
  type EventEnvelope,
  type EventMetadata,
  EventType,
  HistoryRecordType,
  type ForkReason,
  InputRole,
  type ItemContent,
  type JsonObject,
  type JsonValue,
  type KernelError,
  type KernelEvent,
  type KernelFact,
  type ModelMessage,
  type ModelSelection,
  PermissionBehavior,
  type PermissionDecisionReason,
  type ProviderUsageBaseline,
  type SessionConfigurationSnapshot,
  type StoredEventEnvelope,
  type TextContent,
  type TokenUsage,
  type ToolExecutionDescriptor,
  type TurnExecutionContext,
  type TurnMetrics,
  type WorldStateFragment,
} from "./events.ts"
import {
  createCompactionId,
  createContextWindowId,
  createInputId,
  createItemId,
  createPermissionRequestId,
  createRequestId,
  createSessionId,
  createTurnId,
  isRequestId,
} from "./ids.ts"
import { fingerprintInputAdmission } from "./operation.ts"
import {
  type InputProjection,
  InputState,
  PermissionState,
  type SessionProjection,
  type SessionSummary,
  type ToolProjection,
  ToolState,
  type TurnProjection,
  TurnState,
} from "./session-projector.ts"
import {
  executionDescriptor,
  toolExecutionDescriptorsCompatible,
} from "./tool-execution.ts"

export type SessionKernel = {
  createSession(input?: CreateSessionInput): Promise<CreateSessionResult>
  configureSession(
    input: ConfigureSessionInput,
  ): Promise<ConfigureSessionResult>
  seedContextWindow(
    input: SeedContextWindowInput,
  ): Promise<SeedContextWindowResult>
  forkSession(input: ForkSessionInput): Promise<ForkSessionResult>
  listSessions(input?: ListSessionsInput): Promise<ListSessionsResult>
  readSession(input: ReadSessionInput): Promise<ReadSessionResult>
  deleteSession(input: DeleteSessionInput): Promise<DeleteSessionResult>
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
  recordProviderUsageBaseline(
    input: RecordProviderUsageBaselineInput,
  ): Promise<RecordProviderUsageBaselineResult>
  recordCompaction(
    input: RecordCompactionInput,
  ): Promise<RecordCompactionResult>
  recordWorldStateUpdate(
    input: RecordWorldStateUpdateInput,
  ): Promise<RecordWorldStateUpdateResult>
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
export type ConfigureSessionInput = {
  readonly sessionId: string
  readonly configuration: SessionConfigurationSnapshot
}
export type ConfigureSessionResult = {
  readonly event?: EventEnvelope
  readonly configuration: SessionConfigurationSnapshot
  readonly created: boolean
}
export type SeedContextWindowInput = {
  readonly sessionId: string
  readonly sourceSessionId: string
  readonly history: readonly ModelMessage[]
  readonly worldStateBaseline?: JsonObject
  readonly providerUsageBaseline?: {
    readonly turnId: string
    readonly modelCallId: string
    readonly baseline: ProviderUsageBaseline
  }
}
export type SeedContextWindowResult = {
  readonly windowId: string
  readonly event: EventEnvelope
  readonly events: readonly EventEnvelope[]
}
export type ForkSessionInput = {
  readonly sessionId: string
  readonly atInputId: string
  readonly reason: ForkReason
  readonly content?: TextContent
  readonly modelSelection?: ModelSelection
}
export type ForkSessionResult = {
  readonly sessionId: string
  readonly historyEndSeqExclusive: number
  readonly session: SessionProjection
  readonly events: readonly StoredEventEnvelope[]
  readonly localEvents: readonly StoredEventEnvelope[]
  readonly sourceEvents: readonly EventEnvelope[]
}
export type ListSessionsInput = {
  readonly limit?: number
  readonly cursor?: string
  readonly order?: "recent" | "created"
  readonly workingDirectory?: string
}
export type ListSessionsResult = {
  readonly sessions: readonly SessionSummary[]
  readonly nextCursor?: string
}
export type ReadSessionInput = { readonly sessionId: string }
export type ReadSessionResult = { readonly session?: SessionProjection }
export type DeleteSessionInput = { readonly sessionId: string }
export type DeleteSessionResult = { readonly sessionId: string }
export type ReadEventsInput = {
  readonly sessionId: string
  readonly after?: number
  readonly through?: number
  readonly limit?: number
}
export type ReadEventsResult = {
  readonly events: readonly StoredEventEnvelope[]
  readonly nextAfter?: number
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
  readonly modelSelection?: ModelSelection
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
  readonly executionContext: TurnExecutionContext
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
  readonly execution?: ToolExecutionDescriptor
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
  readonly execution?: ToolExecutionDescriptor
  readonly output?: JsonValue
  readonly error?: KernelError
}
export type RecordToolResultResult = {
  readonly itemId: string
  readonly event: EventEnvelope
  readonly events: readonly EventEnvelope[]
}
export type RecordProviderUsageBaselineInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly modelCallId: string
  readonly baseline: ProviderUsageBaseline
}
export type RecordProviderUsageBaselineResult = {
  readonly event: EventEnvelope
}
export type RecordCompactionInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly expectedCompactionId: string | null
  readonly throughSeq: number
  readonly coveredTurnIds: readonly string[]
  readonly summary: string
  readonly usage?: TokenUsage
  readonly replacement: Omit<
    ContextWindowReplacement,
    "windowId" | "firstWindowId" | "previousWindowId" | "windowNumber"
  >
}
export type RecordCompactionResult = {
  readonly compactionId: string
  readonly event: EventEnvelope
}
export type RecordWorldStateUpdateInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly afterItemId?: string
  readonly full: boolean
  readonly state: JsonObject
  readonly fragments: readonly WorldStateFragment[]
}
export type RecordWorldStateUpdateResult = {
  readonly event: EventEnvelope
}
export type CompleteTurnInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly usage?: TokenUsage
  readonly metrics?: TurnMetrics
  readonly metadata?: EventMetadata
}
export type CompleteTurnResult = {
  readonly event: EventEnvelope
  readonly events: readonly EventEnvelope[]
}
export type CompleteTurnWithAssistantOutputInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly content: readonly AssistantContentBlock[]
  readonly providerMetadata?: EventMetadata
  readonly usage?: TokenUsage
  readonly metrics?: TurnMetrics
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
  readonly usage?: TokenUsage
  readonly metrics?: TurnMetrics
}
export type FailTurnResult = {
  readonly event: EventEnvelope
  readonly events: readonly EventEnvelope[]
}
export type CancelTurnInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly reason?: string
  readonly usage?: TokenUsage
  readonly metrics?: TurnMetrics
}
export type CancelTurnResult = {
  readonly event: EventEnvelope
  readonly events: readonly EventEnvelope[]
}
export type InterruptTurnInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly reason?: string
  readonly usage?: TokenUsage
  readonly metrics?: TurnMetrics
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
      const event = await eventStore.createSession(sessionId, {
        type: EventType.SessionCreated,
        data: compact({
          title: input.title,
          workingDirectory: input.workingDirectory,
          mateId: input.mateId,
          mateRevisionId: input.mateRevisionId,
          conversationId: sessionId,
          parentSessionId: input.parentSessionId,
          metadata: input.metadata,
        }),
      })
      return { sessionId, event }
    },

    configureSession(input) {
      return command(input.sessionId, async () => {
        const session = await requireSession(eventStore, input.sessionId)
        if (session.configuration !== undefined) {
          return {
            configuration: session.configuration,
            created: false,
          }
        }
        if (session.activeTurn !== undefined)
          invalidState(`Session ${session.id} has an active Turn.`)
        const event = await append(eventStore, session, {
          type: HistoryRecordType.SessionMetadata,
          data: { configuration: input.configuration },
        })
        return { event, configuration: input.configuration, created: true }
      })
    },

    seedContextWindow(input) {
      return command(input.sessionId, async () => {
        const session = await requireSession(eventStore, input.sessionId)
        if (
          session.inputs.length > 0 ||
          session.turns.length > 0 ||
          session.inheritedContext !== undefined ||
          session.compaction !== undefined
        ) {
          invalidState(
            `Session ${session.id} already has model-visible history.`,
          )
        }
        const windowId = createContextWindowId()
        const events = await appendMany(eventStore, session, [
          {
            type: HistoryRecordType.InitialContext,
            data: compact({
              windowId,
              sourceSessionId: input.sourceSessionId,
              history: input.history,
              worldStateBaseline: input.worldStateBaseline,
            }),
          },
          ...(input.providerUsageBaseline === undefined
            ? []
            : [
                {
                  type: HistoryRecordType.ProviderUsageBaseline,
                  data: {
                    turnId: input.providerUsageBaseline.turnId,
                    modelCallId: input.providerUsageBaseline.modelCallId,
                    baseline: {
                      ...input.providerUsageBaseline.baseline,
                      contextWindowId: windowId,
                    },
                  },
                } as const,
              ]),
        ])
        const event = events[0]
        if (event === undefined)
          throw new Error("Expected initial context fact.")
        return { windowId, event, events }
      })
    },

    forkSession(input) {
      return command(input.sessionId, async () => {
        let source = await requireSession(eventStore, input.sessionId)
        const forkPoint = requireInput(source, input.atInputId)
        if (source.activeTurn !== undefined) {
          invalidState(
            `Session ${source.id} has an active turn; interrupt it before forking the session.`,
            {
              sessionId: source.id,
              activeTurnId: source.activeTurn.turnId,
              operation: "fork_session",
            },
          )
        }
        const sourceEvents = await appendMany(
          eventStore,
          source,
          source.pendingInputs.map(
            (pending): KernelEvent => ({
              type: EventType.InputCancelled,
              data: {
                inputId: pending.inputId,
                reason: "conversation_fork",
              },
            }),
          ),
        )
        if (sourceEvents.length > 0) {
          source = await requireSession(eventStore, input.sessionId)
        }

        const sessionId = createSessionId()
        const initialEvents: KernelFact[] = []
        // A fork owns the execution contract it inherits. The source may have
        // been configured after the selected Input was admitted, so that event
        // can sit beyond the history cut even though it governs the source
        // Session today.
        if (source.configuration !== undefined) {
          initialEvents.push({
            type: HistoryRecordType.SessionMetadata,
            data: { configuration: source.configuration },
          })
        }
        if (input.content !== undefined) {
          const content =
            input.content.attachments === undefined &&
            forkPoint.content.attachments !== undefined
              ? {
                  ...input.content,
                  attachments: forkPoint.content.attachments,
                }
              : input.content
          initialEvents.push({
            type: EventType.InputAdmitted,
            data: {
              requestId: createRequestId(),
              inputId: createInputId(),
              role: InputRole.User,
              content,
              ...(input.modelSelection === undefined
                ? {}
                : { modelSelection: input.modelSelection }),
              parentInputId: input.atInputId,
            },
          })
        }
        const forked = await eventStore.forkSession({
          sourceSessionId: source.id,
          targetSessionId: sessionId,
          atInputId: input.atInputId,
          expectedSourceSeq: source.seq,
          created: {
            type: EventType.SessionCreated,
            data: compact({
              title: source.title,
              workingDirectory: source.workingDirectory,
              mateId: source.mateId,
              mateRevisionId: source.mateRevisionId,
              conversationId: source.conversationId,
              parentSessionId: source.id,
              forkedFromInputId: input.atInputId,
              forkReason: input.reason,
              metadata: source.metadata,
            }),
          },
          ...(initialEvents.length === 0 ? {} : { initialEvents }),
        })
        return {
          sessionId,
          historyEndSeqExclusive: forked.historyEndSeqExclusive,
          session: forked.projection,
          events: forked.events,
          localEvents: forked.localEvents,
          sourceEvents,
        }
      })
    },

    async listSessions(input = {}) {
      return eventStore.listSessions(input)
    },

    async readSession(input) {
      const session = await eventStore.readProjection(input.sessionId)
      return session ? { session } : {}
    },

    deleteSession(input) {
      return command(input.sessionId, async () => {
        const session = await requireSession(eventStore, input.sessionId)
        if (session.activeTurn !== undefined)
          invalidState(
            `Session ${session.id} has an active turn; cancel it before deleting the session.`,
          )
        if (session.pendingInputs.length > 0)
          invalidState(
            `Session ${session.id} has queued inputs; cancel its queued inputs before deleting the session.`,
          )
        await eventStore.deleteConversation(session.conversationId)
        return { sessionId: input.sessionId }
      })
    },

    async readEvents(input) {
      const limit = input.limit
      if (
        limit !== undefined &&
        (!Number.isInteger(limit) || limit <= 0 || limit > 1_000)
      ) {
        invalidArgument("Event page limit must be an integer from 1 to 1000.")
      }
      if (
        input.through !== undefined &&
        (!Number.isInteger(input.through) || input.through < 0)
      ) {
        invalidArgument("Event replay boundary must be a non-negative integer.")
      }
      const events = await eventStore.readEvents(input.sessionId, {
        after: input.after ?? 0,
        ...(input.through === undefined ? {} : { through: input.through }),
        ...(limit === undefined ? {} : { limit: limit + 1 }),
      })
      const page = limit === undefined ? events : events.slice(0, limit)
      const last = page.at(-1)
      return {
        events: page,
        ...(limit !== undefined && events.length > limit && last !== undefined
          ? { nextAfter: last.seq }
          : {}),
      }
    },

    async replaySession(input) {
      const rebuilt = await eventStore.rebuildProjection(input.sessionId)
      return rebuilt.projection
        ? { events: rebuilt.events, session: rebuilt.projection }
        : { events: rebuilt.events }
    },

    admitInput(input) {
      return command(input.sessionId, async () => {
        const session = await requireSession(eventStore, input.sessionId)
        if (input.parentInputId !== undefined)
          requireInputParent(session, input.parentInputId)
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
              modelSelection: input.modelSelection,
              parentInputId: input.parentInputId,
              metadata: input.metadata,
            }),
          },
          {
            expectedSeq: session.seq,
            admission: {
              requestId,
              fingerprint: fingerprintInputAdmission({
                role: input.role ?? InputRole.User,
                content: input.content,
                modelSelection: input.modelSelection,
                parentInputId: input.parentInputId,
                metadata: input.metadata,
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
        const events = await appendMany(eventStore, session, [
          {
            type: HistoryRecordType.TurnContext,
            data: { turnId, context: input.executionContext },
          },
          {
            type: EventType.TurnStarted,
            data: compact({
              turnId,
              inputId: input.inputId,
              parentTurnId: input.parentTurnId,
              metadata: input.metadata,
            }),
          },
        ])
        return { turnId, events }
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
        const assistantEvents =
          messageId === undefined
            ? []
            : assistantExecutionEvents({
                turnId: input.turnId,
                messageId,
                content,
                ...(input.providerMetadata === undefined
                  ? {}
                  : { providerMetadata: input.providerMetadata }),
              })
        const events: KernelFact[] = [
          ...assistantEvents,
          ...callRows.map(
            (row): KernelFact => ({
              type: EventType.ItemStarted,
              data: {
                turnId: input.turnId,
                item: {
                  ...(row.call.execution ?? {
                    type: "dynamic_tool_call" as const,
                  }),
                  itemId: row.itemId,
                  toolCallId: row.call.id,
                  name: row.call.name,
                  input: row.call.input,
                  requiresPermission: row.call.requiresPermission,
                },
              },
            }),
          ),
        ]
        if (events.length === 0)
          invalidArgument("Assistant output has no facts to record.")
        const envelopes = await appendMany(eventStore, session, events)
        return {
          ...(messageId === undefined ? {} : { messageId }),
          toolCalls: callRows.map((row, index) => ({
            toolCallId: row.call.id,
            itemId: row.itemId,
            event: requireEnvelope(envelopes[assistantEvents.length + index]),
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
        const execution = input.execution ?? executionDescriptor(tool.execution)
        requireCompatibleExecution(tool.execution, execution)
        const event = await append(eventStore, session, {
          type: EventType.ItemCompleted,
          data: {
            turnId: input.turnId,
            item: {
              ...execution,
              itemId: tool.requestItemId,
              toolCallId: tool.toolCallId,
              name: tool.name,
              input: tool.input,
              requiresPermission: tool.requiresPermission,
              resultItemId: itemId,
              content: input.content,
              ...(input.output === undefined ? {} : { output: input.output }),
              ...(input.error === undefined ? {} : { error: input.error }),
            },
          },
        })
        return { itemId, event, events: [event] }
      })
    },

    recordProviderUsageBaseline(input) {
      return command(input.sessionId, async () => {
        const session = await requireSession(eventStore, input.sessionId)
        requireActiveTurn(session, input.turnId)
        const event = await append(eventStore, session, {
          type: HistoryRecordType.ProviderUsageBaseline,
          data: {
            turnId: input.turnId,
            modelCallId: input.modelCallId,
            baseline: input.baseline,
          },
        })
        return { event }
      })
    },

    recordCompaction(input) {
      return command(input.sessionId, async () => {
        const session = await requireSession(eventStore, input.sessionId)
        requireActiveTurn(session, input.turnId)
        const currentCompactionId = session.compaction?.compactionId ?? null
        if (currentCompactionId !== input.expectedCompactionId) {
          invalidState(
            `Compaction checkpoint changed while Turn ${input.turnId} was summarizing.`,
          )
        }
        if (input.throughSeq !== session.seq) {
          invalidState(
            `Session history changed while Turn ${input.turnId} was summarizing (expected seq ${String(input.throughSeq)}, current seq ${String(session.seq)}).`,
          )
        }
        const previousCompaction = session.compaction
        if (
          previousCompaction !== undefined &&
          (input.throughSeq < previousCompaction.throughSeq ||
            input.coveredTurnIds.length <
              previousCompaction.coveredTurnIds.length ||
            previousCompaction.coveredTurnIds.some(
              (turnId, index) => input.coveredTurnIds[index] !== turnId,
            ))
        ) {
          invalidArgument(
            "A compaction checkpoint cannot regress its previous history coverage.",
          )
        }
        requireContinuousCompactionCoverage(session, input.coveredTurnIds)
        const compactionId = createCompactionId()
        const previousReplacement = session.compaction?.replacement
        const inheritedWindow = input.replacement.replacesInheritedContext
          ? session.inheritedContext
          : undefined
        const windowId = createContextWindowId()
        const previousWindowId =
          previousReplacement?.windowId ?? inheritedWindow?.windowId
        const replacement: ContextWindowReplacement = {
          windowId,
          firstWindowId:
            previousReplacement?.firstWindowId ??
            inheritedWindow?.windowId ??
            windowId,
          ...(previousWindowId === undefined ? {} : { previousWindowId }),
          windowNumber:
            (previousReplacement?.windowNumber ??
              (inheritedWindow === undefined ? 0 : 1)) + 1,
          ...(input.replacement.replacesInheritedContext === undefined
            ? {}
            : {
                replacesInheritedContext:
                  input.replacement.replacesInheritedContext,
              }),
          history: input.replacement.history,
          worldStateBaseline: input.replacement.worldStateBaseline,
        }
        const event = await append(eventStore, session, {
          type: EventType.ContextCompacted,
          data: compact({
            compactionId,
            turnId: input.turnId,
            throughSeq: input.throughSeq,
            coveredTurnIds: [...input.coveredTurnIds],
            summary: input.summary,
            usage: input.usage,
            replacement,
          }),
        })
        return { compactionId, event }
      })
    },

    recordWorldStateUpdate(input) {
      return command(input.sessionId, async () => {
        const session = await requireSession(eventStore, input.sessionId)
        const turn = requireActiveTurn(session, input.turnId)
        if (
          input.afterItemId !== undefined &&
          !turn.itemIds.includes(input.afterItemId)
        ) {
          invalidArgument(
            `World-state anchor ${input.afterItemId} does not belong to active Turn ${input.turnId}.`,
          )
        }
        const event = await append(eventStore, session, {
          type: HistoryRecordType.WorldState,
          data: compact({
            turnId: input.turnId,
            afterItemId: input.afterItemId,
            full: input.full,
            state: input.state,
            fragments: [...input.fragments],
          }),
        })
        return { event }
      })
    },

    completeTurn(input) {
      return terminal(command, eventStore, input.sessionId, input.turnId, {
        type: EventType.TurnCompleted,
        data: compact({
          turnId: input.turnId,
          outcome: { status: "completed" as const },
          usage: input.usage,
          metrics: input.metrics,
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
          ...assistantExecutionEvents({
            turnId: input.turnId,
            messageId: itemId,
            content: input.content,
            ...(input.providerMetadata === undefined
              ? {}
              : { providerMetadata: input.providerMetadata }),
          }),
          {
            type: EventType.TurnCompleted,
            data: compact({
              turnId: input.turnId,
              outcome: { status: "completed" as const },
              usage: input.usage,
              metrics: input.metrics,
              metadata: input.metadata,
            }),
          },
        ])
        return { itemId, event: requireLast(events), events }
      })
    },

    failTurn(input) {
      return terminal(command, eventStore, input.sessionId, input.turnId, {
        type: EventType.TurnCompleted,
        data: compact({
          turnId: input.turnId,
          outcome: { status: "failed" as const, error: input.error },
          usage: input.usage,
          metrics: input.metrics,
        }),
      })
    },

    cancelTurn(input) {
      return terminal(command, eventStore, input.sessionId, input.turnId, {
        type: EventType.TurnCompleted,
        data: compact({
          turnId: input.turnId,
          outcome: compact({
            status: "cancelled" as const,
            reason: input.reason,
          }),
          usage: input.usage,
          metrics: input.metrics,
        }),
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
          type: EventType.TurnCompleted,
          data: compact({
            turnId: input.turnId,
            outcome: compact({
              status: "interrupted" as const,
              reason: input.reason,
            }),
            usage: input.usage,
            metrics: input.metrics,
          }),
        })
        return { event, events: [event], created: true }
      })
    },
  }
}

function requireCompatibleExecution(
  startedItem: SessionProjection["tools"][number]["execution"],
  completed: ToolExecutionDescriptor,
): void {
  const started = executionDescriptor(startedItem)
  if (started.type !== completed.type) {
    invalidArgument(
      `Tool execution type changed from ${started.type} to ${completed.type}.`,
    )
  }
  if (toolExecutionDescriptorsCompatible(started, completed)) return
  invalidArgument("Tool execution semantics changed after the tool started.")
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
  event: KernelFact,
) {
  return eventStore.appendEvent(session.id, event, { expectedSeq: session.seq })
}

function appendMany(
  eventStore: EventStore,
  session: SessionProjection,
  events: readonly KernelFact[],
) {
  return eventStore.appendEvents(session.id, events, {
    expectedSeq: session.seq,
    atomic: true,
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

function requireInputParent(session: SessionProjection, inputId: string): void {
  if (session.forkedFromInputId === inputId) return
  requireInput(session, inputId)
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

function requireContinuousCompactionCoverage(
  session: SessionProjection,
  coveredTurnIds: readonly string[],
): void {
  const userInputIds = new Set(
    session.inputs
      .filter((input) => input.role === InputRole.User)
      .map((input) => input.inputId),
  )
  const eligibleTurnIds = session.turns
    .filter(
      (turn) =>
        turn.state !== TurnState.Started && userInputIds.has(turn.inputId),
    )
    .map((turn) => turn.turnId)
  const expected = eligibleTurnIds.slice(0, coveredTurnIds.length)
  if (
    expected.length !== coveredTurnIds.length ||
    expected.some((turnId, index) => turnId !== coveredTurnIds[index])
  ) {
    invalidArgument(
      "Compaction coverage must be a continuous prefix of terminal user Turns.",
      { coveredTurnIds, expectedTurnIds: expected },
    )
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

function assistantExecutionEvents(input: {
  readonly turnId: string
  readonly messageId: string
  readonly content: readonly AssistantContentBlock[]
  readonly providerMetadata?: EventMetadata
}): KernelFact[] {
  const streamId =
    typeof input.providerMetadata?.streamId === "string"
      ? input.providerMetadata.streamId
      : undefined
  const reasoning = input.content.filter(
    (block): block is Extract<AssistantContentBlock, { type: "reasoning" }> =>
      block.type === "reasoning",
  )
  const text = input.content.filter(
    (block): block is Extract<AssistantContentBlock, { type: "text" }> =>
      block.type === "text",
  )
  return [
    ...reasoning.map(
      (block): KernelFact => ({
        type: EventType.ItemCompleted,
        data: {
          turnId: input.turnId,
          item: {
            type: "reasoning",
            itemId: createItemId(),
            text: block.text,
            ...(streamId === undefined ? {} : { streamId }),
            ...(block.providerMetadata === undefined
              ? {}
              : { providerMetadata: block.providerMetadata }),
          },
        },
      }),
    ),
    ...(text.length === 0
      ? []
      : [
          {
            type: EventType.ItemCompleted,
            data: {
              turnId: input.turnId,
              item: {
                type: "agent_message" as const,
                itemId: input.messageId,
                content: text,
                ...(streamId === undefined ? {} : { streamId }),
                ...(input.providerMetadata === undefined
                  ? {}
                  : { providerMetadata: input.providerMetadata }),
              },
            },
          } satisfies KernelFact,
        ]),
  ]
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
