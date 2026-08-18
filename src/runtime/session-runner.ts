import {
  COMPACT_DIRECTIVE,
  createYakitoriError,
  type EventEnvelope,
  type EventMetadata,
  type InputProjection,
  InputRole,
  isJsonValue,
  ItemKind,
  type KernelError,
  type ModelSelection,
  PermissionBehavior,
  PermissionState,
  type SessionKernel,
  type SessionProjection,
  type TokenUsage,
  type TurnExecutionContext,
  TurnState,
  YakitoriErrorCode,
} from "../kernel/index.ts"
import type { MateKernel } from "../mates/index.ts"
import {
  buildCompactionRequest,
  isContextOverflowError,
  runCompaction,
} from "./compaction.ts"
import { buildEnvironmentContext } from "./environment-context.ts"
import { isAbortError } from "./errors.ts"
import {
  createRuntimeLimits,
  deriveModelVisibleContextBytes,
  RuntimeLimits,
} from "./limits.ts"
import {
  createCoalescingSnapshotPublisher,
  type TransientEventHub,
} from "./live-events.ts"
import {
  type ModelContentBlock,
  type ModelRequest,
  type ModelResponse,
  ModelStopReason,
  type ModelToolCallBlock,
  type ModelUsage,
  type StreamFn,
} from "./model.ts"
import {
  catalogContextWindowTokens,
  requirePromptId,
  resolveModel,
} from "./model-catalog.ts"
import {
  buildModelContext,
  collectUncoveredTurns,
  type DroppedTurn,
  type ModelContextBuildResult,
} from "./model-context.ts"
import { createPermissionGate, type PermissionGate } from "./permission-gate.ts"
import { loadProjectInstructions } from "./project-instructions.ts"
import { buildStaticContext } from "./static-context.ts"
import { resolveWorkspaceRoot } from "./tools/path-policy.ts"
import { createToolRegistry, type ToolRegistry } from "./tools/registry.ts"
import type {
  RuntimeTool,
  SpawnSubagent,
  ToolEffect,
  ToolExecutionResult,
} from "./tools/types.ts"
import {
  createVisibleFileObservations,
  grantFromToolOutput,
} from "./tools/visible-file-observations.ts"

export type SessionRunnerOptions = {
  readonly kernel: SessionKernel
  readonly mateKernel: MateKernel
  readonly stream: StreamFn
  readonly durableHub?: {
    publish(events: readonly EventEnvelope[]): void
  }
  readonly transientHub?: TransientEventHub
  readonly toolRegistry?: ToolRegistry
  readonly permissionGate?: PermissionGate
  readonly provider?: string
  readonly model?: string
  readonly limits?: RuntimeLimits
  readonly approvalPolicy?: "auto_file_tools" | "never"
  readonly loadProjectInstructions?: typeof loadProjectInstructions
  readonly onRuntimeError?: (error: unknown) => void
}

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
  abort?: AbortController | undefined
  activeTurnId?: string | undefined
}

