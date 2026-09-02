import type { ResponseItemEnvelope, TurnContextItem } from "../core/rollout.ts"
import type {
  TurnControl,
  TurnProcessor,
  TurnRuntime,
} from "../core/session.ts"
import type { TurnInput } from "../core/session-io.ts"
import {
  type CompletedExecutionItem,
  type ContextCompactionCompletedItem,
  type JsonObject,
  type KernelError,
  MISSING_TOOL_RESULT_TEXT,
  type ModelMessage,
  type ModelSelection,
  type RolloutAssets,
  type StartedExecutionItem,
  type TokenUsage,
  type ToolExecutionItem,
} from "../kernel/index.ts"
import {
  buildCompactionRequest,
  isContextOverflowError,
  runTwoPassCompaction,
} from "./compaction.ts"
import { observeEnvironment } from "./environment-context.ts"
import { isAbortError } from "./errors.ts"
import {
  createRunnerTimingPolicy,
  createSessionExecutionPolicy,
  type RunnerTimingPolicy,
  type SessionExecutionPolicy,
} from "./limits.ts"
import {
  type ModelRequest,
  type ModelResponse,
  ModelStopReason,
  type ModelStreamEvent,
  type ModelToolCallBlock,
  type ModelUsage,
  type StreamFn,
} from "./model.ts"
import { createCompactionReplacementHistory } from "./model-context.ts"
import { adaptImagesForModel } from "./model-images.ts"
import { estimateModelRequestBudget } from "./model-request-budget.ts"
import { createPermissionGate, type PermissionGate } from "./permission-gate.ts"
import { loadProjectInstructions } from "./project-instructions.ts"
import {
  type ApprovalPolicy,
  createTurnContext,
  SessionConfiguration,
} from "./session-configuration.ts"
import { resolveToolPermissionRequest } from "./tool-permissions.ts"
import { resolveWorkspaceRoot } from "./tools/path-policy.ts"
import { createToolRegistry, type ToolRegistry } from "./tools/registry.ts"
import type {
  ToolExecutionResult,
  ToolPermissionRequest,
} from "./tools/types.ts"
import {
  createVisibleFileObservationsFromMessages,
  grantFromToolOutput,
  type VisibleFileObservations,
} from "./tools/visible-file-observations.ts"
import {
  buildWorldStateFromSnapshot,
  diffWorldState,
  type WorldState,
} from "./world-state.ts"
import type { AgentControl, BoundAgentControl } from "./agent-control.ts"

export type TurnProcessorOptions = {
  readonly stream: StreamFn
  readonly toolRegistry?: ToolRegistry
  readonly permissionGate?: PermissionGate
  readonly provider?: string
  readonly model?: string
  readonly executionPolicy?: SessionExecutionPolicy
  readonly runtimeTiming?: RunnerTimingPolicy
  readonly approvalPolicy?: ApprovalPolicy
  readonly baseInstructions?: string
  readonly modelContextWindowTokens?: number
  readonly loadProjectInstructions?: typeof loadProjectInstructions
  readonly now?: () => Date
  readonly rolloutAssets?: RolloutAssets
  readonly onOperationalFailure?: TurnProcessorOperationalFailureReporter
  readonly agentControl?: AgentControl
}

export type TurnProcessorOperationalFailure = Readonly<{
  operation:
    | "abort-model-stream"
    | "close-model-stream"
    | "compact"
    | "execute-tool"
  cause: unknown
}>

export type TurnProcessorOperationalFailureReporter = (
  failure: TurnProcessorOperationalFailure,
) => void | Promise<void>

type CompactionState = {
  consecutiveFailures: number
  failedHistoryLength: number | undefined
}

