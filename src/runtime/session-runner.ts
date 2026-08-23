import {
  type AssistantContentBlock,
  COMPACT_DIRECTIVE,
  createYakitoriError,
  type EventEnvelope,
  type EventMetadata,
  type InputProjection,
  InputRole,
  ItemKind,
  isJsonValue,
  isKernelEvent,
  type JsonObject,
  type KernelError,
  type ModelSelection,
  PermissionBehavior,
  PermissionState,
  type SessionFiles,
  type SessionKernel,
  type SessionProjection,
  type TokenUsage,
  type RuntimeEventEnvelope,
  type TurnExecutionContext,
  type TurnMetrics,
  TurnState,
  YakitoriErrorCode,
} from "../kernel/index.ts"
import type { MateKernel } from "../mates/index.ts"
import {
  type AgentModelTarget,
  type AgentRunOutcome,
  createAgentControl,
  type ForkTurns,
} from "./agent-control.ts"
import {
  buildCompactionRequest,
  isContextOverflowError,
  runCompaction,
} from "./compaction.ts"
import { isAbortError } from "./errors.ts"
import {
  createRunnerTimingPolicy,
  createSessionExecutionPolicy,
  type RunnerTimingPolicy,
  type SessionExecutionPolicy,
} from "./limits.ts"
import {
  createCoalescingSnapshotPublisher,
  type TransientEventHub,
} from "./live-events.ts"
import {
  type ModelContentBlock,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  ModelStopReason,
  type ModelToolCallBlock,
  type ModelUsage,
  type StreamFn,
} from "./model.ts"
import {
  buildModelContext,
  type CompactionSourceGroup,
  collectUncoveredTurns,
  createCompactionReplacementHistory,
  createForkedModelContext,
  measureModelMessagesBytes,
} from "./model-context.ts"
import { createPermissionGate, type PermissionGate } from "./permission-gate.ts"
import { loadProjectInstructions } from "./project-instructions.ts"
import {
  createTurnContext,
  type ResolvedTurnConfiguration,
  SessionConfiguration,
  type TurnContext,
} from "./session-configuration.ts"
import {
  captureStepContext,
  type StepContext,
  type StepToolPlan,
} from "./step-context.ts"
import { createToolRegistry, type ToolRegistry } from "./tools/registry.ts"
import type {
  RuntimeTool,
  ToolEffect,
  ToolExecutionResult,
} from "./tools/types.ts"
import {
  createVisibleFileObservations,
  grantFromToolOutput,
} from "./tools/visible-file-observations.ts"
import { diffWorldState, type WorldState } from "./world-state.ts"

export type SessionRunnerOptions = {
  readonly kernel: SessionKernel
  readonly mateKernel: MateKernel
  readonly stream: StreamFn
  readonly durableHub?: {
    publish(events: readonly RuntimeEventEnvelope[]): void
  }
  readonly transientHub?: TransientEventHub
  readonly toolRegistry?: ToolRegistry
  readonly permissionGate?: PermissionGate
  readonly provider?: string
  readonly model?: string
  readonly executionPolicy?: SessionExecutionPolicy
  readonly runtimeTiming?: RunnerTimingPolicy
  readonly approvalPolicy?: "auto_file_tools" | "never"
  readonly baseInstructions?: string
  readonly modelContextWindowTokens?: number
  readonly maxAgentDepth?: number
  readonly maxConcurrentAgents?: number
  readonly loadProjectInstructions?: typeof loadProjectInstructions
  readonly now?: () => Date
  readonly onRuntimeError?: (error: unknown) => void
  readonly onContextPrepared?: (diagnostics: ContextPreparedDiagnostics) => void
  readonly sessionFiles?: SessionFiles
}

export type ContextPreparedDiagnostics = Readonly<{
  sessionId: string
  turnId: string
  modelCallId: string
  modelCallIndex: number
  selectedItemIds: readonly string[]
  droppedTurnCount: number
  truncatedToolResultCount: number
  prunedToolResultCount: number
  droppedCompactionCheckpoint: boolean
}>

export type SessionRunner = {
  wake(sessionId: string): Promise<void>
  interrupt(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly reason?: string
  }): Promise<void>
  close(): Promise<void>
}

type LaneState = {
  dirty: boolean
  worker?: Promise<void> | undefined
  activeTurn?: ActiveTurnRuntime | undefined
}

type ActiveTurnRuntime = {
  readonly turnId: string
  readonly abort: AbortController
  readonly telemetry: TurnTelemetry
  forkContext?: ForkContext | undefined
}

type ForkContext = {
  readonly messages: readonly ModelMessage[]
  readonly forkTurnStartIndexes: readonly number[]
  readonly worldState?: JsonObject
}

type TurnTelemetry = {
  readonly usages: ModelUsage[]
  modelCalls: number
  toolCalls: number
  modelDurationMs: number
  toolDurationMs: number
  timeToFirstTokenTotalMs: number
  timeToFirstTokenSamples: number
}

type ConsumedModelResponse = {
  readonly response: ModelResponse
  readonly durationMs: number
  readonly timeToFirstTokenMs: number
}

