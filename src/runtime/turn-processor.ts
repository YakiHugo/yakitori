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
import type { AgentControl, BoundAgentControl } from "./agent-control.ts"
import {
  buildCompactionRequest,
  canRetryCompactionWithCurrentModel,
  isContextOverflowError,
  trimRemoteCompactionToolTail,
} from "./compaction.ts"
import { observeEnvironment } from "./environment-context.ts"
import { isAbortError, ModelResponseError } from "./errors.ts"
import { HookEvent, type HookRunner } from "./hooks.ts"
import type { RolloutBudget } from "./rollout-budget.ts"
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
import type { ModelClient } from "./model-provider.ts"
import {
  createCompactionReplacementHistory,
  retainCompactionUserMessages,
  retainRemoteCompactionMessages,
} from "./model-context.ts"
import { adaptImagesForModel } from "./model-images.ts"
import {
  estimateHistoryTokens,
  estimateModelRequestBudget,
} from "./model-request-budget.ts"
import { createPermissionGate, type PermissionGate } from "./permission-gate.ts"
import {
  createProjectInstructionsLoader,
  type loadProjectInstructions,
} from "./project-instructions.ts"
import {
  type ApprovalPolicy,
  createTurnContext,
  SessionConfiguration,
} from "./session-configuration.ts"
import { loadSkillsCatalog } from "./skills.ts"
import {
  createToolExecutionGate,
  type ToolExecutionGate,
  type ToolExecutionReservation,
} from "./tool-execution-gate.ts"
import { resolveToolPermissionRequest } from "./tool-permissions.ts"
import { resolveWorkspaceRoot } from "./tools/path-policy.ts"
import { createToolRegistry, type ToolRegistry } from "./tools/registry.ts"
import { captureStepContext, type StepContext } from "./tools/spec-plan.ts"
import type {
  ToolExecutionResult,
  ToolPermissionRequest,
} from "./tools/types.ts"

import {
  createVisibleFileObservationsFromMessages,
  grantsFromToolOutput,
  type VisibleFileObservations,
} from "./tools/visible-file-observations.ts"
import {
  buildWorldStateFromSnapshot,
  diffWorldState,
  type WorldState,
} from "./world-state.ts"

export type TurnProcessorOptions = {
  readonly modelClient?: ModelClient
  readonly stream?: StreamFn
  readonly toolRegistry?: ToolRegistry
  readonly permissionGate?: PermissionGate
  readonly provider?: string
  readonly model?: string
  readonly executionPolicy?: SessionExecutionPolicy
  readonly runtimeTiming?: RunnerTimingPolicy
  readonly approvalPolicy?: ApprovalPolicy
  readonly baseInstructions?: string
  readonly modelContextWindowTokens?: number
  readonly modelAutoCompactTokenLimit?: number
  readonly modelAutoCompactTokenLimitScope?: import("../kernel/index.ts").AutoCompactTokenLimitScope
  readonly loadProjectInstructions?: typeof loadProjectInstructions
  readonly resolveShellName?: () => Promise<string>
  readonly now?: () => Date
  readonly rolloutAssets?: RolloutAssets
  readonly onOperationalFailure?: TurnProcessorOperationalFailureReporter
  readonly agentControl?: AgentControl
  readonly hookRunner?: HookRunner
  readonly sessionHookContext?: Readonly<{
    sessionId: string
    workspaceRoot: string
    source: "startup" | "resume"
    isSubagent: boolean
  }>
}

export type TurnProcessorOperationalFailure = Readonly<{
  operation:
    | "abort-model-stream"
    | "close-model-session"
    | "close-model-stream"
    | "compact"
    | "execute-hook"
    | "execute-tool"
  cause: unknown
}>

export type TurnProcessorOperationalFailureReporter = (
  failure: TurnProcessorOperationalFailure,
) => void | Promise<void>

