import type { ResponseItemEnvelope, TurnContextItem } from "../core/rollout.ts"
import type {
  TurnCompletion,
  TurnControl,
  TurnProcessor,
  TurnRuntime,
} from "../core/session.ts"
import type { TurnInput } from "../core/session-io.ts"
import {
  type CompletedExecutionItem,
  type ContextCompactionCompletedItem,
  createCompactionId,
  type JsonObject,
  type KernelError,
  MISSING_TOOL_RESULT_TEXT,
  type ModelMessage,
  type ModelSelection,
  type ModelTransportPolicy,
  type RolloutAssets,
  type SessionConfigurationSnapshot,
  type StartedExecutionItem,
  type TokenUsage,
  type TurnLatency,
  type ToolExecutionItem,
} from "../kernel/index.ts"
import type { AgentControl, BoundAgentControl } from "./agent-control.ts"
import {
  buildCompactionRequest,
  canRetryCompactionWithCurrentModel,
  isContextOverflowError,
  trimRemoteCompactionToolTail,
} from "./compaction.ts"
import {
  canCompactPrefix,
  createBackgroundCompaction,
  type BackgroundCompaction,
} from "./background-compaction.ts"
import { ModelNotConfiguredError } from "./configured-models-manager.ts"
import { observeEnvironment } from "./environment-context.ts"
import { isAbortError, ModelFailureError } from "./errors.ts"
import { HookEvent, type HookRunner } from "./hooks.ts"
import { formatInputContext } from "./input-context.ts"
import type { InstructionDiagnostic } from "./instruction-files.ts"
import {
  createRunnerTimingPolicy,
  createSessionExecutionPolicy,
  type RunnerTimingPolicy,
  type SessionExecutionPolicy,
} from "./limits.ts"
import {
  type ModelContentBlock,
  type ModelRequest,
  type ModelResponse,
  ModelStopReason,
  type ModelStreamEvent,
  type ModelToolCallBlock,
  type ModelUsage,
  type StreamFn,
} from "./model.ts"
import {
  createCompactionReplacementHistory,
  retainCompactionUserMessages,
  retainRemoteCompactionMessages,
} from "./model-context.ts"
import { adaptImagesForModel } from "./model-images.ts"
import type { ModelClient, ModelClientSession } from "./model-provider.ts"
import {
  estimateHistoryTokens,
  estimateModelRequestBudget,
} from "./model-request-budget.ts"
import { createPermissionGate, type PermissionGate } from "./permission-gate.ts"
import { prepareModelImage } from "./prepare-model-image.ts"
import {
  createProjectInstructionsLoader,
  type loadProjectInstructions,
} from "./project-instructions.ts"
import type { RolloutBudget } from "./rollout-budget.ts"
import {
  type ApprovalPolicy,
  createTurnContext,
  resolveModelRequestPolicy,
  type ResolvedStepConfiguration,
  SessionConfiguration,
} from "./session-configuration.ts"
import {
  createSkillsLoader,
  loadExplicitSkillInstructions,
  renderSkillsCatalog,
  type SkillConfiguration,
} from "./skills.ts"
import {
  createToolExecutionGate,
  type ToolExecutionGate,
  type ToolExecutionReservation,
} from "./tool-execution-gate.ts"
import { resolveToolPermissionRequest } from "./tool-permissions.ts"
import { resolveWorkspaceRoot } from "./tools/path-policy.ts"
import { createToolRegistry, type ToolRegistry } from "./tools/registry.ts"
import { finalizeToolOutput } from "./tools/result-output.ts"
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