export function createTurnProcessor(
  options: TurnProcessorOptions,
): TurnProcessor {
  const toolRegistry = options.toolRegistry ?? createToolRegistry()
  const permissionGate = options.permissionGate ?? createPermissionGate()
  const executionPolicy =
    options.executionPolicy ?? createSessionExecutionPolicy()
  const runtimeTiming = options.runtimeTiming ?? createRunnerTimingPolicy()
  const approvalPolicy = options.approvalPolicy ?? "never"
  const provider = options.provider ?? "faux"
  const model = options.model ?? "scripted"
  const projectInstructionLoader =
    options.loadProjectInstructions ?? loadProjectInstructions
  const compactionState: CompactionState = {
    consecutiveFailures: 0,
    failedHistoryLength: undefined,
  }

  return {
    prepare(snapshot, input) {
      const metadata = snapshot.metadata
      if (
        metadata.mateId === undefined ||
        metadata.mateRevisionId === undefined
      ) {
        throw new Error("Thread is missing Mate attribution for execution.")
      }
      if (metadata.workingDirectory === undefined) {
        throw new Error("Thread is missing a working directory for execution.")
      }
      const selection: ModelSelection = input.modelSelection ??
        snapshot.configuration?.defaultTarget ?? { provider, model }
      const configuration =
        snapshot.configuration === undefined
          ? SessionConfiguration.create({
              selection,
              workspaceRoot: metadata.workingDirectory,
              enabledTools: toolRegistry.tools.map((tool) => tool.name),
              approvalPolicy,
              promptCacheKey: metadata.conversationId,
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
          : SessionConfiguration.restore({
              ...snapshot.configuration,
              defaultTarget: selection,
            })
      return {
        turnId: input.submissionId,
        configuration: configuration.snapshot,
        selection,
      }
    },

    prepareSteering(snapshot, input) {
      if (
        snapshot.configuration === undefined ||
        input.modelSelection === undefined
      ) {
        return undefined
      }
      return SessionConfiguration.restore({
        ...snapshot.configuration,
        defaultTarget: input.modelSelection,
      }).snapshot
    },

    start(runtime, input, context, control) {
      const forcedAbort = new AbortController()
      const signal = AbortSignal.any([control.signal, forcedAbort.signal])
      let activeStream: AsyncIterator<ModelStreamEvent> | undefined
      const completion = executeTurn({
        runtime,
        input,
        context,
        control,
        signal,
        toolRegistry,
        permissionGate,
        runtimeTiming,
        projectInstructionLoader,
        compactionState,
        options,
        setActiveStream(stream) {
          activeStream = stream
        },
      })
      return {
        completion,
        abort() {
          forcedAbort.abort()
          void activeStream?.return?.().catch((cause) =>
            reportOperationalFailure(options.onOperationalFailure, {
              operation: "abort-model-stream",
              cause,
            }),
          )
        },
      }
    },
  }
}

async function executeTurn(input: {
  readonly runtime: TurnRuntime
  readonly input: TurnInput
  readonly context: TurnContextItem
  readonly control: TurnControl
  readonly signal: AbortSignal
  readonly toolRegistry: ToolRegistry
  readonly permissionGate: PermissionGate
  readonly runtimeTiming: RunnerTimingPolicy
  readonly projectInstructionLoader: typeof loadProjectInstructions
  readonly compactionState: CompactionState
  readonly options: TurnProcessorOptions
  readonly setActiveStream: (
    stream: AsyncIterator<ModelStreamEvent> | undefined,
  ) => void
}): Promise<void> {
  const metadata = input.runtime.snapshot().metadata
  const configuration = SessionConfiguration.restore(
    input.context.configuration,
  ).resolveTurn(input.context.selection)
  const turn = createTurnContext({
    configuration,
    mateId: requireValue(metadata.mateId, "Mate id"),
    mateRevisionId: requireValue(metadata.mateRevisionId, "Mate revision id"),
  })
  const usages: ModelUsage[] = []
  let modelCalls = 0
  let toolCalls = 0

  while (modelCalls < turn.execution.executionPolicy.modelCallsPerTurn) {
    throwIfAborted(input.signal)
    await recordSteering(input.runtime, input.control.takeSteering())
    const workspaceRoot = await resolveWorkspaceRoot(
      turn.configuration.workspaceRoot,
    )
    const projectInstructions = await input.projectInstructionLoader({
      workspaceRoot,
      workingDirectory: turn.configuration.workspaceRoot,
    })
    const environment = observeEnvironment({
      workspaceRoot,
      workingDirectory: turn.configuration.workspaceRoot,
      ...(input.options.now === undefined ? {} : { now: input.options.now() }),
    })
    const beforeStep = input.runtime.snapshot()
    const priorModelId = previousModelId(
      beforeStep.context.history,
      input.context,
    )
    const worldState = buildWorldStateFromSnapshot({
      configuration: turn.configuration,
      ...(baseModelId(input.context) === undefined
        ? {}
        : { baseModelId: baseModelId(input.context) }),
      ...(priorModelId === undefined ? {} : { previousModelId: priorModelId }),
      environment,
      ...(projectInstructions === undefined ? {} : { projectInstructions }),
      ...(input.options.agentControl === undefined
        ? {}
        : {
            multiAgent: input.options.agentControl.runtimeContext(metadata.id),
          }),
    })
    const worldDiff = diffWorldState(
      beforeStep.context.worldStateBaseline,
      worldState,
    )
    if (worldDiff !== undefined) {
      await input.runtime.recordWorldStateUpdate(
        worldDiff.fragments.map((fragment) =>
          envelope(input.input.submissionId, {
            role: fragment.role,
            content: [{ type: "text", text: fragment.text }],
            context: {
              type: "world_state",
              sectionId: fragment.id,
              revision: fragment.revision,
            },
          }),
        ),
        {
          full: worldDiff.full,
          state: worldDiff.state,
          snapshot: worldDiff.snapshot,
        },
      )
    }

    const toolPlan = input.toolRegistry.finalize(
      new Set(turn.configuration.enabledTools),
    )
    const durableMessages = completeToolCallHistory(
      input.runtime.snapshot().context.history.map((entry) => entry.item),
    )
    const messages = limitToolResults(
      durableMessages,
      turn.execution.executionPolicy.modelVisibleToolResultBytes,
      turn.execution.executionPolicy.modelVisibleToolResultLines,
    )
    const visibleFileObservations =
      createVisibleFileObservationsFromMessages(messages)
    const adapted = adaptImagesForModel(messages, turn.configuration.target)
    const request: ModelRequest = {
      target: turn.configuration.target,
      cacheKey: turn.configuration.promptCacheKey,
      system: [turn.configuration.baseInstructions],
      messages: await resolveRolloutAssetImages(
        adapted.messages,
        input.options.rolloutAssets,
      ),
      tools: toolPlan.definitions,
      signal: input.signal,
    }
    const admission = assessModelRequest({
      request,
      rawMessages: messages,
      turn,
    })
    if (
      input.compactionState.failedHistoryLength !==
      beforeStep.context.history.length
    ) {
      input.compactionState.consecutiveFailures = 0
      input.compactionState.failedHistoryLength = undefined
    }
    if (
      admission.shouldCompact &&
      input.compactionState.consecutiveFailures < 3
    ) {
      const compacted = await compactLiveHistory({
        runtime: input.runtime,
        turnId: input.input.submissionId,
        turn,
        worldState,
        history: beforeStep.context.history,
        contextRevision: beforeStep.contextRevision,
        stream: input.options.stream,
        signal: input.signal,
        rolloutAssets: input.options.rolloutAssets,
        usages,
        compactionState: input.compactionState,
        onOperationalFailure: input.options.onOperationalFailure,
        setActiveStream: input.setActiveStream,
      })
      if (compacted) continue
    }
    if (admission.exceedsHardLimit) {
      throw new Error("The complete model request exceeds the context window.")
    }
    const responseItemId = `message_${globalThis.crypto.randomUUID()}`
    const response = await consumeModelStream({
      request,
      stream: input.options.stream,
      threadId: metadata.id,
      turnId: input.input.submissionId,
      itemId: responseItemId,
      emitModelStream: (event) => input.runtime.emitModelStream(event),
      assistantResponseBytes:
        turn.execution.executionPolicy.assistantResponseBytes,
      onOperationalFailure: input.options.onOperationalFailure,
      onUsage(usage) {
        usages.push(usage)
        const aggregate = aggregateTokenUsage(usages)
        if (aggregate !== undefined) input.runtime.recordUsage(aggregate)
      },
      setActiveStream: input.setActiveStream,
    })
    input.setActiveStream(undefined)
    modelCalls += 1
    throwIfAborted(input.signal)

    if (response.stopReason === ModelStopReason.Length) {
      throw new Error("Model response was truncated by length.")
    }
    if (response.stopReason === ModelStopReason.Error) {
      throw new Error(response.error?.message ?? "Model returned an error.")
    }
    if (response.stopReason === ModelStopReason.Aborted) {
      throw abortError()
    }

    const calls = response.content.filter(
      (block): block is ModelToolCallBlock => block.type === "tool_call",
    )
    if (response.stopReason === ModelStopReason.ToolUse && calls.length === 0) {
      throw new Error(
        "tool_use stop reason requires at least one complete tool call.",
      )
    }
    if (response.stopReason !== ModelStopReason.ToolUse && calls.length > 0) {
      throw new Error("Non-tool_use responses must not include tool calls.")
    }
    if (
      utf8Bytes(JSON.stringify(response.content)) >
      turn.execution.executionPolicy.assistantResponseBytes
    ) {
      throw new Error("Assistant response exceeded the configured byte limit.")
    }
    if (response.content.length > 0) {
      const responseItem = envelope(
        input.input.submissionId,
        { role: "assistant", content: response.content },
        {
          provider: turn.execution.provider,
          model: turn.execution.model,
          callIndex: modelCalls,
        },
        responseItemId,
      )
      await input.runtime.recordConversationItems([responseItem])
      await input.runtime.recordItemCompletions(
        completedResponseItems(responseItem),
      )
    }

    if (response.stopReason === ModelStopReason.ToolUse) {
      if (
        toolCalls + calls.length >
        turn.execution.executionPolicy.toolCallsPerTurn
      ) {
        throw new Error("Turn exceeded its tool call budget.")
      }
      toolCalls += calls.length
      const results = await executeToolCalls({
        calls,
        threadId: metadata.id,
        rolloutId: metadata.rolloutId,
        turnId: input.input.submissionId,
        workspaceRoot,
        signal: input.signal,
        toolPlan,
        permissionGate: input.permissionGate,
        emitItemStarted: input.runtime.emitItemStarted,
        publishPermissionEvent: (event) =>
          input.runtime.emitPermissionEvent(event),
        permissionTimeoutMs: input.runtimeTiming.permissionWaitTimeoutMs,
        approvalPolicy: turn.configuration.approvalPolicy,
        rolloutAssets: input.options.rolloutAssets,
        visibleFileObservations,
        onOperationalFailure: input.options.onOperationalFailure,
        ...(input.options.agentControl === undefined
          ? {}
          : {
              agentControl: input.options.agentControl.bind(
                metadata.id,
                turn.configuration.target,
              ),
            }),
      })
      for (const { call, item, result } of results) {
        const fileObservation = toolFileObservation(call.name, result)
        const resultItem = envelope(input.input.submissionId, {
          role: "tool",
          toolCallId: call.id,
          content: result.content,
          ...(!result.ok ? { isError: true } : {}),
          ...(fileObservation === undefined ? {} : { fileObservation }),
        })
        await input.runtime.recordConversationItems([resultItem])
        await input.runtime.recordItemCompletions([
          completeToolItem(toolPlan, item, resultItem.id, result),
        ])
      }
      continue
    }

    const completion = input.control.takeSteeringOrComplete()
    if (completion.type === "steering") {
      await recordSteering(input.runtime, completion.inputs)
      continue
    }
    return
  }
  throw new Error("Turn exceeded its model call budget.")
}

async function consumeModelStream(input: {
  readonly request: ModelRequest
  readonly stream: StreamFn
  readonly threadId: string
  readonly turnId: string
  readonly itemId?: string
  readonly emitModelStream?: TurnRuntime["emitModelStream"]
  readonly assistantResponseBytes: number
  readonly onOperationalFailure:
    | TurnProcessorOperationalFailureReporter
    | undefined
  readonly onUsage: (usage: ModelUsage) => void
  readonly setActiveStream: (
    stream: AsyncIterator<ModelStreamEvent> | undefined,
  ) => void
}): Promise<ModelResponse> {
  const iterator = input.stream(input.request)[Symbol.asyncIterator]()
  input.setActiveStream(iterator)
  let terminal: ModelResponse | undefined
  let exhausted = false
  try {
    for (;;) {
      const next = await iterator.next()
      if (next.done) {
        if (input.request.signal?.aborted) throw abortError()
        exhausted = true
        break
      }
      const event = next.value
      if (event.type !== "response") {
        if (input.request.signal?.aborted) throw abortError()
        if (utf8Bytes(event.text) > input.assistantResponseBytes) {
          throw new Error(
            "Model stream update exceeded the configured byte limit.",
          )
        }
        if (input.itemId !== undefined) {
          input.emitModelStream?.({
            itemId: input.itemId,
            kind:
              event.type === "reasoning_snapshot" ? "reasoning" : "assistant",
            text: event.text,
          })
        }
        continue
      }
      if (terminal !== undefined) {
        throw new Error("Model stream emitted more than one terminal response.")
      }
      terminal = event.response
      if (event.response.usage !== undefined)
        input.onUsage(event.response.usage)
    }
  } catch (error) {
    if (input.request.signal?.aborted || isAbortError(error)) {
      throw abortError()
    }
    throw error
  } finally {
    input.setActiveStream(undefined)
    if (!exhausted) {
      try {
        await iterator.return?.()
      } catch (error) {
        reportOperationalFailure(input.onOperationalFailure, {
          operation: "close-model-stream",
          cause: error,
        })
      }
    }
  }
  if (terminal === undefined) {
    throw new Error("Model stream ended without a terminal response.")
  }
  return terminal
}

function assessModelRequest(input: {
  readonly request: ModelRequest
  readonly rawMessages: readonly ModelMessage[]
  readonly turn: ReturnType<typeof createTurnContext>
}): { readonly shouldCompact: boolean; readonly exceedsHardLimit: boolean } {
  const limits = input.turn.execution.executionPolicy
  const messageBytes = utf8Bytes(JSON.stringify(input.rawMessages))
  const messageBlocks = input.rawMessages.reduce(
    (count, message) =>
      count +
      message.content.length +
      (message.role === "user" ? (message.images?.length ?? 0) : 0),
    0,
  )
  const requestTokens = estimateModelRequestBudget(
    input.request,
  ).requiredContextTokens
  const contextTokens =
    input.turn.configuration.modelCapacity?.effectiveContextWindowTokens
  const tokenTrigger =
    contextTokens === undefined
      ? undefined
      : Math.floor(
          contextTokens *
            input.turn.configuration.executionPolicy.compactionTriggerRatio,
        )
  return {
    shouldCompact:
      (limits.compactionTriggerContextBytes !== undefined &&
        messageBytes >= limits.compactionTriggerContextBytes) ||
      (tokenTrigger !== undefined && requestTokens >= tokenTrigger) ||
      messageBlocks > limits.modelVisibleMessageBlocks,
    exceedsHardLimit:
      messageBytes > limits.modelVisibleContextBytes ||
      messageBlocks > limits.modelVisibleMessageBlocks ||
      (contextTokens !== undefined && requestTokens > contextTokens),
  }
}

async function compactLiveHistory(input: {
  readonly runtime: TurnRuntime
  readonly turnId: string
  readonly turn: ReturnType<typeof createTurnContext>
  readonly worldState: WorldState
  readonly history: readonly ResponseItemEnvelope[]
  readonly contextRevision: number
  readonly stream: StreamFn
  readonly signal: AbortSignal
  readonly rolloutAssets: RolloutAssets | undefined
  readonly usages: ModelUsage[]
  readonly compactionState: CompactionState
  readonly onOperationalFailure:
    | TurnProcessorOperationalFailureReporter
    | undefined
  readonly setActiveStream: (
    stream: AsyncIterator<ModelStreamEvent> | undefined,
  ) => void
}): Promise<boolean> {
  const groups: Array<{
    readonly turnId: string
    readonly items: ResponseItemEnvelope[]
  }> = []
  for (const item of input.history) {
    const group = groups.at(-1)
    if (group?.turnId === item.turnId) group.items.push(item)
    else groups.push({ turnId: item.turnId, items: [item] })
  }
  const currentIndex = groups.findIndex(
    (group) => group.turnId === input.turnId,
  )
  const historyEnd = currentIndex < 0 ? groups.length : currentIndex
  const historyGroups = groups.slice(0, historyEnd)
  const retainBytes =
    input.turn.execution.executionPolicy.compactionRetainContextBytes ?? 0
  let retainedBytes = utf8Bytes(JSON.stringify(groups.slice(historyEnd)))
  let keepFromIndex = historyGroups.length
  for (let index = historyGroups.length - 1; index >= 0; index -= 1) {
    if (retainedBytes >= retainBytes) break
    const group = historyGroups[index]
    if (group === undefined) break
    retainedBytes += utf8Bytes(JSON.stringify(group.items))
    keepFromIndex = index
  }
  let sourceGroups = historyGroups.slice(0, keepFromIndex)
  if (sourceGroups.length === 0) {
    return false
  }

  const compactionItem: StartedExecutionItem = {
    type: "context_compaction",
    itemId: `compaction_${globalThis.crypto.randomUUID()}`,
  }
  input.runtime.emitItemStarted(compactionItem)

  try {
    const compact = async (request: ModelRequest) => {
      const response = await consumeModelStream({
        request,
        stream: input.stream,
        threadId: input.runtime.snapshot().metadata.id,
        turnId: input.turnId,
        assistantResponseBytes:
          input.turn.configuration.executionPolicy.compactionSummaryBytes,
        onOperationalFailure: input.onOperationalFailure,
        onUsage(usage) {
          input.usages.push(usage)
          const aggregate = aggregateTokenUsage(input.usages)
          if (aggregate !== undefined) input.runtime.recordUsage(aggregate)
        },
        setActiveStream: input.setActiveStream,
      })
      if (response.stopReason === ModelStopReason.Error) {
        throw new Error(response.error?.message ?? "Model returned an error.")
      }
      if (response.stopReason === ModelStopReason.Length) {
        throw new Error("Compaction was truncated by the model output limit.")
      }
      if (response.stopReason === ModelStopReason.Aborted) throw abortError()
      const summary = response.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("")
        .trim()
      if (summary.length === 0) {
        throw new Error("Compaction produced an empty checkpoint.")
      }
      const usage =
        response.usage === undefined
          ? undefined
          : aggregateTokenUsage([response.usage])
      return {
        summary,
        ...(usage === undefined ? {} : { usage }),
      }
    }
    const capacity =
      input.turn.configuration.modelCapacity?.effectiveContextWindowTokens
    let result: Awaited<ReturnType<typeof compact>> | undefined
    let attempts = 0
    while (result === undefined) {
      const hydratedSource = await Promise.all(
        sourceGroups.map(async (group) => ({
          messages: await resolveRolloutAssetImages(
            adaptImagesForModel(
              limitToolResults(
                completeToolCallHistory(group.items.map((item) => item.item)),
                input.turn.execution.executionPolicy
                  .modelVisibleToolResultBytes,
                input.turn.execution.executionPolicy
                  .modelVisibleToolResultLines,
              ),
              input.turn.configuration.target,
            ).messages,
            input.rolloutAssets,
          ),
        })),
      )
      try {
        const request = buildCompactionRequest({
          source: hydratedSource,
          target: input.turn.configuration.target,
          baseInstructions: input.turn.configuration.baseInstructions,
          cacheKey: input.turn.configuration.promptCacheKey,
          signal: input.signal,
        })
        result =
          capacity !== undefined &&
          estimateModelRequestBudget(request).requiredContextTokens > capacity
            ? await runTwoPassCompaction({
                source: hydratedSource,
                target: input.turn.configuration.target,
                baseInstructions: input.turn.configuration.baseInstructions,
                cacheKey: input.turn.configuration.promptCacheKey,
                capacityTokens: capacity,
                signal: input.signal,
                compact,
              })
            : await compact(request)
        if (result === undefined) {
          throw new Error("Compaction context length exceeds the model window.")
        }
      } catch (error) {
        if (input.signal.aborted || isAbortError(error)) throw error
        attempts += 1
        const reducedLength = Math.ceil(sourceGroups.length / 2)
        if (
          !isContextOverflowError(error) ||
          attempts >= 3 ||
          reducedLength === sourceGroups.length
        ) {
          throw error
        }
        sourceGroups = sourceGroups.slice(0, reducedLength)
      }
    }
    if (
      utf8Bytes(result.summary) >
      input.turn.configuration.executionPolicy.compactionSummaryBytes
    ) {
      throw new Error(
        "Compaction checkpoint exceeded its configured byte limit.",
      )
    }

    const fullWorldState = diffWorldState(undefined, input.worldState)
    if (fullWorldState === undefined) {
      throw new Error(
        "World-state snapshot could not be rendered for compaction.",
      )
    }
    const generated = createCompactionReplacementHistory({
      summary: result.summary,
      worldStateFragments: fullWorldState.fragments,
    }).map((message) => envelope(input.turnId, message))
    const retained = groups
      .slice(sourceGroups.length)
      .flatMap((group) => group.items)
      .filter((item) => !isWorldStateMessage(item.item))
    const replacement = [...generated, ...retained]
    const sourceBytes = utf8Bytes(
      JSON.stringify(sourceGroups.flatMap((group) => group.items)),
    )
    if (utf8Bytes(JSON.stringify(generated)) >= sourceBytes) {
      await input.runtime.recordItemCompletions([
        completeCompactionItem(
          compactionItem,
          "failed",
          new Error("Compaction did not reduce the retained history."),
        ),
      ])
      input.compactionState.consecutiveFailures += 1
      input.compactionState.failedHistoryLength = input.history.length
      return false
    }
    await input.runtime.replaceConversationHistory({
      replacement,
      summary: result.summary,
      baseContextRevision: input.contextRevision,
      baseHistoryLength: input.history.length,
    })
    await input.runtime.recordWorldStateUpdate([], {
      full: true,
      state: fullWorldState.state,
      snapshot: fullWorldState.snapshot,
    })
    await input.runtime.recordItemCompletions([
      completeCompactionItem(compactionItem, "completed"),
    ])
    input.compactionState.consecutiveFailures = 0
    input.compactionState.failedHistoryLength = undefined
    return true
  } catch (error) {
    if (input.signal.aborted || isAbortError(error)) throw abortError()
    await input.runtime.recordItemCompletions([
      completeCompactionItem(compactionItem, "failed", error),
    ])
    input.compactionState.consecutiveFailures += 1
    input.compactionState.failedHistoryLength = input.history.length
    if (isContextOverflowError(error)) return false
    reportOperationalFailure(input.onOperationalFailure, {
      operation: "compact",
      cause: error,
    })
    return false
  }
}

type ToolExecutionScope = {
  readonly threadId: string
  readonly rolloutId: string
  readonly turnId: string
  readonly workspaceRoot: string
  readonly signal: AbortSignal
  readonly toolPlan: ReturnType<ToolRegistry["finalize"]>
  readonly permissionGate: PermissionGate
  readonly emitItemStarted: TurnRuntime["emitItemStarted"]
  readonly publishPermissionEvent: TurnRuntime["emitPermissionEvent"]
  readonly permissionTimeoutMs: number
  readonly approvalPolicy: ApprovalPolicy
  readonly rolloutAssets: RolloutAssets | undefined
  readonly visibleFileObservations: VisibleFileObservations
  readonly onOperationalFailure:
    | TurnProcessorOperationalFailureReporter
    | undefined
  readonly agentControl?: BoundAgentControl
}

type PreparedToolCall = {
  readonly call: ModelToolCallBlock
  readonly item: ToolExecutionItem
  readonly permission?: ToolPermissionRequest
  readonly preparationError?: unknown
}

async function executeToolCalls(
  input: ToolExecutionScope & { readonly calls: readonly ModelToolCallBlock[] },
): Promise<
  readonly {
    readonly call: ModelToolCallBlock
    readonly item: ToolExecutionItem
    readonly result: ToolExecutionResult
  }[]
> {
  const prepared = await Promise.all(
    input.calls.map(async (call): Promise<PreparedToolCall> => {
      const descriptor = input.toolPlan.describeExecution(call.name, call.input)
      try {
        const requirement = await input.toolPlan.approvalRequirement(
          call.name,
          call.input,
          { workspaceRoot: input.workspaceRoot },
        )
        const permission = resolveToolPermissionRequest(
          requirement,
          input.approvalPolicy,
        )
        return {
          call,
          item: {
            itemId: `tool_${globalThis.crypto.randomUUID()}`,
            toolCallId: call.id,
            name: call.name,
            input: call.input,
            requiresPermission: permission !== undefined,
            ...descriptor,
          },
          ...(permission === undefined ? {} : { permission }),
        }
      } catch (error) {
        return {
          call,
          item: {
            itemId: `tool_${globalThis.crypto.randomUUID()}`,
            toolCallId: call.id,
            name: call.name,
            input: call.input,
            requiresPermission: false,
            ...descriptor,
          },
          preparationError: error,
        }
      }
    }),
  )
  for (const item of prepared) input.emitItemStarted(item.item)
  const firstBarrier = prepared.findIndex((item) => {
    const effect = input.toolPlan.get(item.call.name)?.effect ?? "opaque"
    return (
      effect !== "observe" ||
      item.permission !== undefined ||
      item.preparationError !== undefined
    )
  })
  const prefix = firstBarrier < 0 ? prepared : prepared.slice(0, firstBarrier)
  const rest = firstBarrier < 0 ? [] : prepared.slice(firstBarrier)
  const results: Array<{
    readonly call: ModelToolCallBlock
    readonly item: ToolExecutionItem
    readonly result: ToolExecutionResult
  }> = []

  const settled = await Promise.allSettled(
    prefix.map(async (item) => ({
      call: item.call,
      item: item.item,
      result: await executePreparedTool(input, item),
    })),
  )
  let firstError: unknown
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") results.push(outcome.value)
    else if (firstError === undefined) firstError = outcome.reason
  }
  if (firstError !== undefined) throw firstError

  for (const item of rest) {
    throwIfAborted(input.signal)
    const executed = {
      call: item.call,
      item: item.item,
      result: await executePreparedTool(input, item),
    }
    results.push(executed)
    if (input.toolPlan.get(item.call.name)?.effect !== "observe") {
      const observation = toolFileObservation(item.call.name, executed.result)
      if (observation !== undefined) {
        input.visibleFileObservations.apply(observation)
      }
    }
  }
  return results
}

function completedResponseItems(
  response: ResponseItemEnvelope,
): readonly CompletedExecutionItem[] {
  if (response.item.role !== "assistant") return []
  const providerMetadata = response.providerMetadata
  const reasoning = response.item.content
    .filter((block) => block.type === "reasoning")
    .map((block) => block.text)
    .join("")
  const content = response.item.content.filter((block) => block.type === "text")
  return [
    ...(reasoning.length === 0
      ? []
      : [
          {
            type: "reasoning" as const,
            itemId: `${response.id}_reasoning`,
            text: reasoning,
            ...(providerMetadata === undefined ? {} : { providerMetadata }),
          },
        ]),
    ...(content.every((block) => block.text.length === 0)
      ? []
      : [
          {
            type: "agent_message" as const,
            itemId: response.id,
            content,
            ...(providerMetadata === undefined ? {} : { providerMetadata }),
          },
        ]),
  ]
}

function completeToolItem(
  toolPlan: ReturnType<ToolRegistry["finalize"]>,
  started: ToolExecutionItem,
  resultItemId: string,
  result: ToolExecutionResult,
): CompletedExecutionItem {
  const completed = completeToolExecution(toolPlan, started, result)
  return {
    ...completed,
    resultItemId,
    content: { kind: "text", text: result.content },
    ...(result.output === undefined ? {} : { output: result.output }),
    ...(result.ok
      ? {}
      : {
          error: {
            message: result.message,
            code: result.code,
          },
        }),
  }
}

function completeToolExecution(
  toolPlan: ReturnType<ToolRegistry["finalize"]>,
  started: ToolExecutionItem,
  result: ToolExecutionResult,
): ToolExecutionItem {
  if (result.output === undefined) return started
  const descriptor = toolPlan.completeExecution(
    started.name,
    started,
    result.output,
    result.ok,
  )
  if (descriptor.type !== started.type) {
    throw new Error(
      `Tool ${started.name} changed execution type from ${started.type} to ${descriptor.type}.`,
    )
  }
  // The runtime check preserves the discriminated-union member while the
  // registry's provider-neutral return type intentionally erases that link.
  return { ...started, ...descriptor } as ToolExecutionItem
}

function completeCompactionItem(
  started: Extract<
    StartedExecutionItem,
    { readonly type: "context_compaction" }
  >,
  status: ContextCompactionCompletedItem["status"],
  error?: unknown,
): ContextCompactionCompletedItem {
  const kernelError: KernelError | undefined =
    error === undefined
      ? undefined
      : { message: error instanceof Error ? error.message : String(error) }
  return {
    ...started,
    status,
    ...(kernelError === undefined ? {} : { error: kernelError }),
  }
}

async function executePreparedTool(
  input: ToolExecutionScope,
  prepared: PreparedToolCall,
): Promise<ToolExecutionResult> {
  try {
    if (prepared.preparationError !== undefined) {
      throw prepared.preparationError
    }
    if (prepared.permission !== undefined) {
      const outcome = await input.permissionGate.request({
        sessionId: input.threadId,
        turnId: input.turnId,
        toolCallId: prepared.call.id,
        action: prepared.permission.action,
        ...(prepared.permission.subject === undefined
          ? {}
          : { subject: prepared.permission.subject }),
        ...(prepared.permission.reason === undefined
          ? {}
          : { reason: prepared.permission.reason }),
        signal: input.signal,
        timeoutMs: input.permissionTimeoutMs,
        publish: input.publishPermissionEvent,
      })
      if (outcome.kind !== "allow") {
        const message =
          outcome.reason?.message ?? `Tool permission ${outcome.kind}.`
        return {
          ok: false,
          code: `permission_${outcome.kind}`,
          message,
          content: message,
        }
      }
    }
    return await input.toolPlan.execute(
      prepared.call.name,
      prepared.call.input,
      {
        workspaceRoot: input.workspaceRoot,
        rolloutId: input.rolloutId,
        toolCallId: prepared.call.id,
        signal: input.signal,
        ...(input.rolloutAssets === undefined
          ? {}
          : { rolloutAssets: input.rolloutAssets }),
        visibleFileObservations: input.visibleFileObservations,
        ...(input.agentControl === undefined
          ? {}
          : { agentControl: input.agentControl }),
      },
    )
  } catch (error) {
    if (input.signal.aborted || isAbortError(error)) throw abortError()
    reportOperationalFailure(input.onOperationalFailure, {
      operation: "execute-tool",
      cause: error,
    })
    const message = error instanceof Error ? error.message : "Tool failed."
    return {
      ok: false,
      code: "tool_execution_failed",
      message,
      content: `tool_execution_failed: ${message}`,
    }
  }
}

function toolFileObservation(name: string, result: ToolExecutionResult) {
  return result.ok ? grantFromToolOutput(name, result.output) : undefined
}

function limitToolResults(
  messages: readonly ModelMessage[],
  maxBytes: number,
  maxLines: number,
): readonly ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool") return message
    const lines = message.content.split("\n")
    let content = message.content
    let truncated = false
    if (lines.length > maxLines) {
      content = `${lines.slice(0, maxLines).join("\n")}\n...[truncated ${String(lines.length - maxLines)} lines]`
      truncated = true
    }
    if (utf8Bytes(content) > maxBytes) {
      const suffix = "\n...[truncated bytes]"
      const visibleSuffix = truncateUtf8(suffix, maxBytes)
      const targetBytes = Math.max(0, maxBytes - utf8Bytes(visibleSuffix))
      content = `${truncateUtf8(content, targetBytes)}${visibleSuffix}`
      truncated = true
    }
    if (!truncated) return message
    const { fileObservation: _fileObservation, ...visible } = message
    return { ...visible, content }
  })
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value)
  if (bytes.byteLength <= maxBytes) return value
  let end = maxBytes
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 0b10) end -= 1
  return bytes.subarray(0, end).toString("utf8")
}