export function createSessionRunner(
  options: SessionRunnerOptions,
): SessionRunner {
  const executionPolicy =
    options.executionPolicy ?? createSessionExecutionPolicy()
  const runtimeTiming = options.runtimeTiming ?? createRunnerTimingPolicy()
  const provider = options.provider ?? "faux"
  const model = options.model ?? "scripted"
  const toolRegistry = options.toolRegistry ?? createToolRegistry()
  const permissionGate = options.permissionGate ?? createPermissionGate()
  const enabledTools = toolRegistry.tools.map((tool) => tool.name)
  const approvalPolicy = options.approvalPolicy ?? "auto_file_tools"
  const projectInstructionLoader =
    options.loadProjectInstructions ?? loadProjectInstructions
  const lanes = new Map<string, LaneState>()
  // Consecutive compaction failures per session; after the cap the lane
  // stops paying for doomed summary calls until one succeeds again.
  const compactionFailures = new Map<string, number>()
  let closed = false

  const publishDurable = (events: readonly EventEnvelope[]) => {
    const runtimeEvents = events.filter(
      (event): event is RuntimeEventEnvelope => isKernelEvent(event),
    )
    if (runtimeEvents.length === 0) return
    options.durableHub?.publish(runtimeEvents)
  }

  const agentControl = createAgentControl({
    ...(options.maxAgentDepth === undefined
      ? {}
      : { maxDepth: options.maxAgentDepth }),
    ...(options.maxConcurrentAgents === undefined
      ? {}
      : { maxConcurrentAgents: options.maxConcurrentAgents }),
    adapter: {
      createChild: createAgentSession,
      runChild: runAgentChild,
      submitFollowup: submitAgentFollowup,
      interruptChild: interruptAgentTurn,
      captureForkContext,
    },
  })

  async function wake(sessionId: string): Promise<void> {
    if (closed) {
      throw createYakitoriError({
        code: YakitoriErrorCode.InvalidState,
        message: "SessionRunner is closed.",
      })
    }

    const lane = lanes.get(sessionId) ?? { dirty: false }
    lane.dirty = true
    lanes.set(sessionId, lane)
    ensureWorker(sessionId)

    // Wait until this session is idle (no worker and not dirty).
    for (;;) {
      const current = lanes.get(sessionId)
      if (!current) return
      if (current.worker) {
        await current.worker
        continue
      }
      if (current.dirty) {
        ensureWorker(sessionId)
        continue
      }
      return
    }
  }

  function ensureWorker(sessionId: string): void {
    const lane = lanes.get(sessionId)
    if (!lane || lane.worker || closed) return

    const worker = runLane(sessionId)
      .catch((error) => {
        options.onRuntimeError?.(error)
      })
      .finally(() => {
        const current = lanes.get(sessionId)
        if (current?.worker === worker) current.worker = undefined
        if (current?.dirty && !closed) {
          ensureWorker(sessionId)
          return
        }
        if (current && !current.worker && !current.dirty) {
          lanes.delete(sessionId)
        }
      })
    lane.worker = worker
  }

  async function runLane(sessionId: string): Promise<void> {
    for (;;) {
      if (closed) return
      const lane = lanes.get(sessionId)
      if (!lane) return
      lane.dirty = false

      const read = await options.kernel.readSession({ sessionId })
      const session = read.session
      if (!session) return
      if (session.activeTurn) return

      const nextInput = session.pendingInputs[0]
      if (!nextInput) return

      if (closed) return
      await runTurn(session, nextInput)
    }
  }

  async function runTurn(
    session: SessionProjection,
    queuedInput: InputProjection,
  ): Promise<void> {
    if (closed) return
    const turn = await buildTurnContext(session, queuedInput)
    const executionContext = turn.execution
    if (closed) return
    const started = await startTurnUnlessInputConsumed(
      session.id,
      queuedInput.inputId,
      executionContext,
    )
    if (started === undefined) return
    publishDurable(started.events)

    const lane = lanes.get(session.id) ?? { dirty: false }
    const activeTurn: ActiveTurnRuntime = {
      turnId: started.turnId,
      abort: new AbortController(),
      telemetry: createTurnTelemetry(),
    }
    lane.activeTurn = activeTurn
    lanes.set(session.id, lane)

    if (closed) activeTurn.abort.abort()

    try {
      if (isCompactDirectiveInput(queuedInput)) {
        await executeCompactTurn({
          sessionId: session.id,
          turnId: started.turnId,
          inputId: queuedInput.inputId,
          turn,
          executionContext,
          signal: activeTurn.abort.signal,
        })
      } else {
        await executeTextTurn({
          sessionId: session.id,
          turnId: started.turnId,
          inputId: queuedInput.inputId,
          turn,
          signal: activeTurn.abort.signal,
        })
      }
    } catch (error) {
      await failActiveTurn(session.id, started.turnId, error)
    } finally {
      const current = lanes.get(session.id)
      if (current?.activeTurn === activeTurn) current.activeTurn = undefined
    }
  }

  // A queued Input can be cancelled between readSession and startTurn. That
  // race must not kill the lane: skip the consumed Input so the loop picks up
  // the next pending one. Any other InvalidState still propagates.
  async function startTurnUnlessInputConsumed(
    sessionId: string,
    inputId: string,
    executionContext: TurnExecutionContext,
  ) {
    try {
      return await options.kernel.startTurn({
        sessionId,
        inputId,
        executionContext,
      })
    } catch (error) {
      if (!isInvalidState(error)) throw error
      const read = await options.kernel.readSession({ sessionId })
      const stillPending = read.session?.pendingInputs.some(
        (candidate) => candidate.inputId === inputId,
      )
      if (stillPending) throw error
      return undefined
    }
  }

  async function buildTurnContext(
    session: SessionProjection,
    queuedInput: InputProjection,
  ): Promise<TurnContext> {
    if (session.mateId === undefined || session.mateRevisionId === undefined) {
      throw createYakitoriError({
        code: YakitoriErrorCode.InvalidState,
        message: "Session is missing Mate attribution required for execution.",
        details: { sessionId: session.id },
      })
    }
    if (session.workingDirectory === undefined) {
      throw createYakitoriError({
        code: YakitoriErrorCode.InvalidState,
        message: "Session is missing workingDirectory required for execution.",
        details: { sessionId: session.id },
      })
    }

    const mate = await options.mateKernel.readMate({ mateId: session.mateId })
    if (!mate.mate) {
      throw createYakitoriError({
        code: YakitoriErrorCode.NotFound,
        message: `Mate ${session.mateId} was not found.`,
        details: { mateId: session.mateId },
      })
    }
    const revision = mate.mate.revisions.find(
      (candidate) => candidate.id === session.mateRevisionId,
    )
    if (!revision) {
      throw createYakitoriError({
        code: YakitoriErrorCode.NotFound,
        message: `Mate revision ${session.mateRevisionId} was not found.`,
        details: {
          mateId: session.mateId,
          mateRevisionId: session.mateRevisionId,
        },
      })
    }

    const previousTarget = session.turns.at(-1)?.executionContext
    const defaultTarget = session.configuration?.defaultTarget ?? {
      provider,
      model,
    }
    const selectedTarget: ModelSelection =
      queuedInput.modelSelection ??
      (previousTarget === undefined
        ? defaultTarget
        : {
            provider: previousTarget.provider,
            model: previousTarget.model,
            ...(previousTarget.effort === undefined
              ? {}
              : { effort: previousTarget.effort }),
            ...(previousTarget.speed === undefined
              ? {}
              : { speed: previousTarget.speed }),
          })
    let sessionConfiguration =
      session.configuration === undefined
        ? SessionConfiguration.create({
            selection: selectedTarget,
            workspaceRoot: session.workingDirectory,
            enabledTools,
            approvalPolicy,
            promptCacheKey: session.conversationId,
            ...(options.baseInstructions === undefined
              ? {}
              : { baseInstructions: options.baseInstructions }),
            executionPolicy,
            ...(options.modelContextWindowTokens === undefined
              ? {}
              : {
                  modelContextWindowTokens: options.modelContextWindowTokens,
                }),
          })
        : SessionConfiguration.restore(session.configuration)
    if (session.configuration === undefined) {
      const configured = await options.kernel.configureSession({
        sessionId: session.id,
        configuration: sessionConfiguration.snapshot,
      })
      if (configured.event !== undefined) publishDurable([configured.event])
      sessionConfiguration = SessionConfiguration.restore(
        configured.configuration,
      )
    }
    const configuration = sessionConfiguration.resolveTurn(selectedTarget)
    return createTurnContext({
      configuration,
      mateId: session.mateId,
      mateRevisionId: session.mateRevisionId,
    })
  }

  function activeTurnRuntime(
    sessionId: string,
    turnId: string,
  ): ActiveTurnRuntime | undefined {
    const activeTurn = lanes.get(sessionId)?.activeTurn
    return activeTurn?.turnId === turnId ? activeTurn : undefined
  }

  function requireTurnTelemetry(
    sessionId: string,
    turnId: string,
  ): TurnTelemetry {
    const telemetry = activeTurnRuntime(sessionId, turnId)?.telemetry
    if (telemetry !== undefined) return telemetry
    throw new Error(`Turn telemetry for ${turnId} was not initialized.`)
  }

  async function executeTextTurn(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly inputId: string
    readonly turn: TurnContext
    readonly signal: AbortSignal
  }): Promise<void> {
    const executionContext = input.turn.execution
    let modelCallIndex = 0
    let toolCallCount = 0
    const telemetry = requireTurnTelemetry(input.sessionId, input.turnId)
    const usages = telemetry.usages
    while (
      modelCallIndex < executionContext.executionPolicy.modelCallsPerTurn
    ) {
      if (input.signal.aborted) {
        await cancelAfterRuntimeAbort(input.sessionId, input.turnId)
        return
      }

      let session = await requireSession(input.sessionId)
      const agentRuntime = agentControl.runtimeContext(input.sessionId)
      const step = await captureStepContext({
        turn: input.turn,
        session,
        toolRegistry,
        multiAgent: agentRuntime,
        projectInstructionLoader,
        ...(options.now === undefined ? {} : { now: options.now() }),
      })
      session = await recordStepWorldState({
        session,
        turnId: input.turnId,
        step,
      })
      let context = buildModelContext({
        session,
        currentInputId: input.inputId,
        limits: executionContext.executionPolicy,
      })
      if (context.compactableHistory.length > 0) {
        const outcome = await attemptCompaction({
          session,
          turnId: input.turnId,
          configuration: input.turn.configuration,
          candidateHistory: context.compactableHistory,
          worldState: step.worldState,
          usages,
          telemetry,
          signal: input.signal,
        })
        if (outcome === "compacted") {
          session = await requireSession(input.sessionId)
          context = buildModelContext({
            session,
            currentInputId: input.inputId,
            limits: executionContext.executionPolicy,
          })
        }
      }
      if (
        context.droppedTurns.length > 0 ||
        context.droppedCompactionCheckpoint
      ) {
        throw createYakitoriError({
          code: YakitoriErrorCode.InvalidState,
          message:
            "Context compaction could not preserve all model-visible history.",
          details: {
            code: "context_compaction_required",
            droppedTurnCount: context.droppedTurns.length,
            droppedCompactionCheckpoint: context.droppedCompactionCheckpoint,
          },
        })
      }

      const requestMessages = await resolveSessionFileImages(
        [...context.messages, ...agentControl.takeMessages(input.sessionId)],
        options.sessionFiles,
      )
      const activeTurn = activeTurnRuntime(input.sessionId, input.turnId)
      if (activeTurn === undefined) {
        throw new Error(`Turn runtime for ${input.turnId} is no longer active.`)
      }
      activeTurn.forkContext = {
        messages: context.messages,
        forkTurnStartIndexes: context.forkTurnStartIndexes,
        ...(session.worldState === undefined
          ? {}
          : { worldState: session.worldState.state }),
      }
      const request: ModelRequest = {
        target: step.turn.configuration.target,
        cacheKey: step.turn.configuration.promptCacheKey,
        system: [step.turn.configuration.baseInstructions],
        messages: requestMessages,
        tools: step.tools.definitions,
        signal: input.signal,
      }
      const streamId = `stream_${input.turnId}_${modelCallIndex + 1}`
      if (options.onContextPrepared !== undefined) {
        try {
          options.onContextPrepared({
            sessionId: input.sessionId,
            turnId: input.turnId,
            modelCallId: streamId,
            modelCallIndex: modelCallIndex + 1,
            selectedItemIds: [...context.selectedItemIds],
            droppedTurnCount: context.droppedTurnCount,
            truncatedToolResultCount: context.truncatedToolResultCount,
            prunedToolResultCount: context.prunedToolResultCount,
            droppedCompactionCheckpoint: context.droppedCompactionCheckpoint,
          })
        } catch (error) {
          if (options.onRuntimeError === undefined) {
            console.error("Context diagnostics consumer failed.", error)
          } else {
            options.onRuntimeError(error)
          }
        }
      }
      const observationEligibleToolResultItemIds = new Set(
        context.observationEligibleToolResultItemIds,
      )
      const visibleFileObservations = createVisibleFileObservations(
        session.tools.filter(
          (tool) =>
            tool.resultItemId !== undefined &&
            observationEligibleToolResultItemIds.has(tool.resultItemId),
        ),
      )

      const modelStartedAt = Date.now()
      let consumed: ConsumedModelResponse
      try {
        consumed = await consumeModelStream({
          sessionId: input.sessionId,
          turnId: input.turnId,
          streamId,
          request,
          assistantResponseBytes:
            executionContext.executionPolicy.assistantResponseBytes,
        })
      } catch (error) {
        telemetry.modelCalls += 1
        telemetry.modelDurationMs += Date.now() - modelStartedAt
        throw error
      }
      recordModelCall(telemetry, consumed)
      const response = consumed.response
      modelCallIndex += 1
      if (response.usage !== undefined) usages.push(response.usage)

      if (
        response.stopReason === ModelStopReason.Aborted ||
        input.signal.aborted
      ) {
        await cancelAfterRuntimeAbort(input.sessionId, input.turnId)
        return
      }

      if (response.stopReason === ModelStopReason.Length) {
        await failTurnWithCode(
          input.sessionId,
          input.turnId,
          "model_length",
          "Model response was truncated by length.",
        )
        return
      }

      if (response.stopReason === ModelStopReason.Error) {
        await failTurnWithCode(
          input.sessionId,
          input.turnId,
          response.error?.code ?? "model_error",
          response.error?.message ?? "Model returned an error.",
        )
        return
      }

      const toolCalls = response.content.filter(
        (block): block is ModelToolCallBlock => block.type === "tool_call",
      )

      if (response.stopReason === ModelStopReason.ToolUse) {
        if (toolCalls.length === 0) {
          await failTurnWithCode(
            input.sessionId,
            input.turnId,
            "provider_protocol_error",
            "tool_use stop reason requires at least one complete tool call.",
          )
          return
        }
        const content = assistantContent(response.content)
        if (
          assistantContentBytes(content) >
          executionContext.executionPolicy.assistantResponseBytes
        ) {
          await failTurnWithCode(
            input.sessionId,
            input.turnId,
            "assistant_output_too_large",
            "Assistant response exceeded the configured byte limit.",
          )
          return
        }
        if (
          toolCallCount + toolCalls.length >
          executionContext.executionPolicy.toolCallsPerTurn
        ) {
          await failTurnWithCode(
            input.sessionId,
            input.turnId,
            "tool_budget_exhausted",
            `Turn exceeded tool call budget of ${executionContext.executionPolicy.toolCallsPerTurn}.`,
          )
          return
        }
        toolCallCount += toolCalls.length
        const toolStartedAt = Date.now()
        try {
          await persistAssistantAndExecuteTools({
            sessionId: input.sessionId,
            turnId: input.turnId,
            content,
            toolCalls,
            streamId,
            modelCallIndex,
            executionContext,
            toolPlan: step.tools,
            workspaceRoot: step.workspaceRoot,
            ...(response.providerRequestId === undefined
              ? {}
              : { providerRequestId: response.providerRequestId }),
            signal: input.signal,
            visibleFileObservations,
          })
        } finally {
          telemetry.toolCalls += toolCalls.length
          telemetry.toolDurationMs += Date.now() - toolStartedAt
        }
        continue
      }

      if (toolCalls.length > 0) {
        await failTurnWithCode(
          input.sessionId,
          input.turnId,
          "provider_protocol_error",
          "Non-tool_use responses must not include tool calls.",
        )
        return
      }

      const content = assistantContent(response.content)
      if (
        assistantContentBytes(content) >
        executionContext.executionPolicy.assistantResponseBytes
      ) {
        await failTurnWithCode(
          input.sessionId,
          input.turnId,
          "assistant_output_too_large",
          "Assistant response exceeded the configured byte limit.",
        )
        return
      }

      if (content.length === 0) {
        const usage = aggregateTokenUsage(usages)
        const completed = await options.kernel.completeTurn({
          sessionId: input.sessionId,
          turnId: input.turnId,
          ...(usage === undefined ? {} : { usage }),
          metrics: turnMetrics(telemetry),
        })
        publishDurable([completed.event])
        return
      }

      const usage = aggregateTokenUsage(usages)
      const completed = await options.kernel.completeTurnWithAssistantOutput({
        sessionId: input.sessionId,
        turnId: input.turnId,
        content,
        providerMetadata: {
          provider: executionContext.provider,
          model: executionContext.model,
          callIndex: modelCallIndex,
          streamId,
          ...(response.providerRequestId === undefined
            ? {}
            : { providerRequestId: response.providerRequestId }),
        },
        ...(usage === undefined ? {} : { usage }),
        metrics: turnMetrics(telemetry),
      })
      publishDurable(completed.events)
      return
    }

    await failTurnWithCode(
      input.sessionId,
      input.turnId,
      "model_budget_exhausted",
      `Turn exceeded model call budget of ${executionContext.executionPolicy.modelCallsPerTurn}.`,
    )
  }

  async function recordStepWorldState(input: {
    readonly session: SessionProjection
    readonly turnId: string
    readonly step: StepContext
    readonly forceFull?: boolean
  }): Promise<SessionProjection> {
    const compactionThroughSeq = input.session.compaction?.throughSeq
    const compactionInvalidatedBaseline =
      compactionThroughSeq !== undefined &&
      input.session.compaction?.replacement === undefined &&
      !input.session.worldStateUpdates.some(
        (update) => update.full && update.seq > compactionThroughSeq,
      )
    const diff = diffWorldState(
      input.forceFull || compactionInvalidatedBaseline
        ? undefined
        : input.session.worldState?.state,
      input.step.worldState,
    )
    if (diff === undefined) return input.session

    const afterItemId = input.session.activeTurn?.itemIds.at(-1)
    const updated = await options.kernel.recordWorldStateUpdate({
      sessionId: input.session.id,
      turnId: input.turnId,
      ...(afterItemId === undefined ? {} : { afterItemId }),
      ...diff,
    })
    publishDurable([updated.event])
    return requireSession(input.session.id)
  }

  // Housekeeping: fold the longest fitting continuous history prefix into a
  // durable checkpoint, then rebuild context. An over-long summary request is
  // retried with a shorter oldest prefix (up to
  // MAX_COMPACTION_ATTEMPTS); any other failure leaves the checkpoint
  // unchanged, and repeated failures trip a per-session circuit breaker. The
  // caller may continue only when the unabridged context still fits.
  async function attemptCompaction(input: {
    readonly session: SessionProjection
    readonly turnId: string
    readonly configuration: ResolvedTurnConfiguration
    readonly candidateHistory: readonly CompactionSourceGroup[]
    readonly worldState: WorldState
    readonly usages: ModelUsage[]
    readonly telemetry: TurnTelemetry
    readonly signal: AbortSignal
  }): Promise<"compacted" | "not_smaller" | "failed"> {
    const sessionId = input.session.id
    if (
      (compactionFailures.get(sessionId) ?? 0) >=
      MAX_CONSECUTIVE_COMPACTION_FAILURES
    ) {
      return "failed"
    }
    try {
      let source = selectCompactionSource(
        input.candidateHistory,
        input.configuration.executionPolicy.modelVisibleContextBytes,
      )
      if (source.length === 0) return "failed"
      const throughSeq = input.session.seq
      let result: Awaited<ReturnType<typeof runCompaction>> | undefined
      let attempts = 0
      while (result === undefined) {
        const modelStartedAt = Date.now()
        try {
          result = await runCompaction({
            stream: options.stream,
            request: buildCompactionRequest({
              source,
              target: input.configuration.target,
              baseInstructions: input.configuration.baseInstructions,
              cacheKey: input.configuration.promptCacheKey,
              signal: input.signal,
            }),
          })
        } catch (error) {
          if (input.signal.aborted || isAbortError(error)) throw error
          attempts += 1
          const reduced = reduceCompactionSourcePrefix(source)
          if (
            !isContextOverflowError(error) ||
            attempts >= MAX_COMPACTION_ATTEMPTS ||
            reduced.length === source.length
          ) {
            throw error
          }
          source = reduced
        } finally {
          input.telemetry.modelCalls += 1
          input.telemetry.modelDurationMs += Date.now() - modelStartedAt
        }
      }
      // A checkpoint that is not smaller than the history it replaces buys
      // nothing. This is not a failure: keep history, skip the error log and
      // the circuit breaker, and let callers tell the two outcomes apart.
      const replacement = createCompactionReplacement(
        input.worldState,
        result.summary,
        source.some((group) => group.kind === "inherited"),
      )
      const sourceBytes = measureModelMessagesBytes(
        source.flatMap((group) => group.messages),
      )
      const replacementBytes = measureModelMessagesBytes(
        replacement.history.filter(
          (message) =>
            !(
              (message.role === "user" || message.role === "developer") &&
              message.context?.type === "world_state"
            ),
        ),
      )
      if (replacementBytes >= sourceBytes) {
        return "not_smaller"
      }
      if (
        utf8Bytes(result.summary) >
        input.configuration.executionPolicy.compactionSummaryBytes
      ) {
        throw new Error(
          `Compaction checkpoint exceeds the configured ${input.configuration.executionPolicy.compactionSummaryBytes}-byte limit.`,
        )
      }
      const recorded = await options.kernel.recordCompaction({
        sessionId,
        turnId: input.turnId,
        expectedCompactionId: input.session.compaction?.compactionId ?? null,
        throughSeq,
        coveredTurnIds: [
          ...(input.session.compaction?.coveredTurnIds ?? []),
          ...source.flatMap((group) => group.turnIds),
        ],
        summary: result.summary,
        replacement,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      })
      publishDurable([recorded.event])
      if (result.usage !== undefined) input.usages.push(result.usage)
      compactionFailures.delete(sessionId)
      return "compacted"
    } catch (error) {
      // A user interrupt mid-summary surfaces here as an AbortError; that is
      // the normal abort path, not a compaction failure worth logging.
      if (!input.signal.aborted) {
        compactionFailures.set(
          sessionId,
          (compactionFailures.get(sessionId) ?? 0) + 1,
        )
        console.error("Context compaction failed.", error)
      }
      return "failed"
    }
  }

  // A compact directive Turn is housekeeping, not conversation: fold every
  // uncovered completed Turn into a checkpoint, then close with a short note.
  // The only model call is the summary itself.
  async function executeCompactTurn(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly inputId: string
    readonly turn: TurnContext
    readonly executionContext: TurnExecutionContext
    readonly signal: AbortSignal
  }): Promise<void> {
    let session = await requireSession(input.sessionId)
    const step = await captureStepContext({
      turn: input.turn,
      session,
      toolRegistry,
      multiAgent: agentControl.runtimeContext(input.sessionId),
      projectInstructionLoader,
      ...(options.now === undefined ? {} : { now: options.now() }),
    })
    session = await recordStepWorldState({
      session,
      turnId: input.turnId,
      step,
    })
    const source = collectUncoveredTurns(
      session,
      input.executionContext.executionPolicy,
    )
    const telemetry = requireTurnTelemetry(input.sessionId, input.turnId)
    const usages = telemetry.usages
    let note: string
    if (source.length === 0) {
      note =
        "Nothing to compact: completed history still fits the context budget."
    } else {
      // A manual directive bypasses and resets the failure circuit breaker.
      compactionFailures.delete(input.sessionId)
      const compacted = await attemptCompaction({
        session,
        turnId: input.turnId,
        configuration: input.turn.configuration,
        candidateHistory: source,
        worldState: step.worldState,
        usages,
        telemetry,
        signal: input.signal,
      })
      if (input.signal.aborted) {
        await cancelAfterRuntimeAbort(input.sessionId, input.turnId)
        return
      }
      note =
        compacted === "failed"
          ? "Context compaction failed; the history was kept intact."
          : compacted === "not_smaller"
            ? "The history is already compact enough; summarizing it would not reduce the context."
            : `Compacted ${source.length} turn(s) into a context checkpoint.`
    }
    const usage = aggregateTokenUsage(usages)
    const completed = await options.kernel.completeTurnWithAssistantOutput({
      sessionId: input.sessionId,
      turnId: input.turnId,
      content: [{ type: "text", text: note }],
      providerMetadata: {
        provider: input.executionContext.provider,
        model: input.executionContext.model,
        directive: COMPACT_DIRECTIVE,
      },
      ...(usage === undefined ? {} : { usage }),
      metrics: turnMetrics(telemetry),
    })
    publishDurable(completed.events)
  }

  async function persistAssistantAndExecuteTools(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly content: readonly AssistantContentBlock[]
    readonly toolCalls: readonly ModelToolCallBlock[]
    readonly streamId: string
    readonly modelCallIndex: number
    readonly executionContext: TurnExecutionContext
    readonly toolPlan: StepToolPlan
    readonly workspaceRoot: string
    readonly providerRequestId?: string
    readonly signal: AbortSignal
    readonly visibleFileObservations: ReturnType<
      typeof createVisibleFileObservations
    >
  }): Promise<void> {
    const recorded = await options.kernel.recordAssistantOutput({
      sessionId: input.sessionId,
      turnId: input.turnId,
      ...(input.content.length === 0 ? {} : { content: input.content }),
      providerMetadata: {
        provider: input.executionContext.provider,
        model: input.executionContext.model,
        callIndex: input.modelCallIndex,
        streamId: input.streamId,
        ...(input.providerRequestId === undefined
          ? {}
          : { providerRequestId: input.providerRequestId }),
      },
      toolCalls: input.toolCalls.map((call) => {
        const tool = input.toolPlan.get(call.name)
        return {
          id: call.id,
          name: call.name,
          input: call.input,
          requiresPermission:
            tool !== undefined &&
            !tool.autoAllow &&
            input.executionContext.approvalPolicy !== "never",
        }
      }),
    })
    publishDurable(recorded.events)

    const observations = input.visibleFileObservations
    const firstBarrier = input.toolCalls.findIndex((call) => {
      const tool = input.toolPlan.get(call.name)
      return toolEffect(tool) !== "observe"
    })
    const prefix =
      firstBarrier < 0
        ? input.toolCalls
        : input.toolCalls.slice(0, firstBarrier)
    const rest = firstBarrier < 0 ? [] : input.toolCalls.slice(firstBarrier)

    const prefixOutcomes = await Promise.all(
      prefix.map(async (call) => {
        try {
          return {
            call,
            result: await executeRecordedTool({
              sessionId: input.sessionId,
              turnId: input.turnId,
              call,
              executionContext: input.executionContext,
              toolPlan: input.toolPlan,
              workspaceRoot: input.workspaceRoot,
              signal: input.signal,
              observations,
              record: false,
            }),
          }
        } catch (error) {
          if (isAbortError(error)) {
            return { call, result: "aborted" as const }
          }
          throw error
        }
      }),
    )
    let prefixAborted = input.signal.aborted
    for (const outcome of prefixOutcomes) {
      if (outcome.result === "aborted") {
        prefixAborted = true
        continue
      }
      const recorded = await recordExecutedTool({
        sessionId: input.sessionId,
        turnId: input.turnId,
        call: outcome.call,
        result: outcome.result,
        observations,
      })
      if (recorded === "aborted") prefixAborted = true
    }
    if (prefixAborted || input.signal.aborted) {
      await cancelAfterRuntimeAbort(input.sessionId, input.turnId)
      return
    }

    for (const call of rest) {
      if (input.signal.aborted) {
        await cancelAfterRuntimeAbort(input.sessionId, input.turnId)
        return
      }
      try {
        const result = await executeRecordedTool({
          sessionId: input.sessionId,
          turnId: input.turnId,
          call,
          executionContext: input.executionContext,
          toolPlan: input.toolPlan,
          workspaceRoot: input.workspaceRoot,
          signal: input.signal,
          observations,
          record: true,
        })
        if (result === "aborted") {
          await cancelAfterRuntimeAbort(input.sessionId, input.turnId)
          return
        }
      } catch (error) {
        if (isAbortError(error)) {
          await cancelAfterRuntimeAbort(input.sessionId, input.turnId)
          return
        }
        throw error
      }
    }
  }

  async function executeRecordedTool(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly call: ModelToolCallBlock
    readonly executionContext: TurnExecutionContext
    readonly toolPlan: StepToolPlan
    readonly workspaceRoot: string
    readonly signal: AbortSignal
    readonly observations: ReturnType<typeof createVisibleFileObservations>
    readonly record: boolean
  }): Promise<ToolExecutionResult | "aborted"> {
    // Defense in depth: the model only sees enabledTools definitions, but the
    // persisted Session contract must still hold if a disabled call arrives.
    if (!input.executionContext.enabledTools.includes(input.call.name)) {
      const disabled: ToolExecutionResult = {
        ok: false,
        code: "tool_not_enabled",
        message: `Tool ${input.call.name} is not enabled in this session.`,
        content: `tool_not_enabled: Tool ${input.call.name} is not enabled in this session.`,
      }
      if (input.record) {
        const recorded = await recordExecutedTool({
          sessionId: input.sessionId,
          turnId: input.turnId,
          call: input.call,
          result: disabled,
          observations: input.observations,
        })
        return recorded === "aborted" ? "aborted" : disabled
      }
      return disabled
    }
    const tool = input.toolPlan.get(input.call.name)
    let permissionRequestId: string | undefined
    if (
      tool !== undefined &&
      !tool.autoAllow &&
      input.executionContext.approvalPolicy !== "never"
    ) {
      const command =
        typeof input.call.input === "object" &&
        input.call.input !== null &&
        "command" in input.call.input &&
        typeof (input.call.input as { command: unknown }).command === "string"
          ? (input.call.input as { command: string }).command
          : input.call.name
      const permission = await options.kernel.requestPermission({
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolCallId: input.call.id,
        action: input.call.name,
        subject: command,
        reason:
          "Command runs with the host user's filesystem, process, environment, and network authority.",
      })
      publishDurable([permission.event])
      permissionRequestId = permission.permissionRequestId
    }

    if (permissionRequestId !== undefined) {
      const allowed = await waitForPermissionAllow({
        sessionId: input.sessionId,
        turnId: input.turnId,
        permissionRequestId,
        signal: input.signal,
      })
      if (!allowed.ok) {
        const denied: ToolExecutionResult = {
          ok: false,
          code: allowed.kind,
          message: allowed.message,
          content: allowed.message,
        }
        if (input.record) {
          const recorded = await recordExecutedTool({
            sessionId: input.sessionId,
            turnId: input.turnId,
            call: input.call,
            result: denied,
            observations: input.observations,
          })
          return recorded === "aborted" ? "aborted" : denied
        }
        return denied
      }
    }

    await options.kernel.requireToolExecutionAllowed({
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolCallId: input.call.id,
    })

    const result = await input.toolPlan.execute(
      input.call.name,
      input.call.input,
      {
        workspaceRoot: input.workspaceRoot,
        sessionId: input.sessionId,
        toolCallId: input.call.id,
        ...(options.sessionFiles === undefined
          ? {}
          : { sessionFiles: options.sessionFiles }),
        signal: input.signal,
        visibleFileObservations: input.observations,
        agentControl: agentControl.bind(
          input.sessionId,
          turnTarget(input.executionContext),
        ),
      },
    )
    if (!input.record) return result
    const recorded = await recordExecutedTool({
      sessionId: input.sessionId,
      turnId: input.turnId,
      call: input.call,
      result,
      observations: input.observations,
    })
    return recorded === "aborted" ? "aborted" : result
  }

  async function resolveSessionFileImages(
    messages: readonly ModelMessage[],
    sessionFiles: SessionFiles | undefined,
  ): Promise<readonly ModelMessage[]> {
    return Promise.all(
      messages.map(async (message): Promise<ModelMessage> => {
        if (message.role !== "user" || message.images === undefined)
          return message
        const images = await Promise.all(
          message.images.map(async (image) => {
            if ("data" in image && image.data !== undefined) return image
            if (sessionFiles === undefined) {
              throw new Error("Session image storage is unavailable.")
            }
            const bytes = await sessionFiles.read(image.file)
            if (bytes.byteLength !== image.sizeBytes) {
              throw new Error(
                "Session image size does not match its recorded size.",
              )
            }
            return {
              type: "image" as const,
              mediaType: image.mediaType,
              data: bytes.toString("base64"),
            }
          }),
        )
        return { ...message, images }
      }),
    )
  }

  async function recordExecutedTool(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly call: ModelToolCallBlock
    readonly result: ToolExecutionResult
    readonly observations: ReturnType<typeof createVisibleFileObservations>
  }): Promise<"ok" | "aborted"> {
    if (input.result.ok) {
      const resolved = await options.kernel.recordToolResult({
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolCallId: input.call.id,
        output: input.result.output,
        content: { kind: "text", text: input.result.content },
      })
      publishDurable(resolved.events)
      const grant = grantFromToolOutput(input.call.name, input.result.output)
      if (grant?.kind === "edit" || grant?.kind === "write") {
        input.observations.apply(grant)
      }
      return "ok"
    }

    const resolved = await options.kernel.recordToolResult({
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolCallId: input.call.id,
      ...(input.result.output === undefined
        ? {}
        : { output: input.result.output }),
      error: {
        code: input.result.code,
        message: input.result.message,
      },
      content: { kind: "text", text: input.result.content },
    })
    publishDurable(resolved.events)
    return input.result.code === "aborted" ? "aborted" : "ok"
  }

  async function createAgentSession(input: {
    readonly parentSessionId: string
    readonly rootSessionId: string
    readonly taskName: string
    readonly path: string
    readonly agentType: "general" | "explore"
    readonly depth: number
    readonly message: string
    readonly target: AgentModelTarget
    readonly forkedContext?: ReturnType<typeof createForkedModelContext>
  }): Promise<string> {
    const parent = await requireSession(input.parentSessionId)
    if (parent.configuration === undefined) {
      throw new Error(
        `Parent Session ${input.parentSessionId} has no persisted configuration.`,
      )
    }
    const inheritedConfiguration = SessionConfiguration.restore(
      parent.configuration,
    ).snapshot
    const created = await options.kernel.createSession({
      parentSessionId: input.parentSessionId,
      ...(parent.workingDirectory === undefined
        ? {}
        : { workingDirectory: parent.workingDirectory }),
      ...(parent.mateId === undefined ? {} : { mateId: parent.mateId }),
      ...(parent.mateRevisionId === undefined
        ? {}
        : { mateRevisionId: parent.mateRevisionId }),
      title: input.taskName,
      metadata: {
        agent: {
          version: 1,
          kind: "subagent",
          rootSessionId: input.rootSessionId,
          parentSessionId: input.parentSessionId,
          taskName: input.taskName,
          path: input.path,
          agentType: input.agentType,
          depth: input.depth,
        },
      },
    })
    publishDurable([created.event])
    const configured = await options.kernel.configureSession({
      sessionId: created.sessionId,
      configuration: inheritedConfiguration,
    })
    if (configured.event !== undefined) publishDurable([configured.event])
    if (input.forkedContext !== undefined) {
      const seeded = await options.kernel.seedContextWindow({
        sessionId: created.sessionId,
        sourceSessionId: input.forkedContext.sourceSessionId,
        history: input.forkedContext.messages,
        ...(input.forkedContext.worldState === undefined
          ? {}
          : { worldStateBaseline: input.forkedContext.worldState }),
      })
      publishDurable([seeded.event])
    }
    const admitted = await options.kernel.admitInput({
      sessionId: created.sessionId,
      role: InputRole.User,
      content: { kind: "text", text: input.message },
      modelSelection: selectionFromTarget(input.target),
    })
    publishDurable([admitted.event])
    return created.sessionId
  }

  async function runAgentChild(sessionId: string): Promise<AgentRunOutcome> {
    await wake(sessionId)
    return readAgentOutcome(sessionId)
  }

  async function submitAgentFollowup(input: {
    readonly sessionId: string
    readonly message: string
    readonly target: AgentModelTarget
  }): Promise<void> {
    const admitted = await options.kernel.admitInput({
      sessionId: input.sessionId,
      role: InputRole.User,
      content: { kind: "text", text: input.message },
      modelSelection: selectionFromTarget(input.target),
    })
    publishDurable([admitted.event])
  }

  function captureForkContext(input: {
    readonly parentSessionId: string
    readonly forkTurns: ForkTurns
  }) {
    if (input.forkTurns === "none") return undefined
    const context = lanes.get(input.parentSessionId)?.activeTurn?.forkContext
    if (context === undefined) return undefined
    const messages =
      input.forkTurns === "all"
        ? context.messages
        : lastModelTurns(context, input.forkTurns)
    const worldState =
      input.forkTurns === "all" ? context.worldState : undefined
    return createForkedModelContext({
      sourceSessionId: input.parentSessionId,
      messages,
      preserveWorldState: input.forkTurns === "all",
      ...(worldState === undefined ? {} : { worldState }),
    })
  }

  // Keyed off durable state rather than lane state: an interrupt can race a
  // terminal child, in which case there is nothing left to cancel.
  async function interruptAgentTurn(sessionId: string): Promise<void> {
    lanes.get(sessionId)?.activeTurn?.abort.abort()
    const read = await options.kernel.readSession({ sessionId })
    const session = read.session
    if (!session) return
    // The abort can land before the child turn starts, while its Input is
    // still queued: cancel it so the lane never runs the turn at all.
    for (const pending of session.pendingInputs) {
      try {
        await options.kernel.cancelInput({
          sessionId,
          inputId: pending.inputId,
        })
      } catch (error) {
        // Consumed into a turn between the read and the cancel; the
        // active-turn path below covers that outcome.
        if (!isInvalidStateError(error)) throw error
      }
    }
    // Re-read: the queued Input may have been consumed into a turn while the
    // cancellations above were in flight.
    const active = (await options.kernel.readSession({ sessionId })).session
      ?.activeTurn
    if (!active) return
    lanes.get(sessionId)?.activeTurn?.abort.abort()
    await cancelActiveTurn(sessionId, active.turnId, "agent_interrupted")
  }

  async function readAgentOutcome(sessionId: string): Promise<AgentRunOutcome> {
    const session = await requireSession(sessionId)
    const assistantItem = [...session.items]
      .reverse()
      .find((item) => item.kind === ItemKind.AssistantMessage)
    const text =
      assistantItem?.content.kind === "text"
        ? assistantItem.content.text
        : undefined
    const lastTurn = session.turns.at(-1)
    if (lastTurn?.state === TurnState.Completed) {
      return { type: "completed", text: text ?? "" }
    }
    const detail =
      lastTurn?.error?.message ??
      lastTurn?.cancelledReason ??
      lastTurn?.interruptedReason
    if (
      lastTurn?.state === TurnState.Cancelled ||
      lastTurn?.state === TurnState.Interrupted
    ) {
      return {
        type: "interrupted",
        ...(detail === undefined ? {} : { reason: detail }),
      }
    }
    return {
      type: "errored",
      error: `Agent turn ${lastTurn?.state ?? "missing"}${detail === undefined ? "." : `: ${detail}`}`,
    }
  }

  async function waitForPermissionAllow(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly permissionRequestId: string
    readonly signal: AbortSignal
  }): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false
        readonly kind: "permission_denied" | "permission_timeout" | "aborted"
        readonly message: string
      }
  > {
    const deadline = Date.now() + runtimeTiming.permissionWaitTimeoutMs
    for (;;) {
      const outcome = await readPermissionOutcome(input)
      if (outcome !== undefined) return outcome
      const remaining = deadline - Date.now()
      const wake = await permissionGate.wait({
        sessionId: input.sessionId,
        turnId: input.turnId,
        permissionRequestId: input.permissionRequestId,
        signal: input.signal,
        timeoutMs: remaining,
      })
      if (wake === "aborted") {
        return {
          ok: false,
          kind: "aborted",
          message: "Permission wait aborted. No process was started.",
        }
      }
      if (wake === "timeout") {
        const raced = await readPermissionOutcome(input)
        if (raced !== undefined) return raced
        try {
          const timedOut = await options.kernel.resolvePermission({
            sessionId: input.sessionId,
            turnId: input.turnId,
            permissionRequestId: input.permissionRequestId,
            behavior: PermissionBehavior.Expire,
            reason: {
              kind: "timeout",
              message: "Permission wait timed out.",
            },
          })
          publishDurable([timedOut.event])
        } catch (error) {
          if (!isInvalidState(error)) throw error
          const resolved = await readPermissionOutcome(input)
          if (resolved !== undefined) return resolved
          throw error
        }
        return {
          ok: false,
          kind: "permission_timeout",
          message: "Permission wait timed out. No process was started.",
        }
      }
    }
  }

  async function readPermissionOutcome(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly permissionRequestId: string
  }): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false
        readonly kind: "permission_denied" | "permission_timeout"
        readonly message: string
      }
    | undefined
  > {
    const session = await requireSession(input.sessionId)
    const permission = session.permissions.find(
      (candidate) =>
        candidate.permissionRequestId === input.permissionRequestId,
    )
    if (!permission) {
      return {
        ok: false,
        kind: "permission_denied",
        message: "Permission request was not found. No process was started.",
      }
    }
    if (permission.state === PermissionState.Pending) return undefined
    if (permission.behavior === PermissionBehavior.Allow) return { ok: true }
    if (permission.behavior === PermissionBehavior.Expire) {
      return {
        ok: false,
        kind: "permission_timeout",
        message:
          permission.decisionReason?.message ??
          "Permission wait timed out. No process was started.",
      }
    }
    return {
      ok: false,
      kind: "permission_denied",
      message:
        permission.decisionReason?.message ??
        "Permission denied. No process was started.",
    }
  }

  async function consumeModelStream(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly streamId: string
    readonly request: ModelRequest
    readonly assistantResponseBytes: number
  }): Promise<ConsumedModelResponse> {
    const startedAt = Date.now()
    let firstEventAt: number | undefined
    const publisher =
      options.transientHub === undefined
        ? undefined
        : createCoalescingSnapshotPublisher(
            options.transientHub,
            runtimeTiming.assistantSnapshotPublicationsPerSecond,
          )
    const reasoningPublisher =
      options.transientHub === undefined
        ? undefined
        : createCoalescingSnapshotPublisher(
            options.transientHub,
            runtimeTiming.assistantSnapshotPublicationsPerSecond,
            "reasoning.snapshot",
          )

    let terminal: ModelResponse | undefined
    try {
      for await (const event of options.stream(input.request)) {
        firstEventAt ??= Date.now()
        if (event.type === "reasoning_snapshot") {
          if (utf8Bytes(event.text) > input.assistantResponseBytes) {
            throw createYakitoriError({
              code: YakitoriErrorCode.InvalidState,
              message: "Reasoning snapshot exceeded the configured byte limit.",
              details: { code: "assistant_output_too_large" },
            })
          }
          reasoningPublisher?.publish({
            sessionId: input.sessionId,
            turnId: input.turnId,
            streamId: input.streamId,
            text: event.text,
          })
          continue
        }
        if (event.type === "snapshot") {
          if (utf8Bytes(event.text) > input.assistantResponseBytes) {
            throw createYakitoriError({
              code: YakitoriErrorCode.InvalidState,
              message: "Assistant snapshot exceeded the configured byte limit.",
              details: { code: "assistant_output_too_large" },
            })
          }
          publisher?.publish({
            sessionId: input.sessionId,
            turnId: input.turnId,
            streamId: input.streamId,
            text: event.text,
          })
          continue
        }

        if (terminal !== undefined) {
          throw createYakitoriError({
            code: YakitoriErrorCode.InvalidState,
            message: "Model stream emitted more than one terminal response.",
            details: { code: "duplicate_terminal_response" },
          })
        }
        terminal = event.response
      }
    } catch (error) {
      publisher?.flush()
      reasoningPublisher?.flush()
      if (isAbortError(error) || input.request.signal?.aborted) {
        const completedAt = Date.now()
        return {
          response: { stopReason: ModelStopReason.Aborted, content: [] },
          durationMs: completedAt - startedAt,
          timeToFirstTokenMs: (firstEventAt ?? completedAt) - startedAt,
        }
      }
      throw normalizeStreamError(error)
    }

    publisher?.flush()
    reasoningPublisher?.flush()
    if (terminal === undefined) {
      throw createYakitoriError({
        code: YakitoriErrorCode.InvalidState,
        message: "Model stream ended without a terminal response.",
        details: { code: "premature_stream_end" },
      })
    }
    const completedAt = Date.now()
    return {
      response: terminal,
      durationMs: completedAt - startedAt,
      timeToFirstTokenMs: (firstEventAt ?? completedAt) - startedAt,
    }
  }

  async function failActiveTurn(
    sessionId: string,
    turnId: string,
    error: unknown,
  ): Promise<void> {
    const read = await options.kernel.readSession({ sessionId })
    const active = read.session?.activeTurn
    if (!active || active.turnId !== turnId) return

    const telemetry = activeTurnRuntime(sessionId, turnId)?.telemetry
    const usage =
      telemetry === undefined
        ? undefined
        : aggregateTokenUsage(telemetry.usages)
    const failed = await options.kernel.failTurn({
      sessionId,
      turnId,
      error: toKernelError(error),
      ...(usage === undefined ? {} : { usage }),
      ...(telemetry === undefined ? {} : { metrics: turnMetrics(telemetry) }),
    })
    publishDurable(failed.events)
  }

  async function failTurnWithCode(
    sessionId: string,
    turnId: string,
    code: string,
    message: string,
  ): Promise<void> {
    const telemetry = activeTurnRuntime(sessionId, turnId)?.telemetry
    const usage =
      telemetry === undefined
        ? undefined
        : aggregateTokenUsage(telemetry.usages)
    const failed = await options.kernel.failTurn({
      sessionId,
      turnId,
      error: { code, message },
      ...(usage === undefined ? {} : { usage }),
      ...(telemetry === undefined ? {} : { metrics: turnMetrics(telemetry) }),
    })
    publishDurable(failed.events)
  }

  async function cancelActiveTurn(
    sessionId: string,
    turnId: string,
    reason: string,
  ): Promise<void> {
    const read = await options.kernel.readSession({ sessionId })
    const active = read.session?.activeTurn
    if (!active || active.turnId !== turnId) return
    const telemetry = activeTurnRuntime(sessionId, turnId)?.telemetry
    const usage =
      telemetry === undefined
        ? undefined
        : aggregateTokenUsage(telemetry.usages)
    const cancelled = await options.kernel.cancelTurn({
      sessionId,
      turnId,
      reason,
      ...(usage === undefined ? {} : { usage }),
      ...(telemetry === undefined ? {} : { metrics: turnMetrics(telemetry) }),
    })
    publishDurable(cancelled.events)
  }

  function isInvalidStateError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === YakitoriErrorCode.InvalidState
    )
  }

  async function cancelAfterRuntimeAbort(
    sessionId: string,
    turnId: string,
  ): Promise<void> {
    if (closed) return
    await cancelActiveTurn(sessionId, turnId, "aborted")
  }

  async function requireSession(sessionId: string): Promise<SessionProjection> {
    const read = await options.kernel.readSession({ sessionId })
    if (read.session) return read.session
    throw createYakitoriError({
      code: YakitoriErrorCode.NotFound,
      message: `Session ${sessionId} was not found.`,
      details: { sessionId },
    })
  }

  return {
    wake,
    async interrupt(input) {
      const lane = lanes.get(input.sessionId)
      if (lane?.activeTurn?.turnId !== input.turnId) {
        // Fall back to durable state: cancel only if the turn is still active.
        const read = await options.kernel.readSession({
          sessionId: input.sessionId,
        })
        const active = read.session?.activeTurn
        if (!active || active.turnId !== input.turnId) {
          throw createYakitoriError({
            code: YakitoriErrorCode.InvalidState,
            message: "Requested turn is not the active runtime turn.",
            details: {
              sessionId: input.sessionId,
              turnId: input.turnId,
              activeTurnId: active?.turnId ?? null,
            },
          })
        }
      }
      lane?.activeTurn?.abort.abort()
      try {
        await cancelActiveTurn(
          input.sessionId,
          input.turnId,
          input.reason ?? "interrupted",
        )
      } catch (error) {
        // Completion may have won the race; that is a valid terminal outcome.
        if (isInvalidStateError(error)) {
          return
        }
        throw error
      }
    },
    async close() {
      closed = true
      for (const lane of lanes.values()) lane.activeTurn?.abort.abort()
      await agentControl.close()
      await Promise.all(
        Array.from(lanes.values(), (lane) => lane.worker).filter(
          (worker): worker is Promise<void> => worker !== undefined,
        ),
      )
    },
  }
}