// Follow grok-build's bounded Length salvage, enabled by default in Yakitori.
// Ordinary ToolUse loops remain unbounded. Unlike grok's adapters, Yakitori
// retains Length alongside complete calls across providers, so its tool streak
// guard also covers paths grok normalizes to ToolUse. Stop before another sample
// can stream more tool effects. These are recovery safety bounds, not quotas.
const MAX_LENGTH_CONTINUATIONS = 2
const MAX_LENGTH_TOOL_STREAK = 5
const LENGTH_CONTINUE_REMINDER =
  "Your previous answer was cut off by a generation limit. Continue exactly where it stopped, without repeating it. If a newer user message follows this reminder, answer that message instead."

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
  // Host-scoped constraints are reattached after compaction and never inherited
  // from another Session's conversation history.
  readonly additionalInstructions?: import("./model.ts").ModelSystemSection
  readonly modelContextWindowTokens?: number
  readonly modelAutoCompactTokenLimit?: number
  readonly modelAutoCompactTokenLimitScope?: import("../kernel/index.ts").AutoCompactTokenLimitScope
  readonly loadModelTransport?: () => Promise<ModelTransportPolicy | undefined>
  readonly loadSessionGoal?: () => Promise<
    | Readonly<{
        objective: string
        status?:
          | "active"
          | "paused"
          | "blocked"
          | "usage_limited"
          | "budget_limited"
          | "complete"
      }>
    | undefined
  >
  readonly loadProjectInstructions?: typeof loadProjectInstructions
  readonly prepareStepExtensions?: (signal: AbortSignal) => Promise<
    Readonly<{
      skills?: SkillConfiguration
      skillMcpServers?: readonly import("./skills.ts").SkillMcpServer[]
      projectRootMarkers?: readonly string[]
      projectInstructionFilenames?: readonly string[]
    }>
  >
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
    | "load-instructions"
    | "model-request"
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
  const skillsLoader = createSkillsLoader()
  const toolExecutionGate = createToolExecutionGate()
  let sessionHooksStarted = false
  let startHooksPromise: Promise<void> | undefined

  const ensureSessionHooks = (
    runtime: TurnRuntime,
    turnId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    if (
      options.hookRunner === undefined ||
      options.sessionHookContext === undefined
    ) {
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
          throw new Error(
            outcome.reason ?? `${event} hook blocked the Session.`,
          )
        }
        await recordHookContext(
          runtime,
          turnId,
          outcome?.additionalContext ?? [],
        )
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
      const errors = [...lifecycleResults, ...resourceResults].flatMap(
        (result) => (result.status === "rejected" ? [result.reason] : []),
      )
      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to dispose Turn processor.")
      }
    },
    async prepare(snapshot, input) {
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
      const modelTransport =
        options.loadModelTransport === undefined
          ? snapshot.configuration?.modelTransport
          : await options.loadModelTransport()
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
                ...(modelTransport === undefined ? {} : { modelTransport }),
              },
              models,
            )
          : SessionConfiguration.restore(
              replaceModelTransport(
                snapshot.configuration,
                selection,
                modelTransport,
              ),
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
          skillsLoader,
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

function replaceModelTransport(
  snapshot: SessionConfigurationSnapshot,
  selection: ModelSelection,
  modelTransport: ModelTransportPolicy | undefined,
): SessionConfigurationSnapshot {
  const { modelTransport: _previous, ...rest } = snapshot
  return {
    ...rest,
    defaultTarget: selection,
    ...(modelTransport === undefined ? {} : { modelTransport }),
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
  readonly skillsLoader: ReturnType<typeof createSkillsLoader>
  readonly projectInstructionLoader: typeof loadProjectInstructions
  readonly toolExecutionGate: ToolExecutionGate
  readonly options: TurnProcessorOptions
  readonly setActiveStream: (
    stream: AsyncIterator<ModelStreamEvent> | undefined,
  ) => void
  readonly setCloseModelSession: (
    close: (() => Promise<void>) | undefined,
  ) => void
}): Promise<TurnCompletion | undefined> {
  const processorStartedAt = Date.now()
  let admittedAt: number | undefined
  const metadata = input.runtime.snapshot().metadata
  const modelSession = input.options.modelClient?.startTurn(
    input.context.selection.provider,
    resolveModelRequestPolicy(
      input.context.configuration.modelTransport,
      input.context.selection.provider,
    ),
  )
  let closePromise: Promise<void> | undefined
  const closeModelSession = () => {
    closePromise ??= Promise.resolve().then(() => modelSession?.close())
    return closePromise
  }
  input.setCloseModelSession(closeModelSession)
  try {
    const models = modelSession?.models
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
        `Model metadata for ${turn.requestSettings.target.provider}/${turn.requestSettings.target.model} was not found. Yakitori is using generic model settings${turn.requestSettings.modelInfo.fileEditingToolType === "none" ? "; file editing tools are unavailable" : " and coding tools"}.`,
      )
    }
    const stream = modelSession?.stream ?? input.options.stream
    if (stream === undefined) {
      throw new Error("Turn has no model stream.")
    }
    let initialInputHandled = false
    const admitInitialInput = async (): Promise<boolean> => {
      if (initialInputHandled) return true
      initialInputHandled = true
      const promptHook =
        input.input.goalId === undefined
          ? await input.options.hookRunner?.run({
              event: HookEvent.UserPromptSubmit,
              payload: {
                session_id: metadata.id,
                turn_id: input.input.submissionId,
                prompt: input.input.content.text,
              },
              cwd: requireValue(metadata.workingDirectory, "Working directory"),
              signal: input.signal,
            })
          : undefined
      if (promptHook?.continue === false) {
        await recordHookContext(
          input.runtime,
          input.input.submissionId,
          promptHook.additionalContext ?? [],
        )
        return false
      }
      await input.runtime.recordInitialInput()
      admittedAt = Date.now()
      await recordHookContext(
        input.runtime,
        input.input.submissionId,
        promptHook?.additionalContext ?? [],
      )
      return true
    }
    return await executeTurnModelLoop(
      input,
      turn,
      stream,
      modelSession,
      admitInitialInput,
      {
        startedAt: processorStartedAt,
        get admittedAt() {
          return admittedAt
        },
      },
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
  modelSession: ModelClientSession | undefined,
  admitInitialInput: () => Promise<boolean>,
  timing: Readonly<{ startedAt: number; admittedAt: number | undefined }>,
): Promise<TurnCompletion | undefined> {
  const remoteCompaction = modelSession?.remoteCompaction ?? false
  const wireApi = modelSession?.wireApi
  const nativePdf = modelSession?.nativePdf === true
  const metadata = input.runtime.snapshot().metadata
  const latency: { -readonly [K in keyof TurnLatency]: TurnLatency[K] } = {
    setupMs: Math.max(0, Date.now() - timing.startedAt),
    backgroundCompactionMs: 0,
    backgroundCompactionOverlapMs: 0,
    backgroundCompactionsApplied: 0,
    backgroundCompactionsDiscarded: 0,
  }
  const elapsed = () => Math.max(0, Date.now() - timing.startedAt)
  const usages: ModelUsage[] = []
  let modelCalls = 0
  let compactionModelCalls = 0
  let toolCalls = 0
  let modelDurationMs = 0
  let toolDurationMs = 0
  let timeToFirstTokenTotalMs = 0
  let timeToFirstTokenSamples = 0
  let lengthContinuations = 0
  let lengthToolStreak = 0
  let continuingAnswer = false
  let continuationReminderNeeded = true
  let continuationNeedsCompaction = false
  const answerItemIds: string[] = []
  const finish = (reason?: TurnCompletion["reason"]): TurnCompletion => {
    input.runtime.recordTurnMetrics({
      modelCalls: modelCalls + compactionModelCalls,
      toolCalls,
      modelDurationMs,
      toolDurationMs,
      latency: {
        ...latency,
        ...(timing.admittedAt === undefined
          ? {}
          : { admissionMs: Math.max(0, timing.admittedAt - timing.startedAt) }),
      },
      ...(timeToFirstTokenSamples === 0
        ? {}
        : {
            averageTimeToFirstTokenMs: Math.round(
              timeToFirstTokenTotalMs / timeToFirstTokenSamples,
            ),
          }),
    })
    return { answerItemIds: [...answerItemIds], ...(reason ? { reason } : {}) }
  }
  const onCompactionModelTiming = (
    durationMs: number,
    timeToFirstTokenMs: number | undefined,
  ) => {
    // modelCalls also controls normal-step admission and context injection.
    // Compaction shares usage and metrics, but must not advance that counter.
    compactionModelCalls += 1
    modelDurationMs += durationMs
    if (timeToFirstTokenMs !== undefined) {
      timeToFirstTokenTotalMs += timeToFirstTokenMs
      timeToFirstTokenSamples += 1
    }
  }
  let preparedCompaction: BackgroundCompaction | undefined
  let compactedAtModelCall = -1
  const pendingSkillInputs = [input.input]
  const pendingSteering: TurnInput[] = []
  let previousDiagnostics = new Set<string>()
  for (;;) {
    let step: StepContext | undefined
    const pendingTools: Promise<PromiseSettledResult<void>>[] = []
    let pendingToolBatches = 0
    let backgroundWork: Promise<void> | undefined
    let backgroundFailure: { cause: unknown } | undefined
    let backgroundStartedAt: number | undefined
    let backgroundEndedAt: number | undefined
    const backgroundAbort = new AbortController()
    try {
      throwIfAborted(input.signal)
      if (!continuingAnswer) answerItemIds.length = 0
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
      pendingSteering.push(...input.control.takeSteering())
      const instructionConfiguration =
        (await input.options.prepareStepExtensions?.(input.signal)) ?? {}
      step = captureStepContext({
        registry: input.toolRegistry,
        configuration: turn.requestSettings,
        ...(wireApi === undefined ? {} : { wireApi }),
        nativePdf,
      })
      const configuration = step.configuration
      const toolPlan = step.toolRouter
      const workspaceRoot = await resolveWorkspaceRoot(
        configuration.workspaceRoot,
      )
      const diagnostics: InstructionDiagnostic[] = []
      const discoveryInput = {
        workingDirectory: configuration.workspaceRoot,
        ...(instructionConfiguration.projectRootMarkers === undefined
          ? {}
          : {
              projectRootMarkers: instructionConfiguration.projectRootMarkers,
            }),
      }
      const projectInstructions = await input.projectInstructionLoader({
        ...discoveryInput,
        ...(instructionConfiguration.projectInstructionFilenames === undefined
          ? {}
          : {
              fallbackFilenames:
                instructionConfiguration.projectInstructionFilenames,
            }),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      })
      const skillSnapshot = await input.skillsLoader({
        ...discoveryInput,
        ...(instructionConfiguration.skills === undefined
          ? {}
          : { configuration: instructionConfiguration.skills }),
      })
      diagnostics.push(...skillSnapshot.diagnostics)
      const currentDiagnostics = new Set<string>()
      for (const diagnostic of diagnostics) {
        const key = JSON.stringify(diagnostic)
        if (currentDiagnostics.has(key)) continue
        currentDiagnostics.add(key)
        if (previousDiagnostics.has(key)) continue
        const message = `${diagnostic.path}: ${diagnostic.message}`
        input.runtime.emitWarning(message)
        reportOperationalFailure(input.options.onOperationalFailure, {
          operation: "load-instructions",
          cause: new Error(message),
        })
      }
      previousDiagnostics = currentDiagnostics
      const skills = renderSkillsCatalog(skillSnapshot)
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
        (modelCalls === 0 || input.input.manualCompact) &&
        currentInputIndex >= 0
          ? beforeStep.context.history.slice(0, currentInputIndex)
          : beforeStep.context.history
      const admission = assessModelRequest({
        history: compactionHistory,
        activeContextTokens:
          beforeStep.context.contextTokenHistoryAnchorTokens ??
          beforeStep.context.activeContextTokens,
        autoCompactPrefillTokens: beforeStep.context.autoCompactPrefillTokens,
        historyAnchorItemId: beforeStep.context.contextTokenHistoryAnchorItemId,
        baselineProvider: beforeStep.context.contextTokenProvider,
        baselineModel: beforeStep.context.contextTokenModel,
        step,
      })
      const priorModelId = previousModelId(
        beforeStep.context.history,
        input.context,
      )
      const sessionGoal = await input.options.loadSessionGoal?.()
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
        ...(sessionGoal === undefined
          ? {}
          : {
              goal: sessionGoal.objective,
              ...(sessionGoal.status === undefined
                ? {}
                : { goalStatus: sessionGoal.status }),
            }),
        ...(input.options.agentControl === undefined
          ? {}
          : {
              multiAgent: input.options.agentControl.runtimeContext(
                metadata.id,
              ),
            }),
      })
      const compactionEpoch = JSON.stringify([
        configuration,
        step.toolRouter.modelDefinitions,
        step.toolWireProtocol,
        projectInstructions,
        skills,
        input.options.additionalInstructions,
      ])
      if (preparedCompaction !== undefined) {
        const candidate = preparedCompaction
        preparedCompaction = undefined
        if (
          candidate.epoch === compactionEpoch &&
          !input.signal.aborted &&
          pendingSteering.length === 0
        ) {
          const applied = await input.runtime.replaceConversationHistory({
            replacement: candidate.replacement,
            summary: candidate.summary,
            baseHistoryLength: candidate.prefix.length,
            expectedPrefix: candidate.prefix,
          })
          if (applied) {
            latency.backgroundCompactionsApplied += 1
            const item: StartedExecutionItem = {
              type: "context_compaction",
              itemId: createCompactionId(),
            }
            input.runtime.emitItemStarted(item)
            await input.runtime.recordItemCompletions([
              completeCompactionItem(item, "completed"),
            ])
            const history = input.runtime.snapshot().context.history
            const tokens = estimateModelRequestBudget({
              target: step.target,
              system: [configuration.baseInstructions],
              messages: history.map(({ item }) => item),
              tools: step.toolRouter.modelDefinitions,
              toolWireProtocol: step.toolWireProtocol,
            }).estimatedInputTokens
            await input.runtime.recordContextTokens({
              activeContextTokens: tokens,
              inputTokens: tokens,
              estimatedPrefill: true,
              historyAnchorItemId:
                history.at(-1)?.id ?? input.input.submissionId,
              provider: step.target.provider,
              model: step.target.model,
            })
            continuationReminderNeeded = true
            budget?.rearm(metadata.id)
            continue
          }
        }
        latency.backgroundCompactionsDiscarded += 1
      }
      if (input.input.manualCompact) {
        await input.runtime.recordModelContext({
          provider: step.target.provider,
          model: step.target.model,
          ...(step.modelInfo.compactionHash === undefined
            ? {}
            : { compactionHash: step.modelInfo.compactionHash }),
        })
        const compacted = await compactLiveHistory({
          runtime: input.runtime,
          turnId: input.input.submissionId,
          step,
          worldState,
          history: compactionHistory,
          baseHistoryLength: beforeStep.context.history.length,
          stream,
          remoteCompaction,
          signal: input.signal,
          rolloutAssets: input.options.rolloutAssets,
          usages,
          onModelTiming: onCompactionModelTiming,
          rolloutBudget: budget,
          onOperationalFailure: input.options.onOperationalFailure,
          ...(input.options.hookRunner === undefined
            ? {}
            : { hookRunner: input.options.hookRunner }),
          setActiveStream: input.setActiveStream,
          trigger: "manual",
        })
        if (!compacted)
          throw new Error("There is no conversation history to compact.")
        input.runtime.recordTurnMetrics({
          modelCalls: compactionModelCalls,
          toolCalls: 0,
          modelDurationMs,
          toolDurationMs: 0,
          ...(timeToFirstTokenSamples === 0
            ? {}
            : {
                averageTimeToFirstTokenMs: Math.round(
                  timeToFirstTokenTotalMs / timeToFirstTokenSamples,
                ),
              }),
        })
        return
      }
      const nativeCheckpoints = beforeStep.context.history
        .flatMap(({ item }) => (item.role === "assistant" ? item.content : []))
        .filter((block) => block.type === "compaction")
      const foreignCheckpoint = nativeCheckpoints.find(
        (block) => block.provider !== step?.target.provider,
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
        if (
          foreignCheckpoint !== undefined &&
          !client?.hasProvider(sourceSelection.provider)
        ) {
          throw new Error(
            `Native checkpoint continuation requires ${sourceSelection.provider}/${sourceSelection.model}. Restore its provider connection and model configuration before continuing.`,
          )
        }
        const sourceSession =
          sourceSelection.provider === step.target.provider
            ? modelSession
            : client?.startTurn(
                sourceSelection.provider,
                resolveModelRequestPolicy(
                  input.context.configuration.modelTransport,
                  sourceSelection.provider,
                ),
              )
        try {
          const sourceModels = sourceSession?.models
          await sourceModels?.refresh()
          const {
            modelContextWindowTokens: _contextWindowOverride,
            ...sourceSnapshot
          } = input.context.configuration
          let sourceConfiguration: ResolvedStepConfiguration | undefined
          try {
            sourceConfiguration = SessionConfiguration.restore(
              {
                ...(sourceSelection.provider === step.target.provider
                  ? input.context.configuration
                  : sourceSnapshot),
                defaultTarget: sourceSelection,
              },
              sourceModels,
            ).resolveStep(sourceSelection, sourceModels)
          } catch (error) {
            if (!(error instanceof ModelNotConfiguredError)) throw error
            if (
              nativeCheckpoints.some(
                (block) =>
                  block.provider === sourceSelection.provider &&
                  block.model === sourceSelection.model,
              )
            ) {
              throw new Error(
                `Native checkpoint continuation requires ${sourceSelection.provider}/${sourceSelection.model}. Restore its provider connection and model configuration before continuing.`,
                { cause: error },
              )
            }
            // Ordinary history is portable. A removed prior model cannot prepare
            // a checkpoint; let the selected model's admission use its transport.
          }
          if (sourceConfiguration !== undefined) {
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
              const sourceStep = captureStepContext({
                registry: input.toolRegistry,
                configuration: sourceConfiguration,
                ...(sourceSession?.wireApi === undefined
                  ? {}
                  : { wireApi: sourceSession.wireApi }),
                nativePdf: sourceSession?.nativePdf === true,
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
                  onModelTiming: onCompactionModelTiming,
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
              compactedAtModelCall = modelCalls
              continue
            }
          }
        } finally {
          if (sourceSession !== modelSession) await sourceSession?.close()
        }
      }
      if (
        (admission.shouldCompact || continuationNeedsCompaction) &&
        compactedAtModelCall !== modelCalls
      ) {
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
          onModelTiming: onCompactionModelTiming,
          rolloutBudget: budget,
          onOperationalFailure: input.options.onOperationalFailure,
          ...(input.options.hookRunner === undefined
            ? {}
            : { hookRunner: input.options.hookRunner }),
          setActiveStream: input.setActiveStream,
        })
        if (compacted) {
          compactedAtModelCall = modelCalls
          continuationNeedsCompaction = false
          // The previous reminder may have been replaced by the checkpoint.
          continuationReminderNeeded = true
          continue
        }
        if (continuingAnswer && answerItemIds.length > 0) {
          if (pendingSteering.length === 0) {
            const completion = input.control.takeSteeringOrComplete()
            if (completion.type === "complete") return finish("truncated")
            pendingSteering.push(...completion.inputs)
          }
          continuationNeedsCompaction = false
          continuingAnswer = false
        } else {
          throw new Error(
            "Context limit reached with no history available to compact.",
          )
        }
      }
      if (
        continuingAnswer &&
        pendingSteering.length === 0 &&
        admission.shouldCompact &&
        compactedAtModelCall === modelCalls
      ) {
        const completion = input.control.takeSteeringOrComplete()
        if (completion.type === "steering") {
          pendingSteering.push(...completion.inputs)
          continuingAnswer = false
          continue
        }
        return finish("truncated")
      }
      if (modelCalls === 0 && !input.input.manualCompact) {
        if (!(await admitInitialInput())) return
      }
      const acceptedSteering = await recordSteering(
        input,
        pendingSteering.splice(0),
      )
      pendingSkillInputs.push(...acceptedSteering)
      if (acceptedSteering.length > 0) {
        answerItemIds.length = 0
        continuingAnswer = false
        continuationReminderNeeded = true
        continuationNeedsCompaction = false
      }
      if (continuingAnswer && continuationReminderNeeded) {
        await input.runtime.recordConversationItems([
          envelope(input.input.submissionId, {
            role: "developer",
            content: [{ type: "text", text: LENGTH_CONTINUE_REMINDER }],
          }),
        ])
        continuationReminderNeeded = false
      }
      for (const submitted of pendingSkillInputs.splice(0)) {
        if (submitted.goalId !== undefined) continue
        const alreadyLoaded = input.runtime
          .snapshot()
          .context.history.some(
            ({ item }) =>
              (item.role === "user" || item.role === "developer") &&
              item.context?.type === "skill_invocation" &&
              item.context.inputId === submitted.submissionId,
          )
        if (alreadyLoaded) continue
        const text = await loadExplicitSkillInstructions(
          submitted.content.text,
          skillSnapshot,
          (message) => input.runtime.emitWarning(message),
          instructionConfiguration.skillMcpServers === undefined
            ? undefined
            : { mcpServers: instructionConfiguration.skillMcpServers },
        )
        if (text !== undefined)
          await input.runtime.recordConversationItems([
            envelope(submitted.submissionId, {
              role: "user",
              content: [{ type: "text", text }],
              context: {
                type: "skill_invocation",
                inputId: submitted.submissionId,
              },
            }),
          ])
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

      const stablePrefix = input.runtime.snapshot().context.history
      const durableMessages = completeToolCallHistory(
        stablePrefix.map(({ item }) => item),
      )
      const messages = durableMessages
      let visibleFileObservations =
        createVisibleFileObservationsFromMessages(messages)
      const adapted = adaptImagesForModel(messages, step.target, step.modelInfo)
      let requestHistoryAnchorItemId = input.runtime
        .snapshot()
        .context.history.at(-1)?.id
      const request: ModelRequest = {
        streamOutputItems: true,
        async rebuildMessagesAfterOutput() {
          // Codex rebuilds retry input from history after draining in-flight
          // tools. Replaying the original prompt would hide completed effects.
          const outcomes = await Promise.all(pendingTools)
          for (const outcome of outcomes) {
            if (outcome.status === "rejected") throw outcome.reason
          }
          throwIfAborted(input.signal)
          const currentHistory = input.runtime.snapshot().context.history
          requestHistoryAnchorItemId = currentHistory.at(-1)?.id
          const history = completeToolCallHistory(
            currentHistory.map(({ item }) => item),
          )
          // The retry can now act on newly visible reads. Reads completed
          // during the previous attempt did not authorize that attempt's tools.
          visibleFileObservations =
            createVisibleFileObservationsFromMessages(history)
          return resolveRolloutAssetMedia(
            adaptImagesForModel(
              history,
              executionStep.target,
              executionStep.modelInfo,
            ).messages,
            input.options.rolloutAssets,
            executionStep.documentReading,
            input.signal,
          )
        },
        target: step.target,
        cacheKey: configuration.promptCacheKey,
        system: [
          configuration.baseInstructions,
          ...(input.options.additionalInstructions === undefined
            ? []
            : [input.options.additionalInstructions]),
        ],
        messages: await resolveRolloutAssetMedia(
          adapted.messages,
          input.options.rolloutAssets,
          step.documentReading,
          input.signal,
        ),
        tools: toolPlan.modelDefinitions,
        toolWireProtocol: step.toolWireProtocol,
        ...(configuration.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: configuration.maxOutputTokens }),
        signal: input.signal,
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
      let responseItemId = `message_${globalThis.crypto.randomUUID()}`
      const estimatedInputTokens =
        estimateModelRequestBudget(request).estimatedInputTokens
      const inputLimit = configuration.modelCapacity?.inputContextLimitTokens
      // Recovery must also fit newly injected instructions and tool schemas.
      // Fresh user requests retain provider admission; a continuation must not
      // repeatedly spend its budget on a request we already know cannot fit.
      if (
        continuingAnswer &&
        inputLimit !== undefined &&
        estimatedInputTokens >= inputLimit
      ) {
        if (compactedAtModelCall !== modelCalls) {
          continuationNeedsCompaction = true
          continue
        }
        const completion = input.control.takeSteeringOrComplete()
        if (completion.type === "steering") {
          pendingSteering.push(...completion.inputs)
          continuingAnswer = false
          continue
        }
        return finish("truncated")
      }
      let sampledContext:
        | Readonly<{
            activeContextTokens: number
            inputTokens: number
            estimatedPrefill: boolean
          }>
        | undefined
      const modelStartedAt = Date.now()
      latency.firstRequestMs ??= elapsed()
      input.runtime.recordRequestStartedAt(modelStartedAt)
      let firstTokenAt: number | undefined
      const executionStep = step
      const callIndex = modelCalls + 1
      let scheduled = Promise.resolve()
      let drained = Promise.resolve()
      const dispatchedCallIds = new Set<string>()
      const startCalls = (calls: readonly ModelToolCallBlock[]) => {
        if (calls.length === 0) return
        for (const call of calls) {
          if (dispatchedCallIds.has(call.id))
            throw new Error("Model repeated an executed tool call id.")
          dispatchedCallIds.add(call.id)
        }
        let resolveScheduled!: () => void
        const ready = {
          promise: new Promise<void>((resolve) => {
            resolveScheduled = resolve
          }),
          resolve: () => resolveScheduled(),
        }
        const previousSchedule = scheduled
        const previousResults = drained
        scheduled = ready.promise
        pendingToolBatches += 1
        const work = previousSchedule
          .then(async () => {
            const onScheduled = () => ready.resolve()
            const toolsStartedAt = Date.now()
            const results = executeToolCalls({
              calls,
              onScheduled,
              threadId: metadata.id,
              rolloutId: metadata.rolloutId,
              turnId: input.input.submissionId,
              workspaceRoot,
              signal: input.signal,
              documentReading: executionStep.documentReading,
              toolPlan,
              permissionGate: input.permissionGate,
              recordToolStarted: async (item) => {
                latency.firstToolMs ??= elapsed()
                await input.runtime.recordToolStarted(item)
              },
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
                      executionStep.target,
                    ),
                  }),
            })
            toolCalls += calls.length
            for await (const { call, item, result } of results) {
              await previousResults
              const { toolContentTruncated, ...modelContent } =
                await finalizeToolOutput(
                  result,
                  {
                    maxBytes:
                      executionStep.executionPolicy.modelVisibleToolResultBytes,
                    maxLines:
                      executionStep.executionPolicy.modelVisibleToolResultLines,
                  },
                  {
                    workspaceRoot,
                    rolloutId: metadata.rolloutId,
                    toolCallId: call.id,
                    ...(input.options.rolloutAssets === undefined
                      ? {}
                      : { rolloutAssets: input.options.rolloutAssets }),
                  },
                )
              const fileObservations =
                toolContentTruncated !== true
                  ? toolFileObservations(result)
                  : []
              const resultItem = envelope(input.input.submissionId, {
                role: "tool",
                toolCallId: call.id,
                ...modelContent,
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
              await input.runtime.recordToolResult(
                resultItem,
                completeToolItem(
                  toolPlan,
                  item,
                  resultItem.id,
                  result,
                  modelContent,
                ),
              )
            }
            toolDurationMs += Date.now() - toolsStartedAt
          })
          .finally(() => {
            pendingToolBatches -= 1
            ready.resolve()
          })
        const outcome = work.then(
          () => ({ status: "fulfilled" as const, value: undefined }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        )
        pendingTools.push(outcome)
        drained = outcome.then(() => {})
      }
      const committedContent: ModelContentBlock[] = []
      const committedCallIds = new Set<string>()
      let committedBytes = 0
      let answerStartIndex = answerItemIds.length
      const recordOutput = async (
        content: readonly ModelContentBlock[],
        itemId: string,
        providerRequestId?: string,
      ) => {
        if (
          content.some(
            (block) =>
              block.type === "tool_call" ||
              (block.type === "text" && block.text.trim().length > 0),
          )
        )
          latency.firstUsefulOutputMs ??= elapsed()
        const item = envelope(
          input.input.submissionId,
          { role: "assistant", content },
          {
            provider: executionStep.target.provider,
            model: executionStep.target.model,
            callIndex,
            ...(providerRequestId === undefined
              ? {}
              : { requestId: providerRequestId }),
          },
          itemId,
        )
        await input.runtime.recordConversationItems([item])
        await input.runtime.recordItemCompletions(completedResponseItems(item))
        if (content.some((block) => block.type === "tool_call")) {
          answerItemIds.length = 0
          answerStartIndex = 0
          continuationReminderNeeded = true
        } else if (
          content.some(
            (block) => block.type === "text" && block.text.length > 0,
          )
        ) {
          answerItemIds.push(item.id)
        }
      }
      const response = await consumeModelStream({
        request,
        stream,
        async onOutputItem(content, itemId) {
          throwIfAborted(input.signal)
          committedBytes += utf8Bytes(JSON.stringify(content))
          if (
            committedBytes >
            executionStep.executionPolicy.assistantResponseBytes
          ) {
            throw new Error(
              "Assistant response exceeded the configured byte limit.",
            )
          }
          for (const block of content) {
            if (block.type !== "tool_call") continue
            if (committedCallIds.has(block.id))
              throw new Error("Model repeated a committed tool call id.")
            committedCallIds.add(block.id)
          }
          await recordOutput(content, itemId)
          committedContent.push(...content)
          startCalls(
            content.filter(
              (block): block is ModelToolCallBlock =>
                block.type === "tool_call",
            ),
          )
        },
        threadId: metadata.id,
        turnId: input.input.submissionId,
        get itemId() {
          return responseItemId
        },
        emitModelStream: (event) => {
          if (event.kind === "assistant" && event.delta.trim().length > 0)
            latency.firstUsefulOutputMs ??= elapsed()
          input.runtime.emitModelStream(event)
        },
        emitWarning: (message, diagnostic) =>
          input.runtime.emitWarning(message, diagnostic),
        assistantResponseBytes: step.executionPolicy.assistantResponseBytes,
        onOperationalFailure: input.options.onOperationalFailure,
        onRetry(committed) {
          input.runtime.invalidateRequestStartedAt()
          if (committed) {
            // A transport retry starts another attempt, not a Length answer
            // fragment. Earlier Length continuations still belong to the answer.
            answerItemIds.length = Math.min(
              answerItemIds.length,
              answerStartIndex,
            )
            committedContent.length = 0
            committedBytes = 0
            sampledContext = undefined
            responseItemId = `message_${globalThis.crypto.randomUUID()}`
          }
        },
        onFirstToken: () => {
          firstTokenAt ??= Date.now()
        },
        async onUsage(usage) {
          usages.push(usage)
          const aggregate = aggregateTokenUsage(usages)
          if (aggregate !== undefined)
            await input.runtime.recordUsage(aggregate)
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
      modelDurationMs += Date.now() - modelStartedAt
      if (firstTokenAt !== undefined) {
        timeToFirstTokenTotalMs += firstTokenAt - modelStartedAt
        timeToFirstTokenSamples += 1
      }
      throwIfAborted(input.signal)

      const calls = response.content.filter(
        (block): block is ModelToolCallBlock => block.type === "tool_call",
      )
      if (new Set(calls.map((call) => call.id)).size !== calls.length) {
        throw new Error("Model repeated a tool call id.")
      }
      if (
        response.stopReason === ModelStopReason.ToolUse &&
        calls.length === 0
      ) {
        throw new Error(
          "tool_use stop reason requires at least one complete tool call.",
        )
      }
      if (
        response.stopReason !== ModelStopReason.ToolUse &&
        response.stopReason !== ModelStopReason.Length &&
        calls.length > 0
      ) {
        throw new Error("Non-tool_use responses must not include tool calls.")
      }
      if (
        response.stopReason !== ModelStopReason.EndTurn &&
        response.stopReason !== ModelStopReason.ToolUse &&
        response.stopReason !== ModelStopReason.Length &&
        response.stopReason !== ModelStopReason.ContentFilter
      ) {
        throw new Error("Model response has an unsupported stop reason.")
      }
      if (
        utf8Bytes(JSON.stringify(response.content)) >
        step.executionPolicy.assistantResponseBytes
      ) {
        throw new Error(
          "Assistant response exceeded the configured byte limit.",
        )
      }
      // Terminal output includes completed items; never record or execute them twice.
      if (
        JSON.stringify(response.content.slice(0, committedContent.length)) !==
        JSON.stringify(committedContent)
      ) {
        throw new Error("Terminal model output disagrees with committed items.")
      }
      const remaining = response.content.slice(committedContent.length)
      if (remaining.length > 0)
        await recordOutput(
          remaining,
          responseItemId,
          response.providerRequestId,
        )
      // GUI shows the model's full usage sample. Streaming tools can interleave
      // unseen results in history: budget calibration instead anchors input
      // tokens at the exact request prefix, then estimates the appended tail.
      if (sampledContext !== undefined) {
        const streamedTools = committedContent.some(
          (block) => block.type === "tool_call",
        )
        const historyAnchorItemId = streamedTools
          ? requestHistoryAnchorItemId
          : input.runtime.snapshot().context.history.at(-1)?.id
        if (historyAnchorItemId !== undefined) {
          await input.runtime.recordContextTokens({
            ...sampledContext,
            ...(streamedTools
              ? { historyAnchorTokens: sampledContext.inputTokens }
              : {}),
            historyAnchorItemId,
            provider: step.target.provider,
            model: step.target.model,
            ...(step.configuration.modelCapacity
              ?.effectiveContextWindowTokens === undefined
              ? {}
              : {
                  capacityTokens:
                    step.configuration.modelCapacity
                      .effectiveContextWindowTokens,
                }),
          })
        }
      }
      if (
        response.incompleteToolCalls &&
        response.stopReason !== ModelStopReason.ContentFilter
      ) {
        // Complete streamed calls may already have run. Preserve their results,
        // but never start any additional calls from an incomplete terminal batch.
        throw new Error("Model response contained an incomplete tool call.")
      }
      const lengthStopped = response.stopReason === ModelStopReason.Length
      lengthToolStreak =
        lengthStopped && calls.length > 0 ? lengthToolStreak + 1 : 0
      startCalls(
        remaining.filter(
          (block): block is ModelToolCallBlock => block.type === "tool_call",
        ),
      )
      // Reuse the now-idle model channel while tools run. Never prepare on
      // native/opaque checkpoint providers or move side-effecting hooks into a
      // speculative path. Start only once compaction is already due: awaiting
      // unfinished preparation at handoff overlaps an otherwise serial wait,
      // rather than adding speculative latency to an admitted next request.
      // Foreground compaction remains the universal fallback.
      const afterResponse = input.runtime.snapshot().context
      if (
        calls.length > 0 &&
        pendingToolBatches > 0 &&
        !remoteCompaction &&
        input.options.hookRunner === undefined &&
        !lengthStopped &&
        canCompactPrefix(stablePrefix) &&
        assessModelRequest({
          history: afterResponse.history,
          activeContextTokens:
            afterResponse.contextTokenHistoryAnchorTokens ??
            afterResponse.activeContextTokens,
          autoCompactPrefillTokens: afterResponse.autoCompactPrefillTokens,
          historyAnchorItemId: afterResponse.contextTokenHistoryAnchorItemId,
          baselineProvider: afterResponse.contextTokenProvider,
          baselineModel: afterResponse.contextTokenModel,
          step,
        }).shouldCompact
      ) {
        const prefix = structuredClone(stablePrefix)
        const signal = AbortSignal.any([input.signal, backgroundAbort.signal])
        backgroundWork = (async () => {
          const startedAt = Date.now()
          backgroundStartedAt = startedAt
          let firstTokenAt: number | undefined
          let requestStartedAt: number | undefined
          try {
            const messages = await resolveRolloutAssetMedia(
              adaptImagesForModel(
                prefix.map(({ item }) => item),
                step.target,
                step.modelInfo,
              ).messages,
              input.options.rolloutAssets,
              step.documentReading,
              signal,
            )
            requestStartedAt = Date.now()
            const result = await consumeModelStream({
              request: buildCompactionRequest({
                source: [{ messages }],
                target: step.target,
                baseInstructions: configuration.baseInstructions,
                cacheKey: configuration.promptCacheKey,
                ...(configuration.maxOutputTokens === undefined
                  ? {}
                  : { maxOutputTokens: configuration.maxOutputTokens }),
                signal,
              }),
              stream,
              threadId: metadata.id,
              turnId: input.input.submissionId,
              assistantResponseBytes:
                step.executionPolicy.assistantResponseBytes,
              emitWarning: (message, diagnostic) =>
                input.runtime.emitWarning(message, diagnostic),
              onOperationalFailure: input.options.onOperationalFailure,
              onFirstToken() {
                firstTokenAt ??= Date.now()
              },
              async onUsage(usage) {
                usages.push(usage)
                const aggregate = aggregateTokenUsage(usages)
                if (aggregate !== undefined)
                  await input.runtime.recordUsage(aggregate)
                budget?.recordUsage(usage)
              },
              setActiveStream: input.setActiveStream,
            })
            if (
              result.stopReason !== ModelStopReason.EndTurn ||
              result.incompleteToolCalls ||
              result.content.some(
                (block) => block.type !== "text" && block.type !== "reasoning",
              )
            )
              return
            const summary = result.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("")
              .trim()
            if (summary.length === 0 || signal.aborted) return
            const checkpoint = createCompactionReplacementHistory({
              summary,
            })[0]
            if (checkpoint === undefined) return
            preparedCompaction = createBackgroundCompaction({
              prefix,
              epoch: compactionEpoch,
              summary,
              checkpoint: envelope(input.input.submissionId, checkpoint),
            })
          } catch (error) {
            if (!signal.aborted && !isAbortError(error)) {
              if (
                error instanceof ModelFailureError ||
                isContextOverflowError(error)
              ) {
                // Operational provider failures leave the source untouched;
                // ordinary foreground compaction can retry at the checkpoint.
                reportOperationalFailure(input.options.onOperationalFailure, {
                  operation: "compact",
                  cause: error,
                })
              } else {
                // Persistence and invariant failures must not be hidden by the
                // optimization. Capture immediately to avoid an unhandled
                // rejection while tools drain, then fail at the safe boundary.
                backgroundFailure = { cause: error }
              }
            }
          } finally {
            backgroundEndedAt = Date.now()
            latency.backgroundCompactionMs += Math.max(
              0,
              backgroundEndedAt - startedAt,
            )
            if (preparedCompaction === undefined)
              latency.backgroundCompactionsDiscarded += 1
            if (requestStartedAt !== undefined)
              onCompactionModelTiming(
                Date.now() - requestStartedAt,
                firstTokenAt === undefined
                  ? undefined
                  : firstTokenAt - requestStartedAt,
              )
            input.setActiveStream(undefined)
          }
        })()
      }
      const outcomes = await Promise.all(pendingTools)
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") throw outcome.reason
      }
      const toolsDrainedAt = Date.now()
      await backgroundWork
      if (backgroundFailure !== undefined) throw backgroundFailure.cause
      if (backgroundStartedAt !== undefined && backgroundEndedAt !== undefined)
        latency.backgroundCompactionOverlapMs += Math.max(
          0,
          Math.min(toolsDrainedAt, backgroundEndedAt) - backgroundStartedAt,
        )

      if (calls.length > 0) {
        // Stop before another request can start early streamed tools. Both
        // streamed and terminal-only providers execute the same bounded streak.
        if (lengthToolStreak >= MAX_LENGTH_TOOL_STREAK) {
          throw new Error(
            "Model repeatedly hit its generation limit during tool calls.",
          )
        }
        answerItemIds.length = 0
        continuingAnswer = false
        continuationReminderNeeded = true
        continue
      }

      let reason: TurnCompletion["reason"]
      if (lengthStopped) {
        const hasText = response.content.some(
          (block) => block.type === "text" && block.text.trim().length > 0,
        )
        if (!hasText && (!continuingAnswer || answerItemIds.length === 0)) {
          throw new Error("Model response was truncated without usable text.")
        }
        if (hasText && lengthContinuations < MAX_LENGTH_CONTINUATIONS) {
          lengthContinuations += 1
          continuingAnswer = true
          continuationNeedsCompaction = response.lengthReason === "context"
          input.runtime.emitWarning(
            `Model answer reached its generation limit; continuing (${lengthContinuations}/${MAX_LENGTH_CONTINUATIONS}).`,
            {
              code: "model_length_continuation",
              message: "Continuing a partial model answer.",
              details: {
                provider: step.target.provider,
                model: step.target.model,
                maxOutputTokens: request.maxOutputTokens ?? null,
                stopReason: response.rawStopReason ?? response.stopReason,
                lengthReason: response.lengthReason ?? "unknown",
                inputTokens: response.usage?.inputTokens ?? null,
                outputTokens: response.usage?.outputTokens ?? null,
                continuation: lengthContinuations,
              },
            },
          )
          continue
        }
        reason = "truncated"
      } else if (response.stopReason === ModelStopReason.ContentFilter) {
        reason = "refused"
      }
      continuingAnswer = false

      const completion = input.control.takeSteeringOrComplete()
      if (completion.type === "steering") {
        pendingSteering.push(...completion.inputs)
        continue
      }
      if (reason !== undefined) return finish(reason)
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
        answerItemIds.length = 0
        continuationReminderNeeded = true
        continue
      }
      await recordHookContext(
        input.runtime,
        input.input.submissionId,
        stopHook?.additionalContext ?? [],
      )
      return finish()
    } catch (error) {
      if (
        modelCalls === 0 &&
        !input.input.manualCompact &&
        !input.signal.aborted
      )
        await admitInitialInput()
      if (!input.signal.aborted && isContextOverflowError(error)) {
        const capacity =
          step?.configuration.modelCapacity?.effectiveContextWindowTokens
        if (capacity !== undefined && step !== undefined)
          await input.runtime.recordContextTokens({
            activeContextTokens: capacity,
            capacityTokens: capacity,
            historyAnchorItemId:
              input.runtime.snapshot().context.history.at(-1)?.id ??
              input.input.submissionId,
            provider: step.target.provider,
            model: step.target.model,
          })
      }
      throw error
    } finally {
      backgroundAbort.abort()
      await backgroundWork
      await Promise.all(pendingTools)
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
  readonly emitWarning?: TurnRuntime["emitWarning"]
  readonly assistantResponseBytes: number
  readonly onOperationalFailure:
    | TurnProcessorOperationalFailureReporter
    | undefined
  readonly onOutputItem?: (
    content: readonly ModelContentBlock[],
    itemId: string,
  ) => Promise<void>
  readonly onFirstToken?: () => void
  readonly onRetry?: (committedOutput: boolean) => void
  readonly onUsage: (usage: ModelUsage) => void | Promise<void>
  readonly setActiveStream: (
    stream: AsyncIterator<ModelStreamEvent> | undefined,
  ) => void
}): Promise<ModelResponse> {
  const iterator = input.stream(input.request)[Symbol.asyncIterator]()
  input.setActiveStream(iterator)
  let terminal: ModelResponse | undefined
  let exhausted = false
  const provisionalItems = new Set<string>()
  const displayItemId = (providerItemId?: string) =>
    input.itemId === undefined || providerItemId === undefined
      ? input.itemId
      : `${input.itemId}_${providerItemId}`
  const streamedBytes = { assistant: 0, reasoning: 0 }
  const trailingHighSurrogate = { assistant: "", reasoning: "" }
  try {
    for (;;) {
      const next = await iterator.next()
      if (next.done) {
        if (input.request.signal?.aborted) throw abortError()
        exhausted = true
        break
      }
      const event = next.value
      if (event.type === "retry") {
        const discardedResponseItemIds = [...provisionalItems]
        provisionalItems.clear()
        input.onRetry?.(event.committedOutput === true)
        streamedBytes.assistant = 0
        streamedBytes.reasoning = 0
        trailingHighSurrogate.assistant = ""
        trailingHighSurrogate.reasoning = ""
        if (event.usage !== undefined) await input.onUsage(event.usage)
        input.emitWarning?.(
          `Model request failed (${event.failure.kind}); retrying attempt ${String(event.nextAttempt)} of ${String(event.maxAttempts)} in ${String(Math.round(event.delayMs))} ms.`,
          {
            message: event.failure.message,
            code: "model.retry",
            details: {
              ...(discardedResponseItemIds.length === 0
                ? {}
                : { discardedResponseItemIds }),
              attempt: event.attempt,
              nextAttempt: event.nextAttempt,
              maxAttempts: event.maxAttempts,
              delayMs: event.delayMs,
              kind: event.failure.kind,
              stage: event.failure.stage,
              provider: event.failure.provider,
              wireApi: event.failure.wireApi,
              ...(event.failure.status === undefined
                ? {}
                : { status: event.failure.status }),
              ...(event.failure.providerCode === undefined
                ? {}
                : { providerCode: event.failure.providerCode }),
            },
          },
        )
        continue
      }
      if (event.type === "cancelled") {
        if (event.usage !== undefined) await input.onUsage(event.usage)
        if (input.request.signal?.aborted) throw abortError()
        throw new Error("Model provider cancelled without caller cancellation.")
      }
      if (event.type === "failure") {
        if (event.usage !== undefined) await input.onUsage(event.usage)
        reportOperationalFailure(input.onOperationalFailure, {
          operation: "model-request",
          cause: event.cause ?? event.failure,
        })
        throw new ModelFailureError(event.failure, { cause: event.cause })
      }
      if (event.type === "output_item") {
        if (input.onOutputItem === undefined)
          throw new Error("Unexpected committed model output.")
        const itemId = displayItemId(event.itemId)
        if (itemId === undefined)
          throw new Error("Committed output requires a display item id.")
        await input.onOutputItem(event.content, itemId)
        provisionalItems.delete(itemId)
        continue
      }
      if (event.type !== "response") {
        if (input.request.compaction === "remote_v2") continue
        input.onFirstToken?.()
        const kind =
          event.type === "reasoning_delta" ? "reasoning" : "assistant"
        let text = trailingHighSurrogate[kind] + event.text
        trailingHighSurrogate[kind] = ""
        const last = text.charCodeAt(text.length - 1)
        if (last >= 0xd800 && last <= 0xdbff) {
          trailingHighSurrogate[kind] = text.slice(-1)
          text = text.slice(0, -1)
        }
        streamedBytes[kind] += utf8Bytes(text)
        if (streamedBytes[kind] > input.assistantResponseBytes) {
          throw new Error(
            "Model stream update exceeded the configured byte limit.",
          )
        }
        const itemId = displayItemId(event.itemId)
        if (itemId !== undefined) {
          provisionalItems.add(itemId)
          input.emitModelStream?.({
            itemId,
            kind,
            delta: event.text,
          })
        }
        continue
      }
      if (terminal !== undefined) {
        throw new Error("Model stream emitted more than one terminal response.")
      }
      terminal = event.response
      for (const kind of ["assistant", "reasoning"] as const) {
        streamedBytes[kind] += utf8Bytes(trailingHighSurrogate[kind])
        if (streamedBytes[kind] > input.assistantResponseBytes) {
          throw new Error(
            "Model stream update exceeded the configured byte limit.",
          )
        }
      }
      input.onFirstToken?.()
      if (event.response.usage !== undefined)
        await input.onUsage(event.response.usage)
    }
  } catch (error) {
    if (input.request.signal?.aborted) {
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
      : input.history.findIndex((item) => item.id === input.historyAnchorItemId)
  const hasAnchoredMeasurement =
    input.activeContextTokens !== undefined && anchorIndex >= 0
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
    input.step.configuration.modelCapacity?.inputContextLimitTokens
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

async function compactLiveHistory(
  input: Readonly<{
    trigger?: "manual" | "auto"
    remoteCompaction?: boolean
    fallback?: Readonly<{ step: StepContext; stream: StreamFn }>
    injectWorldState?: boolean
    runtime: TurnRuntime
    turnId: string
    step: StepContext
    worldState: WorldState
    history: readonly ResponseItemEnvelope[]
    baseHistoryLength?: number
    stream: StreamFn
    signal: AbortSignal
    rolloutAssets: RolloutAssets | undefined
    usages: ModelUsage[]
    onModelTiming: (
      durationMs: number,
      timeToFirstTokenMs: number | undefined,
    ) => void
    rolloutBudget: RolloutBudget | undefined
    hookRunner?: HookRunner
    onOperationalFailure: TurnProcessorOperationalFailureReporter | undefined
    setActiveStream: (
      stream: AsyncIterator<ModelStreamEvent> | undefined,
    ) => void
  }>,
): Promise<boolean> {
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
      trigger: input.trigger ?? "auto",
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
    itemId: createCompactionId(),
  }
  input.runtime.emitItemStarted(compactionItem)
  let completed = false

  try {
    const compact = async (request: ModelRequest) => {
      const modelStartedAt = Date.now()
      input.runtime.recordRequestStartedAt(modelStartedAt)
      let firstTokenAt: number | undefined
      const response = await consumeModelStream({
        request,
        stream: compactionStream,
        threadId: input.runtime.snapshot().metadata.id,
        turnId: input.turnId,
        assistantResponseBytes:
          compactionStep.executionPolicy.assistantResponseBytes,
        emitWarning: (message, diagnostic) =>
          input.runtime.emitWarning(message, diagnostic),
        onOperationalFailure: input.onOperationalFailure,
        onRetry: input.runtime.invalidateRequestStartedAt,
        onFirstToken() {
          firstTokenAt ??= Date.now()
        },
        async onUsage(usage) {
          input.usages.push(usage)
          const aggregate = aggregateTokenUsage(input.usages)
          if (aggregate !== undefined)
            await input.runtime.recordUsage(aggregate)
          input.rolloutBudget?.recordUsage(usage)
        },
        setActiveStream: input.setActiveStream,
      })
      input.onModelTiming(
        Date.now() - modelStartedAt,
        firstTokenAt === undefined ? undefined : firstTokenAt - modelStartedAt,
      )
      if (response.stopReason === ModelStopReason.Length) {
        // Provider-owned streams retry truncated compaction before returning.
        // Keep the replacement guard for directly injected ModelClients too.
        throw new Error("Compaction was truncated by a generation limit.")
      }
      if (
        response.stopReason !== ModelStopReason.EndTurn ||
        response.incompleteToolCalls ||
        response.content.some((block) => block.type === "tool_call")
      ) {
        throw new Error("Compaction did not produce a complete summary.")
      }
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
      const messages = await resolveRolloutAssetMedia(
        adaptImagesForModel(
          completeToolCallHistory(source),
          compactionStep.target,
          compactionStep.modelInfo,
        ).messages,
        input.rolloutAssets,
        compactionStep.documentReading,
        input.signal,
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
                ...(compactionStep.configuration.maxOutputTokens === undefined
                  ? {}
                  : {
                      maxOutputTokens:
                        compactionStep.configuration.maxOutputTokens,
                    }),
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
      baseHistoryLength: input.baseHistoryLength ?? input.history.length,
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
      ...(compactionStep.configuration.modelCapacity
        ?.effectiveContextWindowTokens === undefined
        ? {}
        : {
            capacityTokens:
              compactionStep.configuration.modelCapacity
                .effectiveContextWindowTokens,
          }),
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
        trigger: input.trigger ?? "auto",
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
  readonly documentReading: { nativePdf: boolean; images: boolean }
  readonly threadId: string
  readonly rolloutId: string
  readonly turnId: string
  readonly workspaceRoot: string
  readonly signal: AbortSignal
  readonly toolPlan: ReturnType<ToolRegistry["finalize"]>
  readonly permissionGate: PermissionGate
  readonly recordToolStarted: TurnRuntime["recordToolStarted"]
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

async function* executeToolCalls(
  input: ToolExecutionScope &
    Readonly<{
      calls: readonly ModelToolCallBlock[]
      onScheduled?: () => void
    }>,
): AsyncGenerator<
  Readonly<{
    call: ModelToolCallBlock
    item: ToolExecutionItem
    result: ToolExecutionResult
  }>
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
  for (const item of prepared) await input.recordToolStarted(item.item)
  const scheduled = prepared.map((item) => ({
    item,
    reservation: input.toolExecutionGate.reserve(
      input.toolPlan.supportsParallelToolCalls(item.invocation.name),
      input.signal,
    ),
  }))
  // Like Codex's ordered in-flight drain, commit each available result in call
  // order and drain past cancellation before propagating it to the Turn.
  const inFlight = scheduled.map(({ item, reservation }) =>
    executePreparedTool(input, item, reservation).then(
      (result) => ({
        status: "fulfilled" as const,
        value: { call: item.call, item: item.item, result },
      }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    ),
  )
  input.onScheduled?.()
  let failure: PromiseRejectedResult | undefined
  try {
    for (const pending of inFlight) {
      const outcome = await pending
      if (outcome.status === "fulfilled") yield outcome.value
      else failure ??= outcome
    }
    if (failure !== undefined) throw failure.reason
  } finally {
    // Also drain scheduled work when the consumer exits early.
    await Promise.all(inFlight)
  }
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
  modelContent: import("./tools/types.ts").ToolModelContent,
): Extract<CompletedExecutionItem, { toolCallId: string }> {
  const completed = completeToolExecution(toolPlan, started, result)
  return {
    ...completed,
    resultItemId,
    content: {
      kind: "text",
      text: modelContent.content,
      ...(modelContent.images === undefined
        ? {}
        : {
            attachments: modelContent.images.flatMap((image) =>
              image.file === undefined
                ? []
                : [
                    {
                      name:
                        image.name ??
                        image.file.path.split("/").at(-1) ??
                        "image",
                      mediaType: image.mediaType,
                      sizeBytes: image.sizeBytes,
                      detail: image.detail ?? "high",
                      file: image.file,
                    },
                  ],
            ),
          }),
    },
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
          threadId: input.threadId,
          rolloutId: input.rolloutId,
          toolCallId: prepared.call.id,
          turnId: input.turnId,
          signal: input.signal,
          documentReading: input.documentReading,
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
        const observations = toolFileObservations(result)
        for (const observation of observations) {
          input.visibleFileObservations.apply(observation)
        }
      }
      hookContext.push(...(postHook?.additionalContext ?? []))
      if (hookContext.length === 0) return result
      const contextText = `<hook_context>\n${hookContext.join("\n\n")}\n</hook_context>`
      const projectionContext = {
        workspaceRoot: input.workspaceRoot,
        rolloutId: input.rolloutId,
        toolCallId: prepared.call.id,
        ...(input.rolloutAssets === undefined
          ? {}
          : { rolloutAssets: input.rolloutAssets }),
      }
      return {
        ...result,
        content: `${result.content}\n\n${contextText}`,
        presentation: {
          async toModelContent(budget) {
            // Auxiliary hook text may consume at most half the preview, leaving
            // room for the tool's status and recovery metadata.
            const hook = await finalizeToolOutput(
              { ok: true, content: contextText, output: contextText },
              {
                maxBytes: Math.floor(budget.maxBytes / 2),
                maxLines: Math.floor(budget.maxLines / 2),
              },
              projectionContext,
              "hook-context.txt",
            )
            const body = await finalizeToolOutput(
              result,
              {
                maxBytes: budget.maxBytes - utf8Bytes(hook.content) - 1,
                maxLines: budget.maxLines - hook.content.split("\n").length,
              },
              projectionContext,
            )
            return { ...body, content: `${body.content}\n${hook.content}` }
          },
        },
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

function toolFileObservations(result: ToolExecutionResult) {
  return result.output === undefined ? [] : grantsFromToolOutput(result.output)
}

async function recordSteering(
  input: Parameters<typeof executeTurn>[0],
  steering: readonly TurnInput[],
): Promise<readonly TurnInput[]> {
  const accepted: TurnInput[] = []
  if (steering.length === 0) return accepted
  const metadata = input.runtime.snapshot().metadata
  for (const item of steering) {
    const hook =
      item.goalId === undefined
        ? await input.options.hookRunner?.run({
            event: HookEvent.UserPromptSubmit,
            payload: {
              session_id: metadata.id,
              turn_id: input.input.submissionId,
              prompt: item.content.text,
            },
            cwd: requireValue(metadata.workingDirectory, "Working directory"),
            signal: input.signal,
          })
        : undefined
    if (hook?.continue !== false) {
      await input.runtime.recordConversationItems([
        inputEnvelope(item, item.submissionId),
      ])
      accepted.push(item)
    }
    await recordHookContext(
      input.runtime,
      input.input.submissionId,
      hook?.additionalContext ?? [],
    )
  }
  return accepted
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
    ...envelope(
      turnId,
      input.goalId === undefined
        ? {
            role: "user",
            content:
              input.content.text.length === 0
                ? []
                : [{ type: "text", text: input.content.text }],
            ...(input.content.contextAttachments === undefined
              ? {}
              : { contextAttachments: input.content.contextAttachments }),
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
          }
        : {
            role: "developer",
            content: [{ type: "text", text: input.content.text }],
            context: { type: "goal", goalId: input.goalId },
          },
    ),
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

async function resolveRolloutAssetMedia(
  messages: readonly ModelMessage[],
  rolloutAssets: RolloutAssets | undefined,
  documentReading: import("./prepare-model-document.ts").DocumentReadingCapabilities,
  signal?: AbortSignal,
): Promise<readonly ModelMessage[]> {
  const { prepareModelDocuments } = await import("./prepare-model-document.ts")
  const resolved: ModelMessage[] = []
  // Project messages in order so a history full of PDFs cannot launch one
  // rasterization worker per message concurrently.
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "tool") {
      resolved.push(message)
      continue
    }
    const images = await Promise.all(
      (message.images ?? []).map(async (image) => {
        if ("data" in image && image.data !== undefined)
          return prepareModelImage(
            Buffer.from(image.data, "base64"),
            image.detail ?? "high",
          )
        if (rolloutAssets === undefined) {
          throw new Error("Rollout image storage is unavailable.")
        }
        const bytes = await rolloutAssets.read(image.file)
        if (bytes.byteLength !== image.sizeBytes) {
          throw new Error(
            "Rollout image size does not match its recorded size.",
          )
        }
        return prepareModelImage(bytes, image.detail ?? "high")
      }),
    )
    if (message.role === "user") {
      const { contextAttachments, ...user } = message
      resolved.push({
        ...user,
        content: contextAttachments?.length
          ? [
              ...user.content,
              { type: "text", text: formatInputContext(contextAttachments) },
            ]
          : user.content,
        ...(images.length === 0 ? {} : { images }),
      })
      continue
    }
    const { documents, ...tool } = message
    const projected = await prepareModelDocuments(
      documents ?? [],
      rolloutAssets,
      documentReading,
      signal,
    )
    const combinedImages = [...images, ...projected.images]
    resolved.push({
      ...tool,
      content: tool.content + projected.content,
      ...(combinedImages.length === 0 ? {} : { images: combinedImages }),
      ...(projected.documents.length === 0
        ? {}
        : { documents: projected.documents }),
    })
  }
  return resolved
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
    if (message.role !== "assistant" && pending.length > 0) flushMissing()
    completed.push(message)
    if (message.role === "assistant") {
      pending.push(
        ...message.content.flatMap((block) =>
          block.type === "tool_call"
            ? [{ id: block.id, toolKind: block.toolKind }]
            : [],
        ),
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