async function recordSteering(
  runtime: TurnRuntime,
  steering: readonly TurnInput[],
): Promise<void> {
  if (steering.length === 0) return
  await runtime.recordConversationItems(
    steering.map((item) => inputEnvelope(item, item.submissionId)),
  )
}

function inputEnvelope(input: TurnInput, turnId: string): ResponseItemEnvelope {
  return {
    ...envelope(turnId, {
      role: "user",
      content:
        input.content.text.length === 0
          ? []
          : [{ type: "text", text: input.content.text }],
      ...(input.content.attachments === undefined ||
      input.content.attachments.length === 0
        ? {}
        : {
            images: input.content.attachments.map((attachment) => ({
              type: "image" as const,
              mediaType: attachment.mediaType,
              detail: attachment.detail ?? "high",
              file: attachment.file,
              sizeBytes: attachment.sizeBytes,
            })),
          }),
    }),
    ...(input.modelSelection === undefined &&
    input.parentInputId === undefined &&
    input.metadata === undefined
      ? {}
      : {
          submissionMetadata: {
            ...(input.modelSelection === undefined
              ? {}
              : { modelSelection: input.modelSelection }),
            ...(input.parentInputId === undefined
              ? {}
              : { parentInputId: input.parentInputId }),
            ...(input.metadata === undefined
              ? {}
              : { metadata: input.metadata }),
          },
        }),
  }
}