function createCompactionReplacement(
  worldState: WorldState,
  summary: string,
  replacesInheritedContext: boolean,
): {
  readonly history: readonly ModelMessage[]
  readonly worldStateBaseline: JsonObject
  readonly replacesInheritedContext?: boolean
} {
  const fullWorldState = diffWorldState(undefined, worldState)
  if (fullWorldState === undefined) {
    throw new Error(
      "Full world-state rendering unexpectedly produced no state.",
    )
  }
  return {
    history: createCompactionReplacementHistory({
      summary,
      worldStateFragments: fullWorldState.fragments,
    }),
    worldStateBaseline: fullWorldState.state,
    ...(replacesInheritedContext ? { replacesInheritedContext: true } : {}),
  }
}

function toolEffect(tool: RuntimeTool | undefined): ToolEffect {
  return tool?.effect ?? "opaque"
}

function turnTarget(execution: TurnExecutionContext): AgentModelTarget {
  return {
    provider: execution.provider,
    model: execution.model,
    ...(execution.effort === undefined ? {} : { effort: execution.effort }),
    ...(execution.speed === undefined ? {} : { speed: execution.speed }),
  }
}

function selectionFromTarget(target: AgentModelTarget): ModelSelection {
  return {
    provider: target.provider,
    model: target.model,
    ...(target.effort === undefined ? {} : { effort: target.effort }),
    ...(target.speed === undefined ? {} : { speed: target.speed }),
  }
}

