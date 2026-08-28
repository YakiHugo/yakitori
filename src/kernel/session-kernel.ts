import { createYakitoriError, YakitoriErrorCode } from "./errors.ts"
import type { EventStore } from "./event-store.ts"
import {
  type AssistantContentBlock,
  type ContextCompactionCompletedItem,
  type ContextWindowReplacement,
  type EventEnvelope,
  type EventMetadata,
  EventType,
  HistoryRecordType,
  type ForkReason,
  InputRole,
  type ItemContent,
  ItemKind,
  ItemStatus,
  MISSING_TOOL_RESULT_TEXT,
  type JsonObject,
  type JsonValue,
  type KernelError,
  type KernelEvent,
  type KernelFact,
  type ModelMessage,
  type ModelSelection,
  type ProviderUsageBaseline,
  type SessionConfigurationSnapshot,
  type StoredEventEnvelope,
  type StreamedStartedItem,
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
  createRequestId,
  createSessionId,
  createTurnId,
  isRequestId,
} from "./ids.ts"
import { fingerprintInputAdmission } from "./operation.ts"
import {
  type InputProjection,
  InputState,
  type ItemProjection,
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
  recordToolResult(
    input: RecordToolResultInput,
  ): Promise<RecordToolResultResult>
  startItem(input: StartItemInput): Promise<StartItemResult>
  completeItem(input: CompleteItemInput): Promise<CompleteItemResult>
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
  readonly streamedItemIds?: StreamedItemIds
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
// Ids assigned to live display items while the model streamed. A matching
// durable completion reuses the id, but does not require a durable start.
export type StreamedItemIds = {
  readonly messageItemId?: string
  readonly reasoningItemId?: string
}
export type StartItemInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly item: StreamedStartedItem
}
export type StartItemResult = { readonly event: EventEnvelope }
export type CompleteItemInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly item: ContextCompactionCompletedItem
}
export type CompleteItemResult = { readonly event: EventEnvelope }
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
  /** Opened via startItem; closes atomically with the checkpoint. */
  readonly compactionItemId?: string
}
export type RecordCompactionResult = {
  readonly compactionId: string
  readonly event: EventEnvelope
  readonly events: readonly EventEnvelope[]
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
  readonly streamedItemIds?: StreamedItemIds
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
  /** Persist an exact user-role context marker for an intentional abort. */
  readonly recordModelMarker?: boolean
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
        requireUnusedStreamedItemIds(session, input.streamedItemIds)
        const content = input.content ?? []
        const messageId =
          input.streamedItemIds?.messageItemId ??
          (content.some((block) => block.type === "text")
            ? createItemId()
            : undefined)
        const callRows = (input.toolCalls ?? []).map((call) => ({
          call,
          itemId: createItemId(),
        }))
        for (const row of callRows) {
          if (session.tools.some((tool) => tool.toolCallId === row.call.id)) {
            invalidState(`Tool call ${row.call.id} already exists.`)
          }
        }
        const assistantEvents = assistantExecutionEvents({
          turnId: input.turnId,
          content,
          ...(input.providerMetadata === undefined
            ? {}
            : { providerMetadata: input.providerMetadata }),
          ...(messageId === undefined
            ? {}
            : {
                messageItemId: messageId,
              }),
          ...(input.streamedItemIds?.reasoningItemId === undefined
            ? {}
            : {
                reasoningItemId: input.streamedItemIds.reasoningItemId,
              }),
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

    startItem(input) {
      return command(input.sessionId, async () => {
        const session = await requireSession(eventStore, input.sessionId)
        requireActiveTurn(session, input.turnId)
        if (session.items.some((item) => item.itemId === input.item.itemId)) {
          invalidState(`Item ${input.item.itemId} already exists.`)
        }
        const event = await append(eventStore, session, {
          type: EventType.ItemStarted,
          data: { turnId: input.turnId, item: input.item },
        })
        return { event }
      })
    },

    completeItem(input) {
      return command(input.sessionId, async () => {
        const session = await requireSession(eventStore, input.sessionId)
        requireActiveTurn(session, input.turnId)
        requireOpenDisplayItem(
          session,
          input.turnId,
          input.item.itemId,
          ItemKind.ContextCompaction,
        )
        const event = await append(eventStore, session, {
          type: EventType.ItemCompleted,
          data: { turnId: input.turnId, item: input.item },
        })
        return { event }
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
        const facts: KernelFact[] = [
          {
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
          },
          ...(input.compactionItemId === undefined
            ? []
            : [
                {
                  type: EventType.ItemCompleted,
                  data: {
                    turnId: input.turnId,
                    item: {
                      type: "context_compaction" as const,
                      itemId: input.compactionItemId,
                      status: ItemStatus.Completed,
                    },
                  },
                } satisfies KernelFact,
              ]),
        ]
        const envelopes = await appendMany(eventStore, session, facts)
        return {
          compactionId,
          event: requireEnvelope(envelopes[0]),
          events: envelopes,
        }
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
        requireUnusedStreamedItemIds(session, input.streamedItemIds)
        const itemId = input.streamedItemIds?.messageItemId ?? createItemId()
        const events = await appendMany(eventStore, session, [
          ...assistantExecutionEvents({
            turnId: input.turnId,
            messageItemId: itemId,
            ...(input.streamedItemIds?.reasoningItemId === undefined
              ? {}
              : {
                  reasoningItemId: input.streamedItemIds.reasoningItemId,
                }),
            content: input.content,
            ...(input.providerMetadata === undefined
              ? {}
              : { providerMetadata: input.providerMetadata }),
          }),
          {
            type: EventType.TurnCompleted,
            data: withSessionUsage(
              session,
              compact({
                turnId: input.turnId,
                outcome: { status: "completed" as const },
                usage: input.usage,
                metrics: input.metrics,
                metadata: input.metadata,
              }),
            ),
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
        const facts: KernelFact[] = [
          ...(input.recordModelMarker === true
            ? [
                {
                  type: HistoryRecordType.TurnAborted,
                  data: {
                    turnId: input.turnId,
                    message: {
                      role: "user" as const,
                      content: [
                        {
                          type: "text" as const,
                          text: "<turn_aborted>\nThe user interrupted the previous turn on purpose. In-progress tool calls may have partially executed; inspect the current state before retrying.\n</turn_aborted>",
                        },
                      ],
                    },
                  },
                } satisfies KernelFact,
              ]
            : []),
          ...openItemDispositionFacts(session, input.turnId, true),
          {
            type: EventType.TurnCompleted,
            data: withSessionUsage(
              session,
              compact({
                turnId: input.turnId,
                outcome: compact({
                  status: "interrupted" as const,
                  reason: input.reason,
                }),
                usage: input.usage,
                metrics: input.metrics,
              }),
            ),
          },
        ]
        const events = await appendMany(eventStore, session, facts)
        return {
          event: requireLast(events),
          events,
          created: true,
        }
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
    const facts: KernelFact[] = [
      ...openItemDispositionFacts(
        session,
        turnId,
        fact.type === EventType.TurnCompleted &&
          fact.data.outcome.status !== "completed",
      ),
      fact.type === EventType.TurnCompleted
        ? { ...fact, data: withSessionUsage(session, fact.data) }
        : fact,
    ]
    const events = await appendMany(eventStore, session, facts)
    return { event: requireLast(events), events } as unknown as T
  })
}

function withSessionUsage(
  session: SessionProjection,
  data: Extract<KernelEvent, { type: "turn.completed" }>["data"],
): Extract<KernelEvent, { type: "turn.completed" }>["data"] {
  const sessionUsage = addTokenUsage(session.usage, data.usage)
  return compact({ ...data, sessionUsage })
}

function addTokenUsage(
  previous: TokenUsage | undefined,
  current: TokenUsage | undefined,
): TokenUsage | undefined {
  if (previous === undefined && current === undefined) return undefined
  return {
    inputTokens: (previous?.inputTokens ?? 0) + (current?.inputTokens ?? 0),
    outputTokens: (previous?.outputTokens ?? 0) + (current?.outputTokens ?? 0),
    ...((previous?.cacheReadInputTokens ?? 0) +
      (current?.cacheReadInputTokens ?? 0) ===
    0
      ? {}
      : {
          cacheReadInputTokens:
            (previous?.cacheReadInputTokens ?? 0) +
            (current?.cacheReadInputTokens ?? 0),
        }),
    ...((previous?.cacheWriteInputTokens ?? 0) +
      (current?.cacheWriteInputTokens ?? 0) ===
    0
      ? {}
      : {
          cacheWriteInputTokens:
            (previous?.cacheWriteInputTokens ?? 0) +
            (current?.cacheWriteInputTokens ?? 0),
        }),
  }
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

function requireOpenDisplayItem(
  session: SessionProjection,
  turnId: string,
  itemId: string,
  kind: ItemProjection["kind"],
): ItemProjection {
  const item = session.items.find((candidate) => candidate.itemId === itemId)
  if (
    item === undefined ||
    item.turnId !== turnId ||
    item.kind !== kind ||
    item.status !== ItemStatus.InProgress
  ) {
    invalidState(`Item ${itemId} has no matching in-progress start.`, {
      itemId,
      turnId,
      kind,
    })
  }
  return item
}

function openItemDispositionFacts(
  session: SessionProjection,
  turnId: string,
  closeTools: boolean,
): KernelFact[] {
  const facts: KernelFact[] = []
  for (const item of session.items) {
    if (item.turnId !== turnId || item.status !== ItemStatus.InProgress) {
      continue
    }
    if (item.kind === ItemKind.ContextCompaction) {
      facts.push({
        type: EventType.ItemCompleted,
        data: {
          turnId,
          item: {
            type: "context_compaction",
            itemId: item.itemId,
            status: ItemStatus.Failed,
            error: { message: "Turn ended before compaction finished." },
          },
        },
      })
    }
  }
  if (!closeTools) return facts
  for (const tool of session.tools) {
    if (tool.turnId !== turnId || tool.state !== ToolState.Requested) continue
    const execution = executionDescriptor(tool.execution)
    facts.push({
      type: EventType.ItemCompleted,
      data: {
        turnId,
        item: {
          ...execution,
          itemId: tool.requestItemId,
          toolCallId: tool.toolCallId,
          name: tool.name,
          input: tool.input,
          requiresPermission: tool.requiresPermission,
          resultItemId: createItemId(),
          content: { kind: "text", text: MISSING_TOOL_RESULT_TEXT },
          error: { message: MISSING_TOOL_RESULT_TEXT },
        },
      },
    })
  }
  return facts
}

function requireUnusedStreamedItemIds(
  session: SessionProjection,
  streamedItemIds: StreamedItemIds | undefined,
): void {
  const ids = [
    streamedItemIds?.messageItemId,
    streamedItemIds?.reasoningItemId,
  ].filter((itemId): itemId is string => itemId !== undefined)
  if (new Set(ids).size !== ids.length) {
    invalidState("Live display item ids must be distinct.")
  }
  const reused = ids.find((itemId) =>
    session.items.some((item) => item.itemId === itemId),
  )
  if (reused !== undefined) {
    invalidState(`Item ${reused} is already recorded.`)
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

// Assistant and reasoning completions are self-contained durable facts. Their
// ids may correlate with transient display items, but no durable start exists.
function assistantExecutionEvents(input: {
  readonly turnId: string
  readonly messageItemId?: string
  readonly reasoningItemId?: string
  readonly content: readonly AssistantContentBlock[]
  readonly providerMetadata?: EventMetadata
}): KernelFact[] {
  const reasoning = input.content.filter(
    (block): block is Extract<AssistantContentBlock, { type: "reasoning" }> =>
      block.type === "reasoning",
  )
  const text = input.content.filter(
    (block): block is Extract<AssistantContentBlock, { type: "text" }> =>
      block.type === "text",
  )
  const events: KernelFact[] = []
  reasoning.forEach((block, index) => {
    const reused = index === 0 ? input.reasoningItemId : undefined
    const itemId = reused ?? createItemId()
    events.push({
      type: EventType.ItemCompleted,
      data: {
        turnId: input.turnId,
        item: {
          type: "reasoning",
          itemId,
          text: block.text,
          ...(block.providerMetadata === undefined
            ? {}
            : { providerMetadata: block.providerMetadata }),
        },
      },
    })
  })
  if (text.length > 0) {
    const itemId = input.messageItemId ?? createItemId()
    events.push({
      type: EventType.ItemCompleted,
      data: {
        turnId: input.turnId,
        item: {
          type: "agent_message",
          itemId,
          content: text,
          ...(input.providerMetadata === undefined
            ? {}
            : { providerMetadata: input.providerMetadata }),
        },
      },
    })
  }
  return events
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