export function createTurnProcessor(
  options: TurnProcessorOptions,
): TurnProcessor {
  if (options.modelClient === undefined && options.stream === undefined) {
    throw new Error("Turn processor requires a model client or stream.")
  }
  const toolRegistry = options.toolRegistry ?? createToolRegistry()
  const permissionGate = options.permissionGate ?? createPermissionGate()
  const executionPolicy =
    options.executionPolicy ?? createSessionExecutionPolicy()
  const runtimeTiming = options.runtimeTiming ?? createRunnerTimingPolicy()
  const approvalPolicy = options.approvalPolicy ?? "always_approve"
  const provider = options.provider ?? "faux"
  const model = options.model ?? "scripted"
  const projectInstructionLoader =
    options.loadProjectInstructions ?? createProjectInstructionsLoader()
  const toolExecutionGate = createToolExecutionGate()
  let sessionHooksStarted = false
  let startHooksPromise: Promise<void> | undefined

  const ensureSessionHooks = (
    runtime: TurnRuntime,
    turnId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    if (options.hookRunner === undefined || options.sessionHookContext === undefined) {
      return Promise.resolve()
    }
    if (sessionHooksStarted) return Promise.resolve()
    if (startHooksPromise !== undefined) return startHooksPromise
    const context = options.sessionHookContext
    const run = async () => {
      const events = [
        context.isSubagent ? HookEvent.SubagentStart : HookEvent.SessionStart,
      ]
      for (const event of events) {
        const outcome = await options.hookRunner?.run({
          event,
          payload: {
            session_id: context.sessionId,
            source: context.source,
          },
          cwd: context.workspaceRoot,
          signal,
        })
        if (outcome?.continue === false) {
          throw new Error(outcome.reason ?? `${event} hook blocked the Session.`)
        }
        await recordHookContext(runtime, turnId, outcome?.additionalContext ?? [])
      }
      sessionHooksStarted = true
    }
    startHooksPromise = run().catch((error) => {
      startHooksPromise = undefined
      throw error
    })
    return startHooksPromise
  }

  return {
    async dispose() {
      const lifecycle = async () => {
        if (
          !sessionHooksStarted ||
          options.hookRunner === undefined ||
          options.sessionHookContext === undefined
        ) {
          return
        }
        const context = options.sessionHookContext
        const events = context.isSubagent ? [] : [HookEvent.SessionEnd]
        for (const event of events) {
          await options.hookRunner.run({
            event,
            payload: {
              session_id: context.sessionId,
              reason: "shutdown",
            },
            cwd: context.workspaceRoot,
          })
        }
      }
      const lifecycleResults = await Promise.allSettled([lifecycle()])
      const resourceResults = await Promise.allSettled([
        Promise.resolve().then(() => options.modelClient?.close()),
        Promise.resolve().then(() => toolRegistry.dispose()),
      ])
      const errors = [...lifecycleResults, ...resourceResults].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      )
      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to dispose Turn processor.")
      }
    },
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
      const models = options.modelClient?.models(selection.provider)
      const configuration =
        snapshot.configuration === undefined
          ? SessionConfiguration.create(
              {
                selection,
                workspaceRoot: metadata.workingDirectory,
                enabledTools: toolRegistry.trustedToolNames(),
                approvalPolicy,
                promptCacheKey: metadata.conversationId,
                ...(options.baseInstructions === undefined
                  ? {}
                  : { baseInstructions: options.baseInstructions }),
                executionPolicy,
                ...(options.modelContextWindowTokens === undefined
                  ? {}
                  : {
                      modelContextWindowTokens:
                        options.modelContextWindowTokens,
                    }),
                ...(options.modelAutoCompactTokenLimit === undefined
                  ? {}
                  : {
                      modelAutoCompactTokenLimit:
                        options.modelAutoCompactTokenLimit,
                    }),
                ...(options.modelAutoCompactTokenLimitScope === undefined
                  ? {}
                  : {
                      modelAutoCompactTokenLimitScope:
                        options.modelAutoCompactTokenLimitScope,
                    }),
              },
              models,
            )
          : SessionConfiguration.restore(
              {
                ...snapshot.configuration,
                defaultTarget: selection,
              },
              models,
            )
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
      return SessionConfiguration.restore(
        {
          ...snapshot.configuration,
          defaultTarget: input.modelSelection,
        },
        options.modelClient?.models(input.modelSelection.provider),
      ).snapshot
    },

    start(runtime, input, context, control) {
      const forcedAbort = new AbortController()
      const signal = AbortSignal.any([control.signal, forcedAbort.signal])
      let activeStream: AsyncIterator<ModelStreamEvent> | undefined
      let closeModelSession: (() => Promise<void>) | undefined
      const completion = ensureSessionHooks(
        runtime,
        input.submissionId,
        signal,
      ).then(() =>
        executeTurn({
          runtime,
          input,
          context,
          control,
          signal,
          toolRegistry,
          permissionGate,
          runtimeTiming,
          projectInstructionLoader,
          toolExecutionGate,
          options,
          setActiveStream(stream) {
            activeStream = stream
          },
          setCloseModelSession(close) {
            closeModelSession = close
          },
        }),
      )
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
          void closeModelSession?.().catch((cause) =>
            reportOperationalFailure(options.onOperationalFailure, {
              operation: "close-model-session",
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
  readonly toolExecutionGate: ToolExecutionGate
  readonly options: TurnProcessorOptions
  readonly setActiveStream: (
    stream: AsyncIterator<ModelStreamEvent> | undefined,
  ) => void
  readonly setCloseModelSession: (
    close: (() => Promise<void>) | undefined,
  ) => void
}): Promise<void> {
  const metadata = input.runtime.snapshot().metadata
  const models = input.options.modelClient?.models(
    input.context.selection.provider,
  )
  await models?.refresh()
  const requestSettings = SessionConfiguration.restore(
    input.context.configuration,
    models,
  ).resolveStep(input.context.selection, models)
  const turn = createTurnContext({
    requestSettings,
    mateId: requireValue(metadata.mateId, "Mate id"),
    mateRevisionId: requireValue(metadata.mateRevisionId, "Mate revision id"),
  })
  if (turn.requestSettings.modelInfo.usedFallbackModelMetadata) {
    input.runtime.emitWarning(
      `Model metadata for ${turn.requestSettings.target.provider}/${turn.requestSettings.target.model} was not found. Yakitori is using conservative fallback metadata, so model-specific editing capabilities are unavailable.`,
    )
  }
  const modelSession = input.options.modelClient?.startTurn(
    turn.requestSettings.target.provider,
  )
  let closePromise: Promise<void> | undefined
  const closeModelSession = () => {
    closePromise ??= Promise.resolve().then(() => modelSession?.close())
    return closePromise
  }
  input.setCloseModelSession(closeModelSession)
  const stream = modelSession?.stream ?? input.options.stream
  if (stream === undefined) {
    throw new Error("Turn has no model stream.")
  }
  try {
    const promptHook = await input.options.hookRunner?.run({
      event: HookEvent.UserPromptSubmit,
      payload: {
        session_id: metadata.id,
        turn_id: input.input.submissionId,
        prompt: input.input.content.text,
      },
      cwd: requireValue(metadata.workingDirectory, "Working directory"),
      signal: input.signal,
    })
    if (promptHook?.continue === false) {
      throw new Error(
        promptHook.reason ?? "UserPromptSubmit hook blocked the Turn.",
      )
    }
    await recordHookContext(
      input.runtime,
      input.input.submissionId,
      promptHook?.additionalContext ?? [],
    )
    await executeTurnModelLoop(
      input,
      turn,
      stream,
      modelSession?.remoteCompaction ?? false,
    )
  } catch (error) {
    if (input.signal.aborted || isAbortError(error)) {
      try {
        await input.options.hookRunner?.run({
          event: HookEvent.Interrupt,
          payload: {
            session_id: metadata.id,
            turn_id: input.input.submissionId,
            reason: error instanceof Error ? error.message : String(error),
          },
          cwd: requireValue(metadata.workingDirectory, "Working directory"),
        })
      } catch (cause) {
        reportOperationalFailure(input.options.onOperationalFailure, {
          operation: "execute-hook",
          cause,
        })
      }
    }
    throw error
  } finally {
    try {
      await closeModelSession()
    } finally {
      input.setCloseModelSession(undefined)
    }
  }
}

async function executeTurnModelLoop(
  input: Parameters<typeof executeTurn>[0],
  turn: ReturnType<typeof createTurnContext>,
  stream: StreamFn,
  remoteCompaction: boolean,
): Promise<void> {
  const metadata = input.runtime.snapshot().metadata
  const usages: ModelUsage[] = []
  let modelCalls = 0
  let compactedAtModelCall = -1
  for (;;) {
    let step: StepContext | undefined
    try {
      throwIfAborted(input.signal)
      const budget = input.options.agentControl?.rolloutBudget
      budget?.assertAvailable()
      const reminder = budget?.pendingReminder(metadata.id)
      if (reminder !== undefined) {
        await input.runtime.recordConversationItems([
          envelope(input.input.submissionId, {
            role: "developer",
            content: [
              {
                type: "text",
                text: `<rollout_budget>\nShared session budget remaining: ${reminder.remainingTokens} weighted tokens.\n</rollout_budget>`,
              },
            ],
          }),
        ])
        budget?.markDelivered(metadata.id, reminder)
      }
      await recordSteering(input.runtime, input.control.takeSteering())
      step = captureStepContext({
        registry: input.toolRegistry,
        configuration: turn.requestSettings,
      })
      const configuration = step.configuration
      const toolPlan = step.toolRouter
      const workspaceRoot = await resolveWorkspaceRoot(
        configuration.workspaceRoot,
      )
      const projectInstructions = await input.projectInstructionLoader({
        workspaceRoot,
        workingDirectory: configuration.workspaceRoot,
      })
      const skills = await loadSkillsCatalog({
        workspaceRoot,
        workingDirectory: configuration.workspaceRoot,
      })
      const environment = observeEnvironment({
        workspaceRoot,
        workingDirectory: configuration.workspaceRoot,
        ...(input.options.resolveShellName === undefined
          ? {}
          : { shell: await input.options.resolveShellName() }),
        ...(input.options.now === undefined
          ? {}
          : { now: input.options.now() }),
      })
      const beforeStep = input.runtime.snapshot()
      const currentInputIndex = beforeStep.context.history.findIndex(
        (entry) => entry.turnId === input.input.submissionId,
      )
      const compactionHistory =
        modelCalls === 0 && currentInputIndex >= 0
          ? beforeStep.context.history.slice(0, currentInputIndex)
          : beforeStep.context.history
      const admission = assessModelRequest({
        history: compactionHistory,
        activeContextTokens: beforeStep.context.activeContextTokens,
        autoCompactPrefillTokens: beforeStep.context.autoCompactPrefillTokens,
        historyAnchorItemId:
          beforeStep.context.contextTokenHistoryAnchorItemId,
        baselineProvider: beforeStep.context.contextTokenProvider,
        baselineModel: beforeStep.context.contextTokenModel,
        step,
      })
      const priorModelId = previousModelId(
        beforeStep.context.history,
        input.context,
      )
      const worldState = buildWorldStateFromSnapshot({
        configuration,
        enabledToolNames: new Set(
          toolPlan.definitions.map((definition) => definition.name),
        ),
        ...(baseModelId(input.context) === undefined
          ? {}
          : { baseModelId: baseModelId(input.context) }),
        ...(priorModelId === undefined
          ? {}
          : { previousModelId: priorModelId }),
        environment,
        ...(projectInstructions === undefined ? {} : { projectInstructions }),
        ...(skills === undefined ? {} : { skills }),
        ...(input.options.agentControl === undefined
          ? {}
          : {
              multiAgent: input.options.agentControl.runtimeContext(
                metadata.id,
              ),
            }),
      })
      const foreignCheckpoint = beforeStep.context.history
        .flatMap(({ item }) => (item.role === "assistant" ? item.content : []))
        .find(
          (block) =>
            block.type === "compaction" &&
            block.provider !== step?.target.provider,
        )
      const previousModel = beforeStep.context.previousModel
      const sourceSelection =
        foreignCheckpoint?.type === "compaction"
          ? {
              provider: foreignCheckpoint.provider,
              model: foreignCheckpoint.model,
            }
          : previousModel !== undefined &&
              (previousModel.provider === step.target.provider ||
                input.options.modelClient?.hasProvider(
                  previousModel.provider,
                )) &&
              modelCalls === 0 &&
              compactedAtModelCall !== modelCalls
            ? { provider: previousModel.provider, model: previousModel.model }
            : undefined
      if (sourceSelection !== undefined) {
        const client = input.options.modelClient
        if (client === undefined && foreignCheckpoint !== undefined) {
          throw new Error(
            "Cross-provider continuation requires the native checkpoint's provider client.",
          )
        }
        const sourceModels = client?.models(sourceSelection.provider)
        await sourceModels?.refresh()
        const {
          modelContextWindowTokens: _contextWindowOverride,
          ...sourceSnapshot
        } = input.context.configuration
        const sourceConfiguration = SessionConfiguration.restore(
          {
            ...(sourceSelection.provider === step.target.provider
              ? input.context.configuration
              : sourceSnapshot),
            defaultTarget: sourceSelection,
          },
          sourceModels,
        ).resolveStep(sourceSelection, sourceModels)
        const oldWindow =
          sourceConfiguration.modelCapacity?.effectiveContextWindowTokens
        const newWindow =
          configuration.modelCapacity?.effectiveContextWindowTokens
        const activeTokens = admission.activeTokens
        const hashChanged =
          previousModel?.provider === step.target.provider &&
          previousModel.compactionHash !== undefined &&
          step.modelInfo.compactionHash !== undefined &&
          previousModel.compactionHash !== step.modelInfo.compactionHash
        const downshift =
          (sourceSelection.model !== step.target.model ||
            sourceSelection.provider !== step.target.provider) &&
          oldWindow !== undefined &&
          newWindow !== undefined &&
          oldWindow > newWindow &&
          (activeTokens >= newWindow ||
            (configuration.autoCompact.scope === "total" &&
              configuration.autoCompact.limitTokens !== undefined &&
              activeTokens > configuration.autoCompact.limitTokens))
        if (foreignCheckpoint !== undefined || hashChanged || downshift) {
          const sourceSession = client?.startTurn(sourceSelection.provider)
          try {
            const sourceStep = captureStepContext({
              registry: input.toolRegistry,
              configuration: sourceConfiguration,
            })
            try {
              await compactLiveHistory({
                runtime: input.runtime,
                turnId: input.input.submissionId,
                step: sourceStep,
                worldState,
                history: compactionHistory,
                injectWorldState: modelCalls !== 0,
                stream: sourceSession?.stream ?? stream,
                remoteCompaction:
                  sourceSelection.provider === step.target.provider &&
                  (sourceSession?.remoteCompaction ?? false),
                ...(sourceSelection.provider === step.target.provider &&
                step.target.provider === "codex" &&
                sourceSelection.model !== step.target.model &&
                remoteCompaction
                  ? { fallback: { step, stream } }
                  : {}),
                signal: input.signal,
                rolloutAssets: input.options.rolloutAssets,
                usages,
                rolloutBudget: budget,
                onOperationalFailure: input.options.onOperationalFailure,
                ...(input.options.hookRunner === undefined
                  ? {}
                  : { hookRunner: input.options.hookRunner }),
                setActiveStream: input.setActiveStream,
              })
            } finally {
              await sourceStep.toolRouter.release()
            }
          } finally {
            await sourceSession?.close()
          }
          compactedAtModelCall = modelCalls
          continue
        }
      }
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

      const durableMessages = completeToolCallHistory(
        input.runtime.snapshot().context.history.map(({ item }) => item),
      )
      const messages = limitToolResults(
        durableMessages,
        step.executionPolicy.modelVisibleToolResultBytes,
        step.executionPolicy.modelVisibleToolResultLines,
      )
      const visibleFileObservations =
        createVisibleFileObservationsFromMessages(messages)
      const adapted = adaptImagesForModel(messages, step.target, step.modelInfo)
      const request: ModelRequest = {
        target: step.target,
        cacheKey: configuration.promptCacheKey,
        system: [configuration.baseInstructions],
        messages: await resolveRolloutAssetImages(
          adapted.messages,
          input.options.rolloutAssets,
        ),
        tools: toolPlan.modelDefinitions,
        toolWireProtocol: step.toolWireProtocol,
        signal: input.signal,
      }
      if (admission.shouldCompact && compactedAtModelCall !== modelCalls) {
        const compacted = await compactLiveHistory({
          runtime: input.runtime,
          turnId: input.input.submissionId,
          step,
          worldState,
          history: compactionHistory,
          injectWorldState: modelCalls !== 0,
          stream,
          remoteCompaction,
          signal: input.signal,
          rolloutAssets: input.options.rolloutAssets,
          usages,
          rolloutBudget: budget,
          onOperationalFailure: input.options.onOperationalFailure,
          ...(input.options.hookRunner === undefined
            ? {}
            : { hookRunner: input.options.hookRunner }),
          setActiveStream: input.setActiveStream,
        })
        if (compacted) {
          compactedAtModelCall = modelCalls
          continue
        }
        throw new Error(
          "Context limit reached with no history available to compact.",
        )
      }
      if (modelCalls === 0) {
        await input.runtime.recordModelContext({
          provider: step.target.provider,
          model: step.target.model,
          ...(step.modelInfo.compactionHash === undefined
            ? {}
            : { compactionHash: step.modelInfo.compactionHash }),
        })
      }
      const responseItemId = `message_${globalThis.crypto.randomUUID()}`
      const estimatedInputTokens = estimateModelRequestBudget(
        request,
      ).estimatedInputTokens
      let sampledContext:
        | Readonly<{
            activeContextTokens: number
            inputTokens: number
            estimatedPrefill: boolean
          }>
        | undefined
      const response = await consumeModelStream({
        request,
        stream,
        threadId: metadata.id,
        turnId: input.input.submissionId,
        itemId: responseItemId,
        emitModelStream: (event) => input.runtime.emitModelStream(event),
        assistantResponseBytes: step.executionPolicy.assistantResponseBytes,
        onOperationalFailure: input.options.onOperationalFailure,
        async onUsage(usage) {
          usages.push(usage)
          const aggregate = aggregateTokenUsage(usages)
          if (aggregate !== undefined) input.runtime.recordUsage(aggregate)
          const contextTokens =
            usage.activeContextTokens ??
            (usage.inputTokens === undefined
              ? undefined
              : usage.inputTokens + (usage.outputTokens ?? 0))
          if (contextTokens !== undefined) {
            sampledContext = {
              activeContextTokens: contextTokens,
              inputTokens: usage.inputTokens ?? estimatedInputTokens,
              estimatedPrefill: usage.inputTokens === undefined,
            }
          }
          budget?.recordUsage(usage)
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
        throw new ModelResponseError(response.error)
      }
      if (response.stopReason === ModelStopReason.Aborted) {
        throw abortError()
      }

      const calls = response.content.filter(
        (block): block is ModelToolCallBlock => block.type === "tool_call",
      )
      if (
        response.stopReason === ModelStopReason.ToolUse &&
        calls.length === 0
      ) {
        throw new Error(
          "tool_use stop reason requires at least one complete tool call.",
        )
      }
      if (response.stopReason !== ModelStopReason.ToolUse && calls.length > 0) {
        throw new Error("Non-tool_use responses must not include tool calls.")
      }
      if (
        utf8Bytes(JSON.stringify(response.content)) >
        step.executionPolicy.assistantResponseBytes
      ) {
        throw new Error(
          "Assistant response exceeded the configured byte limit.",
        )
      }
      if (response.content.length > 0) {
        const responseItem = envelope(
          input.input.submissionId,
          { role: "assistant", content: response.content },
          {
            provider: step.target.provider,
            model: step.target.model,
            callIndex: modelCalls,
            ...(response.providerRequestId === undefined
              ? {}
              : { requestId: response.providerRequestId }),
          },
          responseItemId,
        )
        await input.runtime.recordConversationItems([responseItem])
        await input.runtime.recordItemCompletions(
          completedResponseItems(responseItem),
        )
      }
      if (sampledContext !== undefined) {
        const historyAnchorItemId = input.runtime
          .snapshot()
          .context.history.at(-1)?.id
        if (historyAnchorItemId !== undefined) {
          await input.runtime.recordContextTokens({
            ...sampledContext,
            historyAnchorItemId,
            provider: step.target.provider,
            model: step.target.model,
          })
        }
      }

      if (response.stopReason === ModelStopReason.ToolUse) {
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
          approvalPolicy: configuration.approvalPolicy,
          rolloutAssets: input.options.rolloutAssets,
          visibleFileObservations,
          toolExecutionGate: input.toolExecutionGate,
          onOperationalFailure: input.options.onOperationalFailure,
          ...(input.options.hookRunner === undefined
            ? {}
            : { hookRunner: input.options.hookRunner }),
          ...(input.options.agentControl === undefined
            ? {}
            : {
                agentControl: input.options.agentControl.bind(
                  metadata.id,
                  step.target,
                ),
              }),
        })
        for (const { call, item, result } of results) {
          const fileObservations = toolFileObservations(item.name, result)
          const resultItem = envelope(input.input.submissionId, {
            role: "tool",
            toolCallId: call.id,
            content: result.content,
            ...(!result.ok ? { isError: true } : {}),
            ...(call.toolKind === "tool_search"
              ? {
                  toolSearch: {
                    tools: result.ok
                      ? discoveredTools(toolPlan, call.input)
                      : [],
                  },
                }
              : {}),
            ...(fileObservations.length === 0 ? {} : { fileObservations }),
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
      const stopHook = await input.options.hookRunner?.run({
        event:
          input.options.sessionHookContext?.isSubagent === true
            ? HookEvent.SubagentStop
            : HookEvent.Stop,
        payload: {
          session_id: metadata.id,
          turn_id: input.input.submissionId,
        },
        cwd: workspaceRoot,
        signal: input.signal,
      })
      if (stopHook?.continue === false) {
        await recordHookContext(input.runtime, input.input.submissionId, [
          ...(stopHook.additionalContext ?? []),
          stopHook.reason ?? "Stop hook requested another model step.",
        ])
        continue
      }
      await recordHookContext(
        input.runtime,
        input.input.submissionId,
        stopHook?.additionalContext ?? [],
      )
      return
    } catch (error) {
      if (!input.signal.aborted && isContextOverflowError(error)) {
        const capacity =
          step?.configuration.modelCapacity?.effectiveContextWindowTokens
        if (capacity !== undefined && step !== undefined)
          await input.runtime.recordContextTokens({
            activeContextTokens: capacity,
            historyAnchorItemId:
              input.runtime.snapshot().context.history.at(-1)?.id ??
              input.input.submissionId,
            provider: step.target.provider,
            model: step.target.model,
          })
      }
      throw error
    } finally {
      await step?.toolRouter.release()
    }
  }
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
  readonly onUsage: (usage: ModelUsage) => void | Promise<void>
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
        if (input.request.compaction === "remote_v2") continue
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
        await input.onUsage(event.response.usage)
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
  readonly history: readonly ResponseItemEnvelope[]
  readonly activeContextTokens: number | undefined
  readonly autoCompactPrefillTokens: number | undefined
  readonly historyAnchorItemId: string | undefined
  readonly baselineProvider: string | undefined
  readonly baselineModel: string | undefined
  readonly step: StepContext
}): Readonly<{ shouldCompact: boolean; activeTokens: number }> {
  const anchorIndex =
    input.historyAnchorItemId === undefined
      ? -1
      : input.history.findIndex(
          (item) => item.id === input.historyAnchorItemId,
        )
  const hasAnchoredMeasurement =
    input.activeContextTokens !== undefined &&
    anchorIndex >= 0
  const baselineMatches =
    hasAnchoredMeasurement &&
    input.baselineProvider === input.step.target.provider &&
    input.baselineModel === input.step.target.model
  const estimatedHistoryTokens = estimateHistoryTokens(
    input.history.map(({ item }) => item),
  )
  const anchoredTokens = hasAnchoredMeasurement
    ? input.activeContextTokens +
      estimateHistoryTokens(
        input.history.slice(anchorIndex + 1).map(({ item }) => item),
      )
    : undefined
  // A foreign model's measurement is not a calibrated prefix for the target
  // tokenizer, but it remains a conservative high-water mark for downshifts.
  const requestTokens = baselineMatches
    ? (anchoredTokens ?? estimatedHistoryTokens)
    : Math.max(estimatedHistoryTokens, anchoredTokens ?? 0)
  const fullContextLimit =
    input.step.configuration.modelCapacity?.effectiveContextWindowTokens
  const scopeTokens =
    input.step.configuration.autoCompact.scope === "body_after_prefix"
      ? baselineMatches && input.autoCompactPrefillTokens !== undefined
        ? Math.max(0, requestTokens - input.autoCompactPrefillTokens)
        : 0
      : requestTokens
  const autoCompactLimit = input.step.configuration.autoCompact.limitTokens
  return {
    activeTokens: requestTokens,
    shouldCompact:
      (autoCompactLimit !== undefined && scopeTokens >= autoCompactLimit) ||
      (fullContextLimit !== undefined && requestTokens >= fullContextLimit),
  }
}

async function compactLiveHistory(input: {
  readonly remoteCompaction?: boolean
  readonly fallback?: Readonly<{ step: StepContext; stream: StreamFn }>
  readonly injectWorldState?: boolean
  readonly runtime: TurnRuntime
  readonly turnId: string
  readonly step: StepContext
  readonly worldState: WorldState
  readonly history: readonly ResponseItemEnvelope[]
  readonly stream: StreamFn
  readonly signal: AbortSignal
  readonly rolloutAssets: RolloutAssets | undefined
  readonly usages: ModelUsage[]
  readonly rolloutBudget: RolloutBudget | undefined
  readonly hookRunner?: HookRunner
  readonly onOperationalFailure:
    | TurnProcessorOperationalFailureReporter
    | undefined
  readonly setActiveStream: (
    stream: AsyncIterator<ModelStreamEvent> | undefined,
  ) => void
}): Promise<boolean> {
  let compactionStep = input.step
  let compactionStream = input.stream
  let usedFallback = false
  let fallbackSourceError: unknown
  let source = input.history.map((item) => item.item)
  if (source.length === 0) return false
  if (input.remoteCompaction) {
    source = trimRemoteCompactionToolTail(
      source,
      compactionStep.configuration.baseInstructions.text,
      compactionStep.configuration.modelCapacity?.effectiveContextWindowTokens,
    )
  }

  const preHook = await input.hookRunner?.run({
    event: HookEvent.PreCompact,
    matcher: input.remoteCompaction ? "remote" : "local",
    payload: {
      session_id: input.runtime.snapshot().metadata.id,
      turn_id: input.turnId,
      trigger: "auto",
      custom_instructions: null,
    },
    cwd: input.step.configuration.workspaceRoot,
    signal: input.signal,
  })
  if (preHook?.continue === false) {
    throw new Error(preHook.reason ?? "PreCompact hook blocked compaction.")
  }
  await recordHookContext(
    input.runtime,
    input.turnId,
    preHook?.additionalContext ?? [],
  )

  const compactionItem: StartedExecutionItem = {
    type: "context_compaction",
    itemId: `compaction_${globalThis.crypto.randomUUID()}`,
  }
  input.runtime.emitItemStarted(compactionItem)
  let completed = false

  try {
    const compact = async (request: ModelRequest) => {
      const response = await consumeModelStream({
        request,
        stream: compactionStream,
        threadId: input.runtime.snapshot().metadata.id,
        turnId: input.turnId,
        assistantResponseBytes:
          compactionStep.executionPolicy.assistantResponseBytes,
        onOperationalFailure: input.onOperationalFailure,
        onUsage(usage) {
          input.usages.push(usage)
          const aggregate = aggregateTokenUsage(input.usages)
          if (aggregate !== undefined) input.runtime.recordUsage(aggregate)
          input.rolloutBudget?.recordUsage(usage)
        },
        setActiveStream: input.setActiveStream,
      })
      if (response.stopReason === ModelStopReason.Error) {
        throw new ModelResponseError(response.error)
      }
      if (response.stopReason === ModelStopReason.Length) {
        throw new Error("Compaction was truncated by the model output limit.")
      }
      if (response.stopReason === ModelStopReason.Aborted) throw abortError()
      const nativeItems = response.content.filter(
        (block) => block.type === "compaction",
      )
      if (
        input.remoteCompaction &&
        (nativeItems.length !== 1 || response.providerRequestId === undefined)
      ) {
        throw new Error(
          "Remote compaction requires exactly one native compaction item and a completed response id.",
        )
      }
      const summary = input.remoteCompaction
        ? ""
        : response.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("")
            .trim()
      if (!input.remoteCompaction && summary.length === 0) {
        throw new Error("Compaction produced an empty checkpoint.")
      }
      const usage =
        response.usage === undefined
          ? undefined
          : aggregateTokenUsage([response.usage])
      return {
        summary,
        native: input.remoteCompaction ? nativeItems[0] : undefined,
        ...(usage === undefined ? {} : { usage }),
      }
    }
    let result: Awaited<ReturnType<typeof compact>> | undefined
    while (result === undefined) {
      const messages = await resolveRolloutAssetImages(
        adaptImagesForModel(
          limitToolResults(
            completeToolCallHistory(source),
            compactionStep.executionPolicy.modelVisibleToolResultBytes,
            compactionStep.executionPolicy.modelVisibleToolResultLines,
          ),
          compactionStep.target,
          compactionStep.modelInfo,
        ).messages,
        input.rolloutAssets,
      )
      try {
        result = await compact(
          input.remoteCompaction
            ? {
                compaction: "remote_v2",
                target: compactionStep.target,
                cacheKey: compactionStep.configuration.promptCacheKey,
                system: [compactionStep.configuration.baseInstructions],
                messages,
                tools: compactionStep.toolRouter.modelDefinitions,
                toolWireProtocol: compactionStep.toolWireProtocol,
                signal: input.signal,
              }
            : buildCompactionRequest({
                source: [{ messages }],
                target: compactionStep.target,
                baseInstructions: compactionStep.configuration.baseInstructions,
                cacheKey: compactionStep.configuration.promptCacheKey,
                signal: input.signal,
              }),
        )
      } catch (error) {
        if (input.signal.aborted || isAbortError(error)) throw error
        if (
          input.remoteCompaction &&
          !usedFallback &&
          input.fallback !== undefined &&
          canRetryCompactionWithCurrentModel(error)
        ) {
          usedFallback = true
          fallbackSourceError = error
          compactionStep = input.fallback.step
          compactionStream = input.fallback.stream
          source = trimRemoteCompactionToolTail(
            input.history.map(({ item }) => item),
            compactionStep.configuration.baseInstructions.text,
            compactionStep.configuration.modelCapacity
              ?.effectiveContextWindowTokens,
          )
          continue
        }
        if (usedFallback && fallbackSourceError !== undefined) {
          throw fallbackSourceError
        }
        if (
          input.remoteCompaction ||
          !isContextOverflowError(error) ||
          source.length <= 1
        )
          throw error
        // Codex retries local compaction by dropping the oldest input item.
        // The live history stays intact until a complete checkpoint is ready.
        source = source.slice(1)
      }
    }
    if (
      utf8Bytes(result.summary) >
      compactionStep.executionPolicy.assistantResponseBytes
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
      ...(input.injectWorldState === false
        ? {}
        : { worldStateFragments: fullWorldState.fragments }),
    }).map((message) => envelope(input.turnId, message))
    const retained = input.remoteCompaction
      ? retainRemoteCompactionMessages(input.history)
      : retainCompactionUserMessages(input.history)
    // Keep the checkpoint last and inject current context before the last
    // real user message, matching Codex's inline compaction placement.
    const summaryItem =
      result.native === undefined
        ? generated.at(-1)
        : envelope(input.turnId, {
            role: "assistant",
            content: [result.native],
          })
    if (summaryItem === undefined)
      throw new Error("Missing compaction checkpoint.")
    const replacement = [
      ...retained.slice(0, -1),
      ...generated.slice(0, -1),
      ...retained.slice(-1),
      summaryItem,
    ]
    await input.runtime.replaceConversationHistory({
      replacement,
      summary: result.summary,
      baseHistoryLength: input.history.length,
      ...(input.injectWorldState === false
        ? {}
        : {
            worldState: {
              state: fullWorldState.state,
              snapshot: fullWorldState.snapshot,
            },
          }),
    })
    const estimatedContextTokens = estimateModelRequestBudget({
      target: compactionStep.target,
      system: [compactionStep.configuration.baseInstructions],
      messages: input.runtime
        .snapshot()
        .context.history.map((item) => item.item),
      tools: [],
      toolWireProtocol: "eager",
    }).estimatedInputTokens
    await input.runtime.recordContextTokens({
      activeContextTokens: estimatedContextTokens,
      inputTokens: estimatedContextTokens,
      estimatedPrefill: true,
      historyAnchorItemId:
        input.runtime.snapshot().context.history.at(-1)?.id ?? input.turnId,
      provider: compactionStep.target.provider,
      model: compactionStep.target.model,
    })
    await input.runtime.recordItemCompletions([
      completeCompactionItem(compactionItem, "completed"),
    ])
    completed = true
    const postHook = await input.hookRunner?.run({
      event: HookEvent.PostCompact,
      matcher: input.remoteCompaction ? "remote" : "local",
      payload: {
        session_id: input.runtime.snapshot().metadata.id,
        turn_id: input.turnId,
        trigger: "auto",
      },
      cwd: input.step.configuration.workspaceRoot,
      signal: input.signal,
    })
    if (postHook?.continue === false) {
      throw new Error(postHook.reason ?? "PostCompact hook blocked the Turn.")
    }
    await recordHookContext(
      input.runtime,
      input.turnId,
      postHook?.additionalContext ?? [],
    )
    input.rolloutBudget?.rearm(input.runtime.snapshot().metadata.id)
    return true
  } catch (error) {
    if (input.signal.aborted || isAbortError(error)) throw abortError()
    if (!completed) {
      await input.runtime.recordItemCompletions([
        completeCompactionItem(compactionItem, "failed", error),
      ])
    }
    throw error
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
  readonly toolExecutionGate: ToolExecutionGate
  readonly onOperationalFailure:
    | TurnProcessorOperationalFailureReporter
    | undefined
  readonly agentControl?: BoundAgentControl
  readonly hookRunner?: HookRunner
}

type PreparedToolCall = {
  readonly call: ModelToolCallBlock
  readonly invocation: Readonly<{
    name: string
    input: import("../kernel/index.ts").JsonValue
  }>
  readonly item: ToolExecutionItem
  readonly permission?: ToolPermissionRequest
  readonly preparationError?: unknown
  readonly hookBlockedReason?: string
  readonly hookContext?: readonly string[]
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
      let invocation = input.toolPlan.resolveInvocation(call.name, call.input)
      let descriptor = input.toolPlan.describeExecution(
        invocation.name,
        invocation.input,
      )
      try {
        const hookOutcome = await input.hookRunner?.run({
          event: HookEvent.PreToolUse,
          matcher: invocation.name,
          payload: {
            session_id: input.threadId,
            turn_id: input.turnId,
            tool_name: invocation.name,
            tool_use_id: call.id,
            tool_input: invocation.input,
          },
          cwd: input.workspaceRoot,
          signal: input.signal,
        })
        if (hookOutcome?.updatedInput !== undefined) {
          invocation = input.toolPlan.resolveInvocation(
            call.name,
            hookOutcome.updatedInput,
          )
          descriptor = input.toolPlan.describeExecution(
            invocation.name,
            invocation.input,
          )
        }
        const requirement = await input.toolPlan.approvalRequirement(
          invocation.name,
          invocation.input,
          { workspaceRoot: input.workspaceRoot },
        )
        const permission = resolveToolPermissionRequest(
          requirement,
          input.approvalPolicy,
        )
        return {
          call,
          invocation,
          item: {
            itemId: `tool_${globalThis.crypto.randomUUID()}`,
            toolCallId: call.id,
            name: invocation.name,
            input: invocation.input,
            requiresPermission: permission !== undefined,
            ...descriptor,
          },
          ...(permission === undefined ? {} : { permission }),
          ...(hookOutcome?.continue === false
            ? {
                hookBlockedReason:
                  hookOutcome.reason ??
                  "PreToolUse hook blocked the tool call.",
              }
            : {}),
          ...(hookOutcome === undefined ||
          hookOutcome.additionalContext.length === 0
            ? {}
            : { hookContext: hookOutcome.additionalContext }),
        }
      } catch (error) {
        return {
          call,
          invocation,
          item: {
            itemId: `tool_${globalThis.crypto.randomUUID()}`,
            toolCallId: call.id,
            name: invocation.name,
            input: invocation.input,
            requiresPermission: false,
            ...descriptor,
          },
          preparationError: error,
        }
      }
    }),
  )
  for (const item of prepared) input.emitItemStarted(item.item)
  const scheduled = prepared.map((item) => ({
    item,
    reservation: input.toolExecutionGate.reserve(
      input.toolPlan.supportsParallelToolCalls(item.invocation.name),
      input.signal,
    ),
  }))
  const results: Array<{
    readonly call: ModelToolCallBlock
    readonly item: ToolExecutionItem
    readonly result: ToolExecutionResult
  }> = []

  const settled = await Promise.allSettled(
    scheduled.map(async ({ item, reservation }) => ({
      call: item.call,
      item: item.item,
      result: await executePreparedTool(input, item, reservation),
    })),
  )
  let firstError: unknown
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") results.push(outcome.value)
    else if (firstError === undefined) firstError = outcome.reason
  }
  if (firstError !== undefined) throw firstError
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
  reservation: ToolExecutionReservation,
): Promise<ToolExecutionResult> {
  try {
    const hookContext = [...(prepared.hookContext ?? [])]
    if (prepared.preparationError !== undefined) {
      throw prepared.preparationError
    }
    if (prepared.hookBlockedReason !== undefined) {
      reservation.cancel()
      return {
        ok: false,
        code: "hook_blocked",
        message: prepared.hookBlockedReason,
        content: `hook_blocked: ${prepared.hookBlockedReason}`,
      }
    }
    if (prepared.permission !== undefined) {
      const permissionHook = await input.hookRunner?.run({
        event: HookEvent.PermissionRequest,
        matcher: prepared.invocation.name,
        payload: {
          session_id: input.threadId,
          turn_id: input.turnId,
          tool_name: prepared.invocation.name,
          tool_use_id: prepared.call.id,
          tool_input: prepared.invocation.input,
          permission_mode: input.approvalPolicy,
        },
        cwd: input.workspaceRoot,
        signal: input.signal,
      })
      hookContext.push(...(permissionHook?.additionalContext ?? []))
      if (permissionHook?.continue === false) {
        reservation.cancel()
        const message =
          permissionHook.reason ?? "PermissionRequest hook denied the tool."
        return {
          ok: false,
          code: "permission_denied",
          message,
          content: message,
        }
      }
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
        reservation.cancel()
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
    await waitForToolReadiness(
      input.toolPlan.waitUntilReady(prepared.invocation.name, {
        workspaceRoot: input.workspaceRoot,
        signal: input.signal,
      }),
      input.signal,
    )
    return await reservation.run(async () => {
      const result = await input.toolPlan.execute(
        prepared.invocation.name,
        prepared.invocation.input,
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
      const postHook = await input.hookRunner?.run({
        event: HookEvent.PostToolUse,
        matcher: prepared.invocation.name,
        payload: {
          session_id: input.threadId,
          turn_id: input.turnId,
          tool_name: prepared.invocation.name,
          tool_use_id: prepared.call.id,
          tool_input: prepared.invocation.input,
          tool_response: result.output ?? result.content,
        },
        cwd: input.workspaceRoot,
        signal: input.signal,
      })
      if (postHook?.continue === false) {
        const reason =
          postHook.reason ?? "PostToolUse hook rejected the tool result."
        return {
          ok: false,
          code: "hook_blocked",
          message: reason,
          content: `hook_blocked: ${reason}`,
          ...(result.output === undefined ? {} : { output: result.output }),
        }
      }
      if (input.toolPlan.get(prepared.invocation.name)?.effect !== "observe") {
        const observations = toolFileObservations(
          prepared.invocation.name,
          result,
        )
        for (const observation of observations) {
          input.visibleFileObservations.apply(observation)
        }
      }
      hookContext.push(...(postHook?.additionalContext ?? []))
      return hookContext.length === 0
        ? result
        : {
            ...result,
            content: `${result.content}\n\n<hook_context>\n${hookContext.join("\n\n")}\n</hook_context>`,
          }
    })
  } catch (error) {
    reservation.cancel()
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

async function waitForToolReadiness(
  readiness: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw abortError()
  let rejectAborted: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = () => reject(abortError())
  })
  const onAbort = () => rejectAborted?.()
  signal.addEventListener("abort", onAbort, { once: true })
  if (signal.aborted) onAbort()
  try {
    await Promise.race([readiness, aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

function toolFileObservations(name: string, result: ToolExecutionResult) {
  return result.output === undefined
    ? []
    : grantsFromToolOutput(name, result.output)
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
    return { ...message, content }
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

async function recordHookContext(
  runtime: TurnRuntime,
  turnId: string,
  context: readonly string[],
): Promise<void> {
  const content = context.filter((entry) => entry.trim() !== "")
  if (content.length === 0) return
  await runtime.recordConversationItems([
    envelope(turnId, {
      role: "developer",
      content: [
        {
          type: "text",
          text: `<hook_context>\n${content.join("\n\n")}\n</hook_context>`,
        },
      ],
    }),
  ])
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
      ...(usage.activeContextTokens === undefined
        ? total.activeContextTokens === undefined
          ? {}
          : { activeContextTokens: total.activeContextTokens }
        : { activeContextTokens: usage.activeContextTokens }),
    }),
    { inputTokens: 0, outputTokens: 0 },
  )
}

function completeToolCallHistory(
  messages: readonly ModelMessage[],
): readonly ModelMessage[] {
  const completed: ModelMessage[] = []
  let pending: Array<
    Readonly<{ id: string; toolKind: ModelToolCallBlock["toolKind"] }>
  > = []
  const flushMissing = () => {
    completed.push(
      ...pending.map(({ id: toolCallId, toolKind }) => ({
        role: "tool" as const,
        toolCallId,
        content: MISSING_TOOL_RESULT_TEXT,
        isError: true,
        ...(toolKind === "tool_search" ? { toolSearch: { tools: [] } } : {}),
      })),
    )
    pending = []
  }
  for (const message of messages) {
    if (
      message.role === "tool" &&
      pending.some(({ id }) => id === message.toolCallId)
    ) {
      completed.push(message)
      pending = pending.filter(({ id }) => id !== message.toolCallId)
      continue
    }
    if (message.role === "tool") continue
    if (pending.length > 0) flushMissing()
    completed.push(message)
    if (message.role === "assistant") {
      pending = message.content.flatMap((block) =>
        block.type === "tool_call"
          ? [{ id: block.id, toolKind: block.toolKind }]
          : [],
      )
    }
  }
  if (pending.length > 0) flushMissing()
  return completed
}

function discoveredTools(
  toolPlan: ReturnType<ToolRegistry["finalize"]>,
  input: import("../kernel/index.ts").JsonValue,
): readonly import("./model.ts").ModelToolDefinition[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return []
  }
  const query = Reflect.get(input, "query")
  const limit = Reflect.get(input, "limit")
  if (typeof query !== "string") return []
  return toolPlan.search(query, typeof limit === "number" ? limit : undefined)
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