function lastModelTurns(
  context: {
    readonly messages: readonly ModelMessage[]
    readonly forkTurnStartIndexes: readonly number[]
  },
  count: number,
): readonly ModelMessage[] {
  const start =
    context.forkTurnStartIndexes.at(-count) ?? context.forkTurnStartIndexes[0]
  return start === undefined ? [] : context.messages.slice(start)
}

function isInvalidState(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === YakitoriErrorCode.InvalidState
  )
}

function aggregateTokenUsage(
  usages: readonly ModelUsage[],
): TokenUsage | undefined {
  if (usages.length === 0) return undefined
  const totals = usages.reduce<{
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheWriteInputTokens: number
  }>(
    (total, usage) => ({
      inputTokens: total.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: total.outputTokens + (usage.outputTokens ?? 0),
      cacheReadInputTokens:
        total.cacheReadInputTokens + (usage.cacheReadInputTokens ?? 0),
      cacheWriteInputTokens:
        total.cacheWriteInputTokens + (usage.cacheWriteInputTokens ?? 0),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    },
  )
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    ...(totals.cacheReadInputTokens === 0
      ? {}
      : { cacheReadInputTokens: totals.cacheReadInputTokens }),
    ...(totals.cacheWriteInputTokens === 0
      ? {}
      : { cacheWriteInputTokens: totals.cacheWriteInputTokens }),
  }
}