export function createSessionRunner(
  options: SessionRunnerOptions,
): SessionRunner {
  const limits = options.limits ?? createRuntimeLimits()
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
    if (events.length === 0) return
    options.durableHub?.publish(events)
  }

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
    const executionContext = await buildExecutionContext(session, queuedInput)
    if (closed) return
    const started = await startTurnUnlessInputConsumed(
      session.id,
      queuedInput.inputId,
      executionContext,
    )
    if (started === undefined) return
    publishDurable(started.events)

    const lane = lanes.get(session.id) ?? { dirty: false }
    const abort = new AbortController()
    lane.abort = abort
    lane.activeTurnId = started.turnId
    lanes.set(session.id, lane)

    if (closed) abort.abort()

    try {
      if (isCompactDirectiveInput(queuedInput)) {
        await executeCompactTurn({
          sessionId: session.id,
          turnId: started.turnId,
          inputId: queuedInput.inputId,
          executionContext,
          signal: abort.signal,
        })
      } else {
        await executeTextTurn({
          sessionId: session.id,
          turnId: started.turnId,
          inputId: queuedInput.inputId,
          executionContext,
          signal: abort.signal,
        })
      }
    } catch (error) {
      await failActiveTurn(session.id, started.turnId, error)
    } finally {
      const current = lanes.get(session.id)
      if (current?.activeTurnId === started.turnId) {
        current.activeTurnId = undefined
        current.abort = undefined
      }
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

  async function buildExecutionContext(
    session: SessionProjection,
    queuedInput: InputProjection,
  ): Promise<TurnExecutionContext> {
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
    const selectedTarget: ModelSelection =
      queuedInput.modelSelection ??
      (previousTarget === undefined
        ? { provider, model }
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
    const resolvedModel = resolveModel(selectedTarget)
    // Scale the visible-context budget with the model's context window when
    // the catalog knows it; an explicit limits override always wins.
    const contextWindowTokens = catalogContextWindowTokens(resolvedModel)
    const modelVisibleContextBytes =
      contextWindowTokens === undefined ||
      limits.modelVisibleContextBytes !== RuntimeLimits.modelVisibleContextBytes
        ? limits.modelVisibleContextBytes
        : deriveModelVisibleContextBytes(contextWindowTokens)
    return {
      mateId: session.mateId,
      mateRevisionId: session.mateRevisionId,
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      promptId: resolvedModel.promptId,
      ...(selectedTarget.effort === undefined
        ? {}
        : { effort: selectedTarget.effort }),
      ...(selectedTarget.speed === undefined
        ? {}
        : { speed: selectedTarget.speed }),
      workingDirectory: session.workingDirectory,
      enabledTools: resolveEnabledTools(session, enabledTools),
      approvalPolicy,
      limits: {
        modelCallsPerTurn: limits.modelCallsPerTurn,
        toolCallsPerTurn: limits.toolCallsPerTurn,
        modelVisibleMessageBlocks: limits.modelVisibleMessageBlocks,
        modelVisibleContextBytes,
        modelVisibleToolResultBytes: limits.modelVisibleToolResultBytes,
        modelVisibleToolResultLines: limits.modelVisibleToolResultLines,
        assistantResponseBytes: limits.assistantResponseBytes,
      },
    }
  }

  async function executeTextTurn(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly inputId: string
    readonly executionContext: TurnExecutionContext
    readonly signal: AbortSignal
  }): Promise<void> {
    const mate = await options.mateKernel.readMate({
      mateId: input.executionContext.mateId,
    })
    const revision = mate.mate?.revisions.find(
      (candidate) => candidate.id === input.executionContext.mateRevisionId,
    )
    if (!revision) {
      throw createYakitoriError({
        code: YakitoriErrorCode.NotFound,
        message: `Mate revision ${input.executionContext.mateRevisionId} was not found.`,
      })
    }

    const projectInstructions = await projectInstructionLoader({
      workingDirectory: input.executionContext.workingDirectory,
    })
    const resolvedModel = {
      model: input.executionContext.model,
      provider: input.executionContext.provider,
      promptId:
        input.executionContext.promptId === undefined
          ? resolveModel({
              model: input.executionContext.model,
              provider: input.executionContext.provider,
            }).promptId
          : requirePromptId(input.executionContext.promptId),
    }
    const staticContext = buildStaticContext({
      environment: buildEnvironmentContext({
        workingDirectory: input.executionContext.workingDirectory,
      }),
      mateInstructions: revision.instructions,
      mateRevisionId: revision.id,
      model: resolvedModel,
      ...(projectInstructions === undefined ? {} : { projectInstructions }),
    })
    const enabledToolNames = new Set(input.executionContext.enabledTools)
    const tools = toolRegistry
      .definitions()
      .filter((definition) => enabledToolNames.has(definition.name))

    let modelCallIndex = 0
    let toolCallCount = 0
    const usages: ModelUsage[] = []
    while (modelCallIndex < input.executionContext.limits.modelCallsPerTurn) {
      if (input.signal.aborted) {
        await cancelAfterRuntimeAbort(input.sessionId, input.turnId)
        return
      }

      const session = await requireSession(input.sessionId)
      let context = buildModelContext({
        session,
        currentInputId: input.inputId,
        limits: input.executionContext.limits,
      })
      if (context.droppedTurns.length > 0) {
        context =
          (await attemptCompaction({
            session,
            turnId: input.turnId,
            inputId: input.inputId,
            executionContext: input.executionContext,
            droppedTurns: context.droppedTurns,
            usages,
            signal: input.signal,
          })) ?? context
      }

      const request: ModelRequest = {
        target: {
          ...staticContext.target,
          ...(input.executionContext.effort === undefined
            ? {}
            : { effort: input.executionContext.effort }),
          ...(input.executionContext.speed === undefined
            ? {}
            : { speed: input.executionContext.speed }),
        },
        system: staticContext.system,
        contextual: staticContext.contextual,
        messages: context.messages,
        tools,
        signal: input.signal,
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

      const streamId = `stream_${input.turnId}_${modelCallIndex + 1}`
      const response = await consumeModelStream({
        sessionId: input.sessionId,
        turnId: input.turnId,
        streamId,
        request,
      })
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
        const text = assistantText(response.content)
        if (
          utf8Bytes(text) > input.executionContext.limits.assistantResponseBytes
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
          input.executionContext.limits.toolCallsPerTurn
        ) {
          await failTurnWithCode(
            input.sessionId,
            input.turnId,
            "tool_budget_exhausted",
            `Turn exceeded tool call budget of ${input.executionContext.limits.toolCallsPerTurn}.`,
          )
          return
        }
        toolCallCount += toolCalls.length
        await persistAssistantAndExecuteTools({
          sessionId: input.sessionId,
          turnId: input.turnId,
          text,
          toolCalls,
          streamId,
          modelCallIndex,
          executionContext: input.executionContext,
          contextMetadata: {
            selectedItemIds: [...context.selectedItemIds],
            observationEligibleToolResultItemIds: [
              ...context.observationEligibleToolResultItemIds,
            ],
            droppedTurnCount: context.droppedTurnCount,
            truncatedToolResultCount: context.truncatedToolResultCount,
            ...(context.prunedToolResultCount > 0
              ? { prunedToolResultCount: context.prunedToolResultCount }
              : {}),
            ...(context.droppedCompactionCheckpoint
              ? { droppedCompactionCheckpoint: true }
              : {}),
            ...(response.providerRequestId === undefined
              ? {}
              : { providerRequestId: response.providerRequestId }),
          },
          signal: input.signal,
          visibleFileObservations,
          subagentSession: subagentAgent(session) !== undefined,
        })
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

      const text = assistantText(response.content)
      if (
        utf8Bytes(text) > input.executionContext.limits.assistantResponseBytes
      ) {
        await failTurnWithCode(
          input.sessionId,
          input.turnId,
          "assistant_output_too_large",
          "Assistant response exceeded the configured byte limit.",
        )
        return
      }

      if (text.length === 0) {
        const usage = aggregateTokenUsage(usages)
        const completed = await options.kernel.completeTurn({
          sessionId: input.sessionId,
          turnId: input.turnId,
          ...(usage === undefined ? {} : { usage }),
        })
        publishDurable([completed.event])
        return
      }

      const usage = aggregateTokenUsage(usages)
      const completed = await options.kernel.completeTurnWithAssistantOutput({
        sessionId: input.sessionId,
        turnId: input.turnId,
        content: { kind: "text", text },
        providerMetadata: {
          provider: input.executionContext.provider,
          model: input.executionContext.model,
          callIndex: modelCallIndex,
          streamId,
          selectedItemIds: [...context.selectedItemIds],
          observationEligibleToolResultItemIds: [
            ...context.observationEligibleToolResultItemIds,
          ],
          droppedTurnCount: context.droppedTurnCount,
          truncatedToolResultCount: context.truncatedToolResultCount,
          ...(context.droppedCompactionCheckpoint
            ? { droppedCompactionCheckpoint: true }
            : {}),
          ...(response.providerRequestId === undefined
            ? {}
            : { providerRequestId: response.providerRequestId }),
        },
        ...(usage === undefined ? {} : { usage }),
      })
      publishDurable(completed.events)
      return
    }

    await failTurnWithCode(
      input.sessionId,
      input.turnId,
      "model_budget_exhausted",
      `Turn exceeded model call budget of ${input.executionContext.limits.modelCallsPerTurn}.`,
    )
  }

  // Housekeeping: fold the longest fitting prefix of dropped history into a
  // durable checkpoint, then rebuild context. An over-long summary request is
  // retried with the oldest half of the source removed (up to
  // MAX_COMPACTION_ATTEMPTS); any other failure falls back to the originally
  // built context, and repeated failures trip a per-session circuit breaker.
  async function attemptCompaction(input: {
    readonly session: SessionProjection
    readonly turnId: string
    readonly inputId: string
    readonly executionContext: TurnExecutionContext
    readonly droppedTurns: readonly DroppedTurn[]
    readonly usages: ModelUsage[]
    readonly signal: AbortSignal
  }): Promise<ModelContextBuildResult | null | undefined> {
    const sessionId = input.session.id
    if (
      (compactionFailures.get(sessionId) ?? 0) >=
      MAX_CONSECUTIVE_COMPACTION_FAILURES
    ) {
      return undefined
    }
    try {
      const previousSummary = input.session.compaction?.summary
      let source = selectCompactionSource(
        input.droppedTurns,
        previousSummary,
        input.executionContext.limits.modelVisibleContextBytes,
      )
      if (source.length === 0) return undefined
      const throughSeq = input.session.seq
      let result: Awaited<ReturnType<typeof runCompaction>> | undefined
      let attempts = 0
      while (result === undefined) {
        try {
          result = await runCompaction({
            stream: options.stream,
            request: buildCompactionRequest({
              source,
              ...(previousSummary === undefined ? {} : { previousSummary }),
              provider: input.executionContext.provider,
              model: input.executionContext.model,
              signal: input.signal,
            }),
          })
        } catch (error) {
          if (input.signal.aborted || isAbortError(error)) throw error
          attempts += 1
          const reduced = dropOldestSourceHalf(source)
          if (
            !isContextOverflowError(error) ||
            attempts >= MAX_COMPACTION_ATTEMPTS ||
            reduced.length === source.length
          ) {
            throw error
          }
          source = reduced
        }
      }
      // A checkpoint that is not smaller than the history it replaces buys
      // nothing. This is not a failure: keep history, skip the error log and
      // the circuit breaker, and let callers tell the two outcomes apart.
      const sourceBytes = utf8Bytes(
        JSON.stringify(source.flatMap((group) => group.messages)),
      )
      if (utf8Bytes(result.summary) >= sourceBytes) {
        return null
      }
      const recorded = await options.kernel.recordCompaction({
        sessionId,
        turnId: input.turnId,
        throughSeq,
        coveredTurnIds: [
          ...(input.session.compaction?.coveredTurnIds ?? []),
          ...source.map((group) => group.turnId),
        ],
        summary: truncateSummary(result.summary, limits.compactionSummaryBytes),
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      })
      publishDurable([recorded.event])
      if (result.usage !== undefined) input.usages.push(result.usage)
      compactionFailures.delete(sessionId)
      const rebuilt = await requireSession(sessionId)
      return buildModelContext({
        session: rebuilt,
        currentInputId: input.inputId,
        limits: input.executionContext.limits,
      })
    } catch (error) {
      // A user interrupt mid-summary surfaces here as an AbortError; that is
      // the normal abort path, not a compaction failure worth logging.
      if (!input.signal.aborted) {
        compactionFailures.set(
          sessionId,
          (compactionFailures.get(sessionId) ?? 0) + 1,
        )
        console.error(
          "Context compaction failed; continuing with dropped history.",
          error,
        )
      }
      return undefined
    }
  }

  // A compact directive Turn is housekeeping, not conversation: fold every
  // uncovered completed Turn into a checkpoint, then close with a short note.
  // The only model call is the summary itself.
  async function executeCompactTurn(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly inputId: string
    readonly executionContext: TurnExecutionContext
    readonly signal: AbortSignal
  }): Promise<void> {
    const session = await requireSession(input.sessionId)
    const source = collectUncoveredTurns(session, input.executionContext.limits)
    const usages: ModelUsage[] = []
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
        inputId: input.inputId,
        executionContext: input.executionContext,
        droppedTurns: source,
        usages,
        signal: input.signal,
      })
      if (input.signal.aborted) {
        await cancelAfterRuntimeAbort(input.sessionId, input.turnId)
        return
      }
      note =
        compacted === undefined
          ? "Context compaction failed; the history was kept intact."
          : compacted === null
            ? "The history is already compact enough; summarizing it would not reduce the context."
            : `Compacted ${source.length} turn(s) into a context checkpoint.`
    }
    const usage = aggregateTokenUsage(usages)
    const completed = await options.kernel.completeTurnWithAssistantOutput({
      sessionId: input.sessionId,
      turnId: input.turnId,
      content: { kind: "text", text: note },
      providerMetadata: {
        provider: input.executionContext.provider,
        model: input.executionContext.model,
        directive: COMPACT_DIRECTIVE,
      },
      ...(usage === undefined ? {} : { usage }),
    })
    publishDurable(completed.events)
  }

  async function persistAssistantAndExecuteTools(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly text: string
    readonly toolCalls: readonly ModelToolCallBlock[]
    readonly streamId: string
    readonly modelCallIndex: number
    readonly executionContext: TurnExecutionContext
    readonly contextMetadata: EventMetadata
    readonly signal: AbortSignal
    readonly visibleFileObservations: ReturnType<
      typeof createVisibleFileObservations
    >
    readonly subagentSession: boolean
  }): Promise<void> {
    const recorded = await options.kernel.recordAssistantOutput({
      sessionId: input.sessionId,
      turnId: input.turnId,
      ...(input.text.length === 0
        ? {}
        : { content: [{ type: "text", text: input.text }] }),
      providerMetadata: {
        provider: input.executionContext.provider,
        model: input.executionContext.model,
        callIndex: input.modelCallIndex,
        streamId: input.streamId,
        ...input.contextMetadata,
      },
      toolCalls: input.toolCalls.map((call) => {
        const tool = toolRegistry.get(call.name)
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

    const workspaceRoot = await resolveWorkspaceRoot(
      input.executionContext.workingDirectory,
    )
    const observations = input.visibleFileObservations
    const firstBarrier = input.toolCalls.findIndex((call) => {
      const tool = toolRegistry.get(call.name)
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
              workspaceRoot,
              signal: input.signal,
              observations,
              record: false,
              subagentSession: input.subagentSession,
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
          workspaceRoot,
          signal: input.signal,
          observations,
          record: true,
          subagentSession: input.subagentSession,
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
    readonly workspaceRoot: string
    readonly signal: AbortSignal
    readonly observations: ReturnType<typeof createVisibleFileObservations>
    readonly record: boolean
    readonly subagentSession: boolean
  }): Promise<ToolExecutionResult | "aborted"> {
    // Defense in depth: the model only sees enabledTools definitions, but a
    // session's narrowed tool set must hold even if a call slips through
    // (e.g. a subagent session attempting task).
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
    // The registry owns dispatch; the lookup here is only for permission
    // metadata (autoAllow), mirroring codex's ToolRouter split.
    const tool = toolRegistry.get(input.call.name)
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

    const result = await toolRegistry.execute(
      input.call.name,
      input.call.input,
      {
        workspaceRoot: input.workspaceRoot,
        signal: input.signal,
        visibleFileObservations: input.observations,
        // Subagent sessions never get spawnSubagent; this caps delegation
        // depth at 1 alongside task being absent from their enabledTools.
        ...(input.subagentSession
          ? {}
          : {
              spawnSubagent: createSpawnSubagent(
                input.sessionId,
                input.executionContext,
                input.signal,
              ),
            }),
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

  // Spawns a subagent as a child session on this same runner: the child gets
  // its own lane, so awaiting its wake() cannot deadlock the parent's lane.
  function createSpawnSubagent(
    parentSessionId: string,
    executionContext: TurnExecutionContext,
    parentSignal: AbortSignal,
  ): SpawnSubagent {
    return async ({ agent, description, prompt }) => {
      // An already-aborted signal never fires listeners, so check it
      // explicitly at every stage boundary.
      if (parentSignal.aborted) {
        return {
          ok: false as const,
          sessionId: "",
          error: "Parent turn was aborted before the subagent started.",
        }
      }
      const created = await options.kernel.createSession({
        parentSessionId,
        workingDirectory: executionContext.workingDirectory,
        mateId: executionContext.mateId,
        mateRevisionId: executionContext.mateRevisionId,
        title: description,
        metadata: { subagent: agent, subagentDescription: description },
      })
      publishDurable([created.event])
      const childSessionId = created.sessionId
      const onParentAbort = () => {
        void interruptSubagentTurn(childSessionId).catch((error: unknown) => {
          options.onRuntimeError?.(error)
        })
      }
      parentSignal.addEventListener("abort", onParentAbort, { once: true })
      try {
        const admitted = await options.kernel.admitInput({
          sessionId: childSessionId,
          role: InputRole.User,
          content: { kind: "text", text: prompt },
          // A subagent extends the turn that spawned it: inherit that turn's
          // model instead of falling back to the session default.
          modelSelection: {
            provider: executionContext.provider,
            model: executionContext.model,
            ...(executionContext.effort === undefined
              ? {}
              : { effort: executionContext.effort }),
            ...(executionContext.speed === undefined
              ? {}
              : { speed: executionContext.speed }),
          },
        })
        publishDurable([admitted.event])
        // The abort listener cannot cancel a turn that does not exist yet;
        // if the parent died during admission, tear the child down instead
        // of waking it.
        if (parentSignal.aborted) {
          await interruptSubagentTurn(childSessionId)
          return {
            ok: false as const,
            sessionId: childSessionId,
            error: "Parent turn was aborted.",
          }
        }
        await wake(childSessionId)
      } finally {
        parentSignal.removeEventListener("abort", onParentAbort)
      }
      return readSubagentOutcome(childSessionId)
    }
  }

  // Keyed off durable state rather than lane state: on parent abort the
  // child turn may already be terminal, and losing that race is a no-op.
  async function interruptSubagentTurn(sessionId: string): Promise<void> {
    lanes.get(sessionId)?.abort?.abort()
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
    lanes.get(sessionId)?.abort?.abort()
    await cancelActiveTurn(sessionId, active.turnId, "parent_aborted")
  }

  async function readSubagentOutcome(sessionId: string) {
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
      return { ok: true as const, sessionId, text: text ?? "" }
    }
    const detail =
      lastTurn?.error?.message ??
      lastTurn?.cancelledReason ??
      lastTurn?.interruptedReason
    return {
      ok: false as const,
      sessionId,
      error: `Subagent turn ${lastTurn?.state ?? "missing"}${detail === undefined ? "." : `: ${detail}`}`,
      ...(text === undefined ? {} : { partialText: text }),
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
    const deadline = Date.now() + limits.permissionWaitTimeoutMs
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
  }): Promise<ModelResponse> {
    const publisher =
      options.transientHub === undefined
        ? undefined
        : createCoalescingSnapshotPublisher(
            options.transientHub,
            limits.assistantSnapshotPublicationsPerSecond,
          )

    let terminal: ModelResponse | undefined
    try {
      for await (const event of options.stream(input.request)) {
        if (event.type === "snapshot") {
          if (utf8Bytes(event.text) > limits.assistantResponseBytes) {
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
      if (isAbortError(error) || input.request.signal?.aborted) {
        return { stopReason: ModelStopReason.Aborted, content: [] }
      }
      throw normalizeStreamError(error)
    }

    publisher?.flush()
    if (terminal === undefined) {
      throw createYakitoriError({
        code: YakitoriErrorCode.InvalidState,
        message: "Model stream ended without a terminal response.",
        details: { code: "premature_stream_end" },
      })
    }
    return terminal
  }

  async function failActiveTurn(
    sessionId: string,
    turnId: string,
    error: unknown,
  ): Promise<void> {
    const read = await options.kernel.readSession({ sessionId })
    const active = read.session?.activeTurn
    if (!active || active.turnId !== turnId) return

    const failed = await options.kernel.failTurn({
      sessionId,
      turnId,
      error: toKernelError(error),
    })
    publishDurable(failed.events)
  }

  async function failTurnWithCode(
    sessionId: string,
    turnId: string,
    code: string,
    message: string,
  ): Promise<void> {
    const failed = await options.kernel.failTurn({
      sessionId,
      turnId,
      error: { code, message },
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
    const cancelled = await options.kernel.cancelTurn({
      sessionId,
      turnId,
      reason,
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
      if (!lane || lane.activeTurnId !== input.turnId) {
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
      lane?.abort?.abort()
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
      for (const lane of lanes.values()) lane.abort?.abort()
      await Promise.all(
        Array.from(lanes.values(), (lane) => lane.worker).filter(
          (worker): worker is Promise<void> => worker !== undefined,
        ),
      )
    },
  }
}

function toolEffect(tool: RuntimeTool | undefined): ToolEffect {
  return tool?.effect ?? "opaque"
}

// A session is a subagent session when SessionCreated metadata carries a
// `subagent` marker (forks use forkReason instead, so there is no overlap).
// Any value other than the two known kinds is treated as "general".
function subagentAgent(
  session: SessionProjection,
): "general" | "explore" | undefined {
  const marker = session.metadata?.subagent
  if (marker === undefined) return undefined
  return marker === "explore" ? "explore" : "general"
}

// Subagent sessions run with a narrowed tool set: explore is read-only,
// general keeps everything except task itself (depth is capped at 1).
function resolveEnabledTools(
  session: SessionProjection,
  enabledTools: readonly string[],
): readonly string[] {
  const agent = subagentAgent(session)
  if (agent === undefined) return [...enabledTools]
  if (agent === "explore") {
    return enabledTools.filter((name) => EXPLORE_SUBAGENT_TOOLS.has(name))
  }
  return enabledTools.filter((name) => name !== "task")
}

const EXPLORE_SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "grep",
  "glob",
  "web_fetch",
  "web_search",
])

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
  return usages.reduce<TokenUsage>(
    (total, usage) => ({
      inputTokens: total.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: total.outputTokens + (usage.outputTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0 },
  )
}

function assistantText(content: readonly ModelContentBlock[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
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
  droppedTurns: readonly DroppedTurn[],
  previousSummary: string | undefined,
  budgetBytes: number,
): readonly DroppedTurn[] {
  const selected: DroppedTurn[] = []
  let bytes = utf8Bytes(previousSummary ?? "")
  for (const group of droppedTurns) {
    const groupBytes = utf8Bytes(JSON.stringify(group.messages))
    if (bytes + groupBytes > budgetBytes) break
    selected.push(group)
    bytes += groupBytes
  }
  return selected
}

function truncateSummary(summary: string, budgetBytes: number): string {
  if (utf8Bytes(summary) <= budgetBytes) return summary
  const marker = "\n...[summary truncated]"
  let text = summary
  while (utf8Bytes(`${text}${marker}`) > budgetBytes && text.length > 0) {
    text = text.slice(0, Math.max(0, text.length - 1_024))
  }
  return `${text}${marker}`
}

const MAX_COMPACTION_ATTEMPTS = 3
const MAX_CONSECUTIVE_COMPACTION_FAILURES = 3

// Keeps the most recent half of the source; the oldest turns are what an
// over-long summary request can most afford to lose.
function dropOldestSourceHalf(
  source: readonly DroppedTurn[],
): readonly DroppedTurn[] {
  const keep = Math.ceil(source.length / 2)
  return source.slice(source.length - keep)
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}