function envelope(
  turnId: string,
  item: ModelMessage,
  providerMetadata?: JsonObject,
  id = `message_${globalThis.crypto.randomUUID()}`,
): ResponseItemEnvelope {
  return {
    id,
    turnId,
    createdAt: new Date().toISOString(),
    item,
    ...(providerMetadata === undefined ? {} : { providerMetadata }),
  }
}

async function resolveRolloutAssetImages(
  messages: readonly ModelMessage[],
  rolloutAssets: RolloutAssets | undefined,
): Promise<readonly ModelMessage[]> {
  return Promise.all(
    messages.map(async (message): Promise<ModelMessage> => {
      if (message.role !== "user" || message.images === undefined)
        return message
      const images = await Promise.all(
        message.images.map(async (image) => {
          if ("data" in image && image.data !== undefined) return image
          if (rolloutAssets === undefined) {
            throw new Error("Rollout image storage is unavailable.")
          }
          const bytes = await rolloutAssets.read(image.file)
          if (bytes.byteLength !== image.sizeBytes) {
            throw new Error(
              "Rollout image size does not match its recorded size.",
            )
          }
          return {
            type: "image" as const,
            mediaType: image.mediaType,
            detail: image.detail ?? "high",
            data: bytes.toString("base64"),
          }
        }),
      )
      return { ...message, images }
    }),
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
      cacheReadInputTokens:
        (total.cacheReadInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0),
      cacheWriteInputTokens:
        (total.cacheWriteInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0 },
  )
}