function createTurnTelemetry(): TurnTelemetry {
  return {
    usages: [],
    modelCalls: 0,
    toolCalls: 0,
    modelDurationMs: 0,
    toolDurationMs: 0,
    timeToFirstTokenTotalMs: 0,
    timeToFirstTokenSamples: 0,
  }
}

function recordModelCall(
  telemetry: TurnTelemetry,
  consumed: ConsumedModelResponse,
): void {
  telemetry.modelCalls += 1
  telemetry.modelDurationMs += consumed.durationMs
  telemetry.timeToFirstTokenTotalMs += consumed.timeToFirstTokenMs
  telemetry.timeToFirstTokenSamples += 1
}

function turnMetrics(telemetry: TurnTelemetry): TurnMetrics {
  return {
    modelCalls: telemetry.modelCalls,
    toolCalls: telemetry.toolCalls,
    modelDurationMs: telemetry.modelDurationMs,
    toolDurationMs: telemetry.toolDurationMs,
    ...(telemetry.timeToFirstTokenSamples === 0
      ? {}
      : {
          averageTimeToFirstTokenMs: Math.round(
            telemetry.timeToFirstTokenTotalMs /
              telemetry.timeToFirstTokenSamples,
          ),
        }),
  }
}

function assistantContent(
  content: readonly ModelContentBlock[],
): readonly AssistantContentBlock[] {
  return content
    .filter(
      (
        block,
      ): block is Extract<
        ModelContentBlock,
        { readonly type: "text" | "reasoning" }
      > => block.type === "text" || block.type === "reasoning",
    )
    .map((block) =>
      block.type === "text"
        ? block
        : {
            type: "reasoning" as const,
            text: block.text,
            ...(block.providerMetadata === undefined
              ? {}
              : { providerMetadata: block.providerMetadata }),
          },
    )
}

function assistantContentBytes(
  content: readonly AssistantContentBlock[],
): number {
  return utf8Bytes(content.map((block) => block.text).join(""))
}

function toKernelError(error: unknown): KernelError {
  if (typeof error === "object" && error !== null) {
    const record = error as {
      message?: unknown
      code?: unknown
      details?: unknown
    }
    const message =
      typeof record.message === "string"
        ? record.message
        : "Unexpected runtime error."
    const code =
      typeof record.code === "string"
        ? record.code
        : isEventMetadata(record.details) &&
            typeof record.details.code === "string"
          ? record.details.code
          : "runtime_error"
    return {
      message,
      code,
      ...(isEventMetadata(record.details) ? { details: record.details } : {}),
    }
  }
  return { message: "Unexpected runtime error.", code: "runtime_error" }
}

function normalizeStreamError(error: unknown): Error {
  if (error instanceof Error) {
    const details =
      "details" in error && isEventMetadata(error.details)
        ? error.details
        : { code: "model_stream_error" }
    return createYakitoriError({
      code: YakitoriErrorCode.InvalidState,
      message: error.message,
      details,
      cause: error,
    })
  }
  return createYakitoriError({
    code: YakitoriErrorCode.InvalidState,
    message: "Model stream failed.",
    details: { code: "model_stream_error" },
  })
}