function completeToolCallHistory(
  messages: readonly ModelMessage[],
): readonly ModelMessage[] {
  const completed: ModelMessage[] = []
  let pending: string[] = []
  const flushMissing = () => {
    completed.push(
      ...pending.map((toolCallId) => ({
        role: "tool" as const,
        toolCallId,
        content: MISSING_TOOL_RESULT_TEXT,
        isError: true,
      })),
    )
    pending = []
  }
  for (const message of messages) {
    if (message.role === "tool" && pending.includes(message.toolCallId)) {
      completed.push(message)
      pending = pending.filter((id) => id !== message.toolCallId)
      continue
    }
    if (pending.length > 0) flushMissing()
    completed.push(message)
    if (message.role === "assistant") {
      pending = message.content.flatMap((block) =>
        block.type === "tool_call" ? [block.id] : [],
      )
    }
  }
  if (pending.length > 0) flushMissing()
  return completed
}

function previousModelId(
  history: readonly ResponseItemEnvelope[],
  context: TurnContextItem,
): string | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index]
    if (item?.item.role !== "assistant") continue
    const provider = item.providerMetadata?.provider
    const model = item.providerMetadata?.model
    if (typeof provider === "string" && typeof model === "string") {
      return `${provider}/${model}`
    }
  }
  const provenance = context.configuration.baseInstructions.provenance
  return provenance.type === "model"
    ? `${provenance.provider}/${provenance.model}`
    : undefined
}

function baseModelId(context: TurnContextItem): string | undefined {
  const provenance = context.configuration.baseInstructions.provenance
  return provenance.type === "model"
    ? `${provenance.provider}/${provenance.model}`
    : undefined
}

function isWorldStateMessage(message: ModelMessage): boolean {
  return (
    (message.role === "user" || message.role === "developer") &&
    message.context?.type === "world_state"
  )
}

function reportOperationalFailure(
  callback: TurnProcessorOperationalFailureReporter | undefined,
  failure: TurnProcessorOperationalFailure,
): void {
  try {
    const result = callback?.(failure)
    if (result !== undefined) void Promise.resolve(result).catch(() => {})
  } catch {
    // Observability callbacks cannot break Turn lifecycle or cleanup.
  }
}

function requireValue(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`${name} is required.`)
  return value
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function abortError(): Error {
  return new DOMException("Turn aborted.", "AbortError")
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}