function isCompactDirectiveInput(input: InputProjection): boolean {
  return (
    input.role === InputRole.Runtime &&
    input.content.text.trim() === COMPACT_DIRECTIVE
  )
}

function isEventMetadata(value: unknown): value is EventMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  return Object.values(value).every((entry) => isJsonValue(entry))
}

function selectCompactionSource(
  candidateHistory: readonly CompactionSourceGroup[],
  budgetBytes: number,
): readonly CompactionSourceGroup[] {
  const selected: CompactionSourceGroup[] = []
  const checkpointIndex = candidateHistory.findIndex(
    (group) => group.kind === "compaction",
  )
  const requiredLength = checkpointIndex < 0 ? 0 : checkpointIndex + 1
  let bytes = 0
  for (const [index, group] of candidateHistory.entries()) {
    const groupBytes = measureModelMessagesBytes(group.messages)
    if (index >= requiredLength && bytes + groupBytes > budgetBytes) break
    selected.push(group)
    bytes += groupBytes
  }
  return selected
}

const MAX_COMPACTION_ATTEMPTS = 3
const MAX_CONSECUTIVE_COMPACTION_FAILURES = 3

// Every checkpoint covers a continuous historical prefix. If the summary
// request overflows, keep the oldest half and postpone newer Turns.
function reduceCompactionSourcePrefix(
  source: readonly CompactionSourceGroup[],
): readonly CompactionSourceGroup[] {
  const checkpointIndex = source.findIndex(
    (group) => group.kind === "compaction",
  )
  const requiredLength = checkpointIndex < 0 ? 0 : checkpointIndex + 1
  const keep = Math.max(requiredLength, Math.ceil(source.length / 2))
  return source.slice(0, keep)
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}
