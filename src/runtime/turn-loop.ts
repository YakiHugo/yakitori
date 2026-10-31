import { isDeepStrictEqual } from "node:util"
import type { ResponseItemEnvelope, TurnContextItem } from "../core/rollout.ts"
import type { Session, TurnCompletion } from "../core/session.ts"
import type { TurnInput } from "../core/session-io.ts"
import type {
  ExecutionContext,
  SessionTaskRunner,
  TurnControl,
} from "../core/session-task.ts"
import { settleTaskResources, TaskCleanupError } from "../core/session-task.ts"
import {
  inputSource,
  turnInputSubmissionMetadata,
} from "../core/turn-input-metadata.ts"
import {
  inputContentText,
  inputContentToModelMessage,
} from "../core/user-input.ts"
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
} from "../kernel/index.ts"
import type { AgentConfiguration } from "../protocol/configuration.ts"
import { answerTextParts, modelOutputItemId } from "../protocol/model-output.ts"
import type { AgentControl } from "./agent-control.ts"
import type { AgentModelOverrides } from "./agent-model-selection.ts"
import { readAssetSource } from "./asset-media.ts"
import {
  type BackgroundCompaction,
  canCompactPrefix,
  createBackgroundCompaction,
} from "./background-compaction.ts"
import {
  buildCompactionRequest,
  canRetryCompactionWithCurrentModel,
  isContextOverflowError,
  trimRemoteCompactionToolTail,
} from "./compaction.ts"
import { ModelNotConfiguredError } from "./configured-models-manager.ts"
import { observeEnvironment } from "./environment-context.ts"
import { isAbortError, ModelFailureError } from "./errors.ts"
import { HookEvent, type HookRunner } from "./hooks.ts"
import {
  createRunnerTimingPolicy,
  createSessionExecutionPolicy,
  type RunnerTimingPolicy,
  type SessionExecutionPolicy,
} from "./limits.ts"
import {
  type ModelContentBlock,
  type ModelNativeItem,
  type ModelRequest,
  type ModelResponse,
  ModelStopReason,
  type ModelStreamEvent,
  type ModelToolCallBlock,
  type ModelToolDefinition,
  type ModelUsage,
  type ModelWireApi,
  type StreamFn,
} from "./model.ts"
import { createModelAttemptTracker } from "./model-attempt.ts"
import {
  createCompactionReplacementHistory,
  retainCompactionUserMessages,
  retainRemoteCompactionMessages,
} from "./model-context.ts"
import { prepareModelMedia } from "./model-media.ts"
import type { ModelClient, ModelClientSession } from "./model-provider.ts"
import { ModelStreamCleanupError } from "./model-request.ts"
import {
  estimateHistoryTokens,
  estimateModelRequestBudget,
} from "./model-request-budget.ts"
import { prepareModelRequestPlan } from "./model-request-plan.ts"
import { modelRoutingRequirements } from "./model-routing-requirements.ts"
import { consumeModelWarmup } from "./model-warmup.ts"
import { createPermissionGate, type PermissionGate } from "./permission-gate.ts"
import type { RolloutBudget } from "./rollout-budget.ts"
import {
  type ApprovalPolicy,
  createTurnContext,
  type ResolvedStepConfiguration,
  resolveModelRequestPolicy,
  SessionConfiguration,
  toolHistoryOutputBudget,
} from "./session-configuration.ts"
import type { ThreadCollaboration } from "./thread-collaboration.ts"
import {
  completeToolItem,
  executeToolCalls,
  toolFileObservations,
} from "./tool-execution.ts"
import {
  createToolExecutionGate,
  type ToolExecutionGate,
} from "./tool-execution-gate.ts"
import { resolveWorkspaceRoot } from "./tools/path-policy.ts"
import type { ToolRegistry } from "./tools/registry.ts"
import { finalizeToolOutput } from "./tools/result-output.ts"
import { captureStepContext, type StepContext } from "./tools/spec-plan.ts"
import { createVisibleFileObservationsFromMessages } from "./tools/visible-file-observations.ts"
import { waitForTurnReadiness } from "./turn-readiness.ts"
import {
  buildWorldState,
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
// Local safety boundary: server-tool pauses must not spin forever without a
// user-visible completed answer. This is not an Anthropic product quota.
const MAX_SERVER_TOOL_PAUSES = 8
const LENGTH_CONTINUE_REMINDER =
  "Your previous answer was cut off by a generation limit. Continue exactly where it stopped, without repeating it. If a newer user message follows this reminder, answer that message instead."

type WithoutExecution<T> = T extends (
  execution: ExecutionContext,
  ...args: infer A
) => infer R
  ? (...args: A) => R
  : never

export type PreparedStepContext = Readonly<{
  agents?: AgentConfiguration
  sections?: readonly import("./world-state.ts").WorldStateSection[]
  // Only context that affects a prepared compaction belongs in this key.
  compactionKey?: import("../kernel/index.ts").JsonValue
  diagnostics?: readonly Readonly<{ path: string; message: string }>[]
  prepareInput?: (
    input: TurnInput,
    history: readonly ResponseItemEnvelope[],
    warn: (message: string) => void,
  ) => Promise<readonly Extract<ModelMessage, { role: "user" | "developer" }>[]>
}>

export type TurnLoopOptions = Readonly<{
  resolveModelRoute?(
    selection: ModelSelection,
    input: TurnInput,
    context: Readonly<{
      preferredAccount?: string
      requiresImages: boolean
      imageDetail?: "high" | "original"
      contextWindowTokens?: number
    }>,
  ): ModelSelection
  modelClient?: ModelClient
  stream?: StreamFn
  waitForConnection?: boolean
  toolRegistry: ToolRegistry
  permissionGate?: PermissionGate
  provider?: string
  model?: string
  executionPolicy?: SessionExecutionPolicy
  runtimeTiming?: RunnerTimingPolicy
  approvalPolicy?: ApprovalPolicy
  baseInstructions?: string
  // Host-scoped constraints are reattached after compaction and never inherited
  // from another Session's conversation history.
  additionalInstructions?: import("./model.ts").ModelSystemSection
  modelContextWindowTokens?: number
  modelAutoCompactTokenLimit?: number
  modelAutoCompactTokenLimitScope?: import("../kernel/index.ts").AutoCompactTokenLimitScope
  readAgentModels?: (
    target: import("../kernel/events.ts").ModelSelection,
  ) => Promise<AgentModelOverrides>
  readAgentConfiguration?: () => Promise<AgentConfiguration | undefined>
  readModelTransport?: () => ModelTransportPolicy | undefined
  prepareStepContext?: (
    input: Readonly<{ workingDirectory: string; signal: AbortSignal }>,
  ) => Promise<PreparedStepContext>
  resolveShellName?: () => Promise<string>
  now?: () => Date
  assetUrl?: (
    source: import("../core/asset-types.ts").RolloutAssetReference,
  ) => string | undefined
  rolloutAssets?: RolloutAssets
  onOperationalFailure?: TurnLoopOperationalFailureReporter
  agentControl?: AgentControl
  threadCollaboration?: ThreadCollaboration
  hookRunner?: HookRunner
  sessionHookContext?: Readonly<{
    sessionId: string
    workspaceRoot: string
    source: "startup" | "resume"
    isSubagent: boolean
  }>
}>

export type TurnLoopOperationalFailure = Readonly<{
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

export type TurnLoopOperationalFailureReporter = (
  failure: TurnLoopOperationalFailure,
) => void | Promise<void>

export function createTurnLoop(options: TurnLoopOptions): SessionTaskRunner {
  if (options.modelClient === undefined && options.stream === undefined) {
    throw new Error("Turn processor requires a model client or stream.")
  }
  const toolRegistry = options.toolRegistry
  const permissionGate = options.permissionGate ?? createPermissionGate()
  const executionPolicy =
    options.executionPolicy ?? createSessionExecutionPolicy()
  const runtimeTiming = options.runtimeTiming ?? createRunnerTimingPolicy()
  const approvalPolicy = options.approvalPolicy ?? "always_approve"
  const provider = options.provider ?? "faux"
  const model = options.model ?? "scripted"
  const toolExecutionGate = createToolExecutionGate()
  let sessionHooksStarted = false
  let startHooksPromise: Promise<void> | undefined

  const ensureSessionHooks = (
    session: Session,
    execution: ExecutionContext,
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
          session,
          execution,
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
    createTask(snapshot, input) {
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
      const modelChoice: ModelSelection = input.modelSelection ??
        snapshot.configuration?.modelChoice ??
        snapshot.configuration?.defaultTarget ?? { provider, model }
      const selection =
        options.resolveModelRoute?.(
          modelChoice,
          input,
          modelRouteContext(snapshot, input),
        ) ?? modelChoice
      const modelTransport = structuredClone(
        options.readModelTransport === undefined
          ? snapshot.configuration?.modelTransport
          : options.readModelTransport(),
      )
      const resolveConfiguration = (
        models: import("./models-manager.ts").ModelsManager | undefined,
      ) => {
        return snapshot.configuration === undefined
          ? SessionConfiguration.create(
              {
                selection,
                workspaceRoot: requireValue(
                  metadata.workingDirectory,
                  "Working directory",
                ),
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
      }
      let capturedConfiguration: SessionConfiguration | undefined
      try {
        capturedConfiguration = resolveConfiguration(
          options.modelClient?.models(selection.provider),
        )
      } catch (error) {
        if (!(error instanceof ModelNotConfiguredError)) throw error
      }
      // The provider's synchronous start captures its transport/capabilities
      // before host reloads. Discovery is a shared catalog service, not a Turn effect.
      const modelSession = options.modelClient?.startTurn(
        selection.provider,
        resolveModelRequestPolicy(modelTransport, selection.provider),
      )
      let activeStream: AsyncIterator<ModelStreamEvent> | undefined
      let closePromise: Promise<void> | undefined
      const closeModelSession = () =>
        (closePromise ??= Promise.resolve().then(() => modelSession?.close()))
      return {
        kind: input.manualCompact === true ? "compact" : "regular",
        async run(session, execution) {
          try {
            throwIfAborted(execution.signal)
            const models = modelSession?.models
            // Cancellation detaches only our wait on this Session-owned catalog;
            // discovery can safely finish for the other consumers of that service.
            await waitForTurnReadiness(
              Promise.resolve().then(() => models?.refresh()),
              execution.signal,
            )
            const configuration =
              capturedConfiguration ??
              resolveConfiguration(modelSession?.models)
            const { serviceId: _previousService, ...snapshotConfiguration } =
              configuration.snapshot
            const context = {
              turnId: input.submissionId,
              configuration: {
                ...snapshotConfiguration,
                ...(modelSession?.serviceId === undefined
                  ? {}
                  : { serviceId: modelSession.serviceId }),
                ...(options.resolveModelRoute ? { modelChoice } : {}),
              },
              selection,
            }
            await session.beginExecution(execution, context)
            await ensureSessionHooks(
              session,
              execution,
              input.submissionId,
              execution.signal,
            )
            return await executeTurn({
              session,
              execution,
              input,
              context,
              modelSession,
              control: {
                signal: execution.signal,
                takeSteering: () => session.takeSteering(execution),
                takeSteeringOrComplete: () =>
                  session.takeSteeringOrComplete(execution),
              },
              signal: execution.signal,
              toolRegistry,
              permissionGate,
              runtimeTiming,
              toolExecutionGate,
              options,
              setActiveStream(stream) {
                activeStream = stream
              },
            })
          } finally {
            await settleTaskResources(closeModelSession)
          }
        },
        async abort() {
          const results = await Promise.allSettled([
            Promise.resolve()
              .then(() => activeStream?.return?.())
              .catch((cause: unknown) => {
                reportOperationalFailure(options.onOperationalFailure, {
                  operation: "abort-model-stream",
                  cause,
                })
                throw cause
              }),
            closeModelSession().catch((cause: unknown) => {
              reportOperationalFailure(options.onOperationalFailure, {
                operation: "close-model-session",
                cause,
              })
              throw cause
            }),
          ])
          const errors = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          )
          if (errors.length > 0)
            throw new TaskCleanupError(
              new AggregateError(errors, "Failed to stop model resources."),
            )
        },
      }
    },

    prepareSteering(snapshot, input) {
      if (
        snapshot.configuration === undefined ||
        input.modelSelection === undefined
      ) {
        return undefined
      }
      const selection =
        options.resolveModelRoute?.(
          input.modelSelection,
          input,
          modelRouteContext(snapshot, input),
        ) ?? input.modelSelection
      return SessionConfiguration.restore(
        {
          ...snapshot.configuration,
          defaultTarget: selection,
          ...(options.resolveModelRoute
            ? { modelChoice: input.modelSelection }
            : {}),
        },
        options.modelClient?.models(selection.provider),
      ).snapshot
    },
  }
}

function modelRouteContext(
  snapshot: import("../core/session.ts").SessionSnapshot,
  input: TurnInput,
) {
  const requirements = modelRoutingRequirements({
    history: snapshot.context.history.map(({ item }) => item),
    attachments: input.content.attachments,
    ...(snapshot.configuration === undefined
      ? {}
      : { configuration: snapshot.configuration }),
  })
  return {
    ...requirements,
    requiresImages: requirements.inputModalities?.includes("image") ?? false,
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
  readonly session: Session
  readonly execution: ExecutionContext
  readonly modelSession: ModelClientSession | undefined
  readonly input: TurnInput
  readonly context: TurnContextItem
  readonly control: TurnControl
  readonly signal: AbortSignal
  readonly toolRegistry: ToolRegistry
  readonly permissionGate: PermissionGate
  readonly runtimeTiming: RunnerTimingPolicy
  readonly toolExecutionGate: ToolExecutionGate
  readonly options: TurnLoopOptions
  readonly setActiveStream: (
    stream: AsyncIterator<ModelStreamEvent> | undefined,
  ) => void
}): Promise<TurnCompletion | undefined> {
  const processorStartedAt = Date.now()
  let admittedAt: number | undefined
  const metadata = input.session.executionSnapshot(input.execution).metadata
  const modelSession = input.modelSession
  try {
    const models = modelSession?.models
    await waitForTurnReadiness(
      Promise.resolve().then(() => models?.refresh()),
      input.signal,
    )
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
      input.session.emitWarning(
        input.execution,
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
        inputSource(input.input) === "human"
          ? await input.options.hookRunner?.run({
              event: HookEvent.UserPromptSubmit,
              payload: {
                session_id: metadata.id,
                turn_id: input.input.submissionId,
                prompt: inputContentText(input.input.content),
              },
              cwd: requireValue(metadata.workingDirectory, "Working directory"),
              signal: input.signal,
            })
          : undefined
      if (promptHook?.continue === false) {
        await recordHookContext(
          input.session,
          input.execution,
          input.input.submissionId,
          promptHook.additionalContext ?? [],
        )
        return false
      }
      await input.session.recordInitialInput(input.execution)
      admittedAt = Date.now()
      await recordHookContext(
        input.session,
        input.execution,
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
  const metadata = input.session.executionSnapshot(input.execution).metadata
  const latency: { -readonly [K in keyof TurnLatency]: TurnLatency[K] } = {
    setupMs: Math.max(0, Date.now() - timing.startedAt),
    backgroundCompactionMs: 0,
    backgroundCompactionOverlapMs: 0,
    backgroundCompactionsApplied: 0,
    backgroundCompactionsDiscarded: 0,
  }
  const elapsed = () => Math.max(0, Date.now() - timing.startedAt)
  const usages: ModelUsage[] = []
  let serverToolPauses = 0
  let modelCalls = 0
  let compactionModelCalls = 0
  let warmupStarted = false
  let warmupModelCalls = 0
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
    input.session.recordTurnMetrics(input.execution, {
      modelCalls: modelCalls + compactionModelCalls + warmupModelCalls,
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
  const pendingContextInputs = [input.input]
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
    let warmupStartedAt: number | undefined
    let warmupEndedAt: number | undefined
    let warmupController: AbortController | undefined
    let warmupWork: Promise<PromiseSettledResult<void>> | undefined
    try {
      throwIfAborted(input.signal)
      if (!continuingAnswer) answerItemIds.length = 0
      const budget = input.options.agentControl?.rolloutBudget
      budget?.assertAvailable()
      const reminder = budget?.pendingReminder(metadata.id)
      if (reminder !== undefined) {
        await input.session.recordConversationItems(input.execution, [
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
      const preparedContext =
        (await input.options.prepareStepContext?.({
          workingDirectory: turn.requestSettings.workspaceRoot,
          signal: input.signal,
        })) ?? {}
      const readModelCatalog = async (
        target: import("../kernel/events.ts").ModelSelection,
      ): Promise<AgentModelOverrides> => {
        if (input.options.readAgentModels !== undefined)
          return waitForTurnReadiness(
            input.options.readAgentModels(target),
            input.signal,
          )
        const models =
          input.options.modelClient?.models(target.provider) ??
          modelSession?.models
        return {
          current: target,
          models:
            models === undefined
              ? []
              : (
                  await waitForTurnReadiness(models.listModels(), input.signal)
                ).map((model) => ({ ...model, provider: target.provider })),
          resolve(selection) {
            models?.validate(selection)
            return selection
          },
        }
      }
      const enabledTools = new Set(
        input.toolRegistry
          .trustedToolNames()
          .filter((name) => turn.requestSettings.enabledTools.includes(name)),
      )
      const needsThreadModels =
        input.options.threadCollaboration !== undefined &&
        enabledTools.has("create_thread")
      const needsAgentModels =
        input.options.agentControl !== undefined &&
        enabledTools.has("spawn_agent") &&
        preparedContext.agents?.exposeModelOverrides === true
      const modelCatalog =
        needsThreadModels || needsAgentModels
          ? await readModelCatalog(turn.requestSettings.target)
          : undefined
      step = captureStepContext({
        ...(!needsThreadModels || modelCatalog === undefined
          ? {}
          : { threadModelOverrides: modelCatalog }),
        ...(!needsAgentModels || modelCatalog === undefined
          ? {}
          : { agentModelOverrides: modelCatalog }),
        registry: input.toolRegistry,
        configuration: turn.requestSettings,
        ...(wireApi === undefined ? {} : { wireApi }),
        nativePdf,
        ...(modelSession?.toolCapabilities === undefined
          ? {}
          : { toolCapabilities: modelSession.toolCapabilities }),
      })
      const configuration = step.configuration
      const toolPlan = step.toolRouter
      const workspaceRoot = await resolveWorkspaceRoot(
        configuration.workspaceRoot,
      )
      const currentDiagnostics = new Set<string>()
      for (const diagnostic of preparedContext.diagnostics ?? []) {
        const key = JSON.stringify(diagnostic)
        if (currentDiagnostics.has(key)) continue
        currentDiagnostics.add(key)
        if (previousDiagnostics.has(key)) continue
        const message = `${diagnostic.path}: ${diagnostic.message}`
        input.session.emitWarning(input.execution, message)
        reportOperationalFailure(input.options.onOperationalFailure, {
          operation: "load-instructions",
          cause: new Error(message),
        })
      }
      previousDiagnostics = currentDiagnostics
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
      const beforeStep = input.session.executionSnapshot(input.execution)
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
      const worldState = buildWorldState({
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
        ...(preparedContext.sections === undefined
          ? {}
          : { extensionSections: preparedContext.sections }),
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
        preparedContext.compactionKey,
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
          const applied = await input.session.checkpointHistory(
            input.execution,
            {
              replacement: candidate.replacement,
              summary: candidate.summary,
              baseHistoryLength: candidate.prefix.length,
              expectedPrefix: candidate.prefix,
            },
          )
          if (applied) {
            latency.backgroundCompactionsApplied += 1
            const item: StartedExecutionItem = {
              type: "context_compaction",
              itemId: createCompactionId(),
            }
            input.session.emitItemStarted(input.execution, item)
            await input.session.recordItemCompletions(input.execution, [
              completeCompactionItem(item, "completed"),
            ])
            const history = input.session.executionSnapshot(input.execution)
              .context.history
            const tokens = estimateModelRequestBudget({
              target: step.target,
              system: [configuration.baseInstructions],
              messages: history.map(({ item }) => item),
              tools: step.toolRouter.modelDefinitions,
              toolWireProtocol: step.toolWireProtocol,
            }).estimatedInputTokens
            await input.session.recordContextTokens(input.execution, {
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
        await input.session.recordModelContext(input.execution, {
          provider: step.target.provider,
          model: step.target.model,
          ...(step.modelInfo.compactionHash === undefined
            ? {}
            : { compactionHash: step.modelInfo.compactionHash }),
        })
        const compacted = await compactLiveHistory({
          session: input.session,
          execution: input.execution,
          turnId: input.input.submissionId,
          step,
          worldState,
          history: compactionHistory,
          baseHistoryLength: beforeStep.context.history.length,
          stream,
          remoteCompaction,
          wireApi,
          signal: input.signal,
          rolloutAssets: input.options.rolloutAssets,
          assetUrl: input.options.assetUrl,
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
        input.session.recordTurnMetrics(input.execution, {
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
        (block) =>
          block.provider !== step?.target.provider ||
          block.model !== step.target.model,
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
          throw new ModelFailureError({
            kind: "invalid_request",
            stage: "request_build",
            provider: step.target.provider,
            wireApi: wireApi ?? "unknown",
            providerCode: "history_incompatible",
            message: `Native checkpoint continuation requires ${sourceSelection.provider}/${sourceSelection.model}. Restore its provider connection and model configuration before continuing.`,
          })
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
          await waitForTurnReadiness(
            Promise.resolve().then(() => sourceModels?.refresh()),
            input.signal,
          )
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
              throw new ModelFailureError(
                {
                  kind: "invalid_request",
                  stage: "request_build",
                  provider: step.target.provider,
                  wireApi: wireApi ?? "unknown",
                  providerCode: "history_incompatible",
                  message: `Native checkpoint continuation requires ${sourceSelection.provider}/${sourceSelection.model}. Restore its provider connection and model configuration before continuing.`,
                },
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
                ...(sourceSession?.toolCapabilities === undefined
                  ? {}
                  : { toolCapabilities: sourceSession.toolCapabilities }),
              })
              try {
                await compactLiveHistory({
                  session: input.session,
                  execution: input.execution,
                  turnId: input.input.submissionId,
                  step: sourceStep,
                  worldState,
                  history: compactionHistory,
                  injectWorldState: modelCalls !== 0,
                  stream: sourceSession?.stream ?? stream,
                  wireApi: sourceSession?.wireApi ?? wireApi,
                  // A different model/account needs a portable text summary,
                  // rather than another checkpoint encrypted for its owner.
                  remoteCompaction:
                    sourceSelection.provider === step.target.provider &&
                    sourceSelection.model === step.target.model &&
                    (sourceSession?.remoteCompaction ?? false),
                  ...(sourceSelection.provider === step.target.provider &&
                  remoteCompaction === "codex_remote" &&
                  sourceSelection.model !== step.target.model &&
                  nativeCheckpoints.length === 0
                    ? { fallback: { step, stream } }
                    : {}),
                  signal: input.signal,
                  rolloutAssets: input.options.rolloutAssets,
                  assetUrl: input.options.assetUrl,
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
                await settleTaskResources(() => sourceStep.toolRouter.release())
              }
              compactedAtModelCall = modelCalls
              continue
            }
          }
        } finally {
          if (sourceSession !== modelSession)
            await settleTaskResources(() => sourceSession?.close())
        }
      }
      if (
        (admission.shouldCompact || continuationNeedsCompaction) &&
        compactedAtModelCall !== modelCalls
      ) {
        const compacted = await compactLiveHistory({
          session: input.session,
          execution: input.execution,
          turnId: input.input.submissionId,
          step,
          worldState,
          history: compactionHistory,
          injectWorldState: modelCalls !== 0,
          stream,
          remoteCompaction,
          wireApi,
          signal: input.signal,
          rolloutAssets: input.options.rolloutAssets,
          assetUrl: input.options.assetUrl,
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
      pendingContextInputs.push(...acceptedSteering)
      if (acceptedSteering.length > 0) {
        answerItemIds.length = 0
        continuingAnswer = false
        continuationReminderNeeded = true
        continuationNeedsCompaction = false
      }
      if (continuingAnswer && continuationReminderNeeded) {
        await input.session.recordConversationItems(input.execution, [
          envelope(input.input.submissionId, {
            role: "developer",
            content: [{ type: "text", text: LENGTH_CONTINUE_REMINDER }],
          }),
        ])
        continuationReminderNeeded = false
      }
      for (const submitted of pendingContextInputs.splice(0)) {
        const messages =
          (await preparedContext.prepareInput?.(
            submitted,
            input.session.executionSnapshot(input.execution).context.history,
            (message) => input.session.emitWarning(input.execution, message),
          )) ?? []
        if (messages.length > 0)
          await input.session.recordConversationItems(
            input.execution,
            messages.map((message) =>
              envelope(submitted.submissionId, message),
            ),
          )
      }
      const worldDiff = diffWorldState(
        beforeStep.context.worldStateBaseline,
        worldState,
      )
      if (worldDiff !== undefined) {
        await input.session.recordWorldStateUpdate(
          input.execution,
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

      const stablePrefix = input.session.executionSnapshot(input.execution)
        .context.history
      const durableMessages = completeToolCallHistory(
        stablePrefix.map(({ item }) => item),
      )
      const messages = durableMessages
      let visibleFileObservations =
        createVisibleFileObservationsFromMessages(messages)
      let requestHistoryAnchorItemId = input.session
        .executionSnapshot(input.execution)
        .context.history.at(-1)?.id
      const rawRequest: ModelRequest = {
        waitForConnection:
          input.options.waitForConnection === true &&
          (inputSource(input.input) === "human" ||
            input.input.purpose === "continuation"),
        assets: {
          read: (source, signal) =>
            readAssetSource(source, input.options.rolloutAssets, signal),
          ...(input.options.assetUrl === undefined
            ? {}
            : { url: input.options.assetUrl }),
        },
        streamOutputItems: true,
        async rebuildMessagesAfterOutput() {
          // Codex rebuilds retry input from history after draining in-flight
          // tools. Replaying the original prompt would hide completed effects.
          const outcomes = await Promise.all(pendingTools)
          for (const outcome of outcomes) {
            if (outcome.status === "rejected") throw outcome.reason
          }
          throwIfAborted(input.signal)
          const currentHistory = input.session.executionSnapshot(
            input.execution,
          ).context.history
          requestHistoryAnchorItemId = currentHistory.at(-1)?.id
          const history = completeToolCallHistory(
            currentHistory.map(({ item }) => item),
          )
          // The retry can now act on newly visible reads. Reads completed
          // during the previous attempt did not authorize that attempt's tools.
          visibleFileObservations =
            createVisibleFileObservationsFromMessages(history)
          return prepareModelMedia(history, {
            target: executionStep.target,
            imageCapabilities: executionStep.modelInfo,
            rolloutAssets: input.options.rolloutAssets,
            documentReading: executionStep.documentReading,
            userDocumentReading: executionStep.userDocumentReading,
            signal: input.signal,
          })
        },
        target: step.target,
        cacheKey: configuration.promptCacheKey,
        system: [
          configuration.baseInstructions,
          ...(input.options.additionalInstructions === undefined
            ? []
            : [input.options.additionalInstructions]),
        ],
        messages: await prepareModelMedia(messages, {
          target: step.target,
          imageCapabilities: step.modelInfo,
          rolloutAssets: input.options.rolloutAssets,
          documentReading: step.documentReading,
          userDocumentReading: step.userDocumentReading,
          signal: input.signal,
        }),
        tools: toolPlan.modelDefinitions,
        toolWireProtocol: step.toolWireProtocol,
        ...(configuration.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: configuration.maxOutputTokens }),
        signal: input.signal,
      }
      const plan = prepareModelRequestPlan(rawRequest, {
        model: step.modelInfo,
        wireApi: wireApi ?? "unknown",
        ...(modelSession?.toolCapabilities === undefined
          ? {}
          : { toolCapabilities: modelSession.toolCapabilities }),
        ...(configuration.modelCapacity?.inputContextLimitTokens === undefined
          ? {}
          : {
              inputLimitTokens:
                configuration.modelCapacity.inputContextLimitTokens,
            }),
      })
      const request = plan.request
      if (modelCalls === 0) {
        await input.session.recordModelContext(input.execution, {
          provider: step.target.provider,
          model: step.target.model,
          ...(step.modelInfo.compactionHash === undefined
            ? {}
            : { compactionHash: step.modelInfo.compactionHash }),
        })
      }
      let responseItemId = `message_${globalThis.crypto.randomUUID()}`
      const estimatedInputTokens = plan.budget.estimatedInputTokens
      // Recovery must also fit newly injected instructions and tool schemas.
      // Fresh user requests retain provider admission; a continuation must not
      // repeatedly spend its budget on a request we already know cannot fit.
      if (continuingAnswer && plan.inputBudgetExceeded) {
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
      input.session.recordRequestStartedAt(input.execution, modelStartedAt)
      let firstTokenAt: number | undefined
      const executionStep = step
      const callIndex = modelCalls + 1
      const attempt = createModelAttemptTracker(
        (attempt) => input.session.recordModelAttempt(input.execution, attempt),
        executionStep.target,
        wireApi,
      )
      let scheduled = Promise.resolve()
      let drained = Promise.resolve()
      const dispatchedCallIds = new Set<string>()
      const startCalls = (calls: readonly ModelToolCallBlock[]) => {
        if (calls.length === 0) return
        const modelCallId = attempt.origin.callId
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
                await input.session.recordToolStarted(input.execution, {
                  ...item,
                  modelCallId,
                })
              },
              recordNestedToolResult: (completion) =>
                input.session.recordNestedToolResult(input.execution, {
                  ...completion,
                  modelCallId,
                }),
              publishPermissionEvent: (event) =>
                input.session.emitPermissionEvent(input.execution, event),
              permissionTimeoutMs: input.runtimeTiming.permissionWaitTimeoutMs,
              approvalPolicy: configuration.approvalPolicy,
              rolloutAssets: input.options.rolloutAssets,
              visibleFileObservations,
              toolExecutionGate: input.toolExecutionGate,
              reportOperationalFailure: (cause) =>
                reportOperationalFailure(input.options.onOperationalFailure, {
                  operation: "execute-tool",
                  cause,
                }),
              ...(input.options.hookRunner === undefined
                ? {}
                : { hookRunner: input.options.hookRunner }),
              ...(input.options.agentControl === undefined
                ? {}
                : {
                    agentControl: input.options.agentControl.bind(
                      metadata.id,
                      executionStep.target,
                      async () => {
                        const agents =
                          input.options.readAgentConfiguration === undefined
                            ? preparedContext.agents
                            : await input.options.readAgentConfiguration()
                        return agents?.exposeModelOverrides === true
                          ? readModelCatalog(executionStep.target)
                          : undefined
                      },
                    ),
                  }),
              ...(input.options.threadCollaboration === undefined
                ? {}
                : {
                    threadCollaboration: input.options.threadCollaboration.bind(
                      metadata.id,
                      {
                        target: executionStep.target,
                        signal: input.signal,
                        readModels: () =>
                          readModelCatalog(executionStep.target),
                        ...(input.options.modelClient === undefined
                          ? {}
                          : {
                              models: input.options.modelClient.models.bind(
                                input.options.modelClient,
                              ),
                            }),
                      },
                    ),
                  }),
            })
            toolCalls += calls.length
            for await (const { call, item, result } of results) {
              await previousResults
              const {
                toolContentTruncated,
                toolContentBlockCount,
                ...modelContent
              } = await finalizeToolOutput(
                result,
                {
                  maxBytes: Number.MAX_SAFE_INTEGER,
                  maxLines: Number.MAX_SAFE_INTEGER,
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
              const resultItem = {
                ...envelope(input.input.submissionId, {
                  role: "tool",
                  toolCallId: call.id,
                  ...modelContent,
                  ...(!result.ok ? { isError: true } : {}),
                  ...(call.toolKind === "tool_search"
                    ? {
                        toolSearch: {
                          // Search is host-owned; its output is the executed selection,
                          // including any PreToolUse rewrite.
                          tools: result.ok
                            ? (
                                result.output as {
                                  tools: readonly ModelToolDefinition[]
                                }
                              ).tools
                            : [],
                        },
                      }
                    : {}),
                  ...(fileObservations.length === 0
                    ? {}
                    : { fileObservations }),
                }),
                historyOutputBudget: toolHistoryOutputBudget(
                  executionStep.configuration,
                ),
                ...(toolContentBlockCount === undefined
                  ? {}
                  : { toolContentBlockCount }),
              }
              await input.session.recordToolResult(
                input.execution,
                resultItem,
                completeToolItem(
                  toolPlan,
                  { ...item, modelCallId },
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
      const committedNative: ModelNativeItem[] = []
      const committedCallIds = new Set<string>()
      let committedBytes = 0
      if (!continuingAnswer) answerItemIds.length = 0
      let answerStartIndex = answerItemIds.length
      let explicitAnswer = false
      const recordOutput = async (
        content: readonly ModelContentBlock[],
        itemId: string,
        providerRequestId?: string,
        native?: readonly ModelNativeItem[],
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
          {
            role: "assistant",
            content,
            response: attempt.origin,
            ...(native === undefined ? {} : { native }),
          },
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
        await input.session.recordConversationItems(input.execution, [item])
        await input.session.recordItemCompletions(
          input.execution,
          completedResponseItems(item),
        )
        if (content.some((block) => block.type === "tool_call")) {
          answerItemIds.length = 0
          answerStartIndex = 0
          continuationReminderNeeded = true
        } else {
          const text = content
            .filter((block) => block.type === "text")
            .filter((block) => block.text.length > 0)
          const hasFinal = text.some(
            (block) => block.purpose === "final_answer",
          )
          if (hasFinal && !explicitAnswer) {
            answerItemIds.length = answerStartIndex
            explicitAnswer = true
          }
          if (answerTextParts(text).length > 0 && (!explicitAnswer || hasFinal))
            answerItemIds.push(item.id)
        }
      }
      const response = await consumeModelStream({
        request,
        stream,
        attempt,
        async onOutputItem(content, itemId, native) {
          throwIfAborted(input.signal)
          committedBytes +=
            utf8Bytes(JSON.stringify(content)) +
            (native === undefined ? 0 : utf8Bytes(JSON.stringify(native)))
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
          await recordOutput(content, itemId, undefined, native)
          committedContent.push(...content)
          committedNative.push(...(native ?? []))
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
          input.session.emitModelStream(input.execution, event)
        },
        emitWarning: (message, diagnostic) =>
          input.session.emitWarning(input.execution, message, diagnostic),
        assistantResponseBytes: step.executionPolicy.assistantResponseBytes,
        onOperationalFailure: input.options.onOperationalFailure,
        onRetry(committed) {
          input.session.invalidateRequestStartedAt(input.execution)
          if (committed) {
            // A transport retry starts another attempt, not a Length answer
            // fragment. Earlier Length continuations still belong to the answer.
            answerItemIds.length = Math.min(
              answerItemIds.length,
              answerStartIndex,
            )
            committedContent.length = 0
            committedNative.length = 0
            committedBytes = 0
            sampledContext = undefined
            explicitAnswer = false
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
            await input.session.checkpointUsage(input.execution, aggregate)
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
        response.stopReason !== ModelStopReason.ContentFilter &&
        response.stopReason !== ModelStopReason.PauseTurn
      ) {
        throw new Error("Model response has an unsupported stop reason.")
      }
      // Terminal output includes completed items; never record or execute them twice.
      if (
        !isDeepStrictEqual(
          response.content.slice(0, committedContent.length),
          committedContent,
        )
      ) {
        throw new Error("Terminal model output disagrees with committed items.")
      }
      const remaining = response.content.slice(committedContent.length)
      const remainingNative = response.native?.slice(committedNative.length)
      if (
        !isDeepStrictEqual(
          response.native?.slice(0, committedNative.length) ?? [],
          committedNative,
        )
      )
        throw new Error(
          "Terminal native output disagrees with committed items.",
        )
      if (remaining.length > 0 || (remainingNative?.length ?? 0) > 0)
        await recordOutput(
          remaining,
          responseItemId,
          response.providerRequestId,
          remainingNative,
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
          : input.session
              .executionSnapshot(input.execution)
              .context.history.at(-1)?.id
        if (historyAnchorItemId !== undefined) {
          await input.session.recordContextTokens(input.execution, {
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
      const afterResponse = input.session.executionSnapshot(
        input.execution,
      ).context
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
            const messages = await prepareModelMedia(
              prefix.map(({ item }) => item),
              {
                target: step.target,
                imageCapabilities: step.modelInfo,
                rolloutAssets: input.options.rolloutAssets,
                documentReading: step.documentReading,
                userDocumentReading: step.userDocumentReading,
                signal,
              },
            )
            requestStartedAt = Date.now()
            const result = await consumeModelStream({
              request: buildCompactionRequest({
                assets: {
                  read: (source, signal) =>
                    readAssetSource(
                      source,
                      input.options.rolloutAssets,
                      signal,
                    ),
                  ...(input.options.assetUrl === undefined
                    ? {}
                    : { url: input.options.assetUrl }),
                },
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
              recordModelAttempt: (attempt) =>
                input.session.recordModelAttempt(input.execution, attempt),
              ...(wireApi === undefined ? {} : { wireApi }),
              threadId: metadata.id,
              turnId: input.input.submissionId,
              assistantResponseBytes:
                step.executionPolicy.assistantResponseBytes,
              emitWarning: (message, diagnostic) =>
                input.session.emitWarning(input.execution, message, diagnostic),
              onOperationalFailure: input.options.onOperationalFailure,
              onFirstToken() {
                firstTokenAt ??= Date.now()
              },
              async onUsage(usage) {
                usages.push(usage)
                const aggregate = aggregateTokenUsage(usages)
                if (aggregate !== undefined)
                  await input.session.checkpointUsage(
                    input.execution,
                    aggregate,
                  )
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
            if (error instanceof TaskCleanupError)
              backgroundFailure = { cause: error }
            else if (!signal.aborted && !isAbortError(error)) {
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
      if (
        calls.length > 0 &&
        pendingToolBatches > 0 &&
        backgroundWork === undefined &&
        !warmupStarted &&
        modelSession?.warmup !== undefined
      ) {
        warmupStarted = true
        warmupModelCalls += 1
        const startedAt = Date.now()
        warmupStartedAt = startedAt
        warmupController = new AbortController()
        // Warm only a known, complete prefix while tools drain. The provider
        // requires the next request to extend this exact prompt and tool set;
        // compaction, changed settings or an unfinished warmup use full HTTP.
        warmupWork = consumeModelWarmup({
          stream: modelSession.warmup,
          request: {
            ...request,
            signal: AbortSignal.any([input.signal, warmupController.signal]),
          },
          async onUsage(usage) {
            usages.push(usage)
            const aggregate = aggregateTokenUsage(usages)
            if (aggregate !== undefined)
              await input.session.checkpointUsage(input.execution, aggregate)
            budget?.recordUsage(usage)
          },
        })
          .finally(() => {
            warmupEndedAt = Date.now()
            const duration = Math.max(0, warmupEndedAt - startedAt)
            modelDurationMs += duration
            latency.warmupMs = (latency.warmupMs ?? 0) + duration
          })
          .then(
            () => ({ status: "fulfilled" as const, value: undefined }),
            (reason: unknown) => ({ status: "rejected" as const, reason }),
          )
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
      // A speculative preparation must never delay the next request. Abort
      // pending I/O immediately; completed warmups retain their cached prefix.
      warmupController?.abort()
      const warmed = await warmupWork
      if (warmed?.status === "rejected") throw warmed.reason
      if (warmupStartedAt !== undefined && warmupEndedAt !== undefined)
        latency.warmupOverlapMs =
          (latency.warmupOverlapMs ?? 0) +
          Math.max(0, Math.min(toolsDrainedAt, warmupEndedAt) - warmupStartedAt)

      if (response.stopReason === ModelStopReason.PauseTurn) {
        if (response.native === undefined || response.native.length === 0)
          throw new Error(
            "A server tool pause requires native continuation history.",
          )
        serverToolPauses += 1
        if (serverToolPauses > MAX_SERVER_TOOL_PAUSES)
          throw new Error(
            "Server tools repeatedly paused without completing the answer.",
          )
        continue
      }
      serverToolPauses = 0
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
          input.session.emitWarning(
            input.execution,
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

      // Stop hooks may await or request another step. Keep admission open
      // until their decision and context writes are complete, then atomically
      // consume any steering that arrived during the hook or finish the Turn.
      pendingSteering.push(...input.control.takeSteering())
      if (pendingSteering.length > 0) continue
      if (reason === undefined) {
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
          await recordHookContext(
            input.session,
            input.execution,
            input.input.submissionId,
            [
              ...(stopHook.additionalContext ?? []),
              stopHook.reason ?? "Stop hook requested another model step.",
            ],
          )
          answerItemIds.length = 0
          continuationReminderNeeded = true
          continue
        }
        await recordHookContext(
          input.session,
          input.execution,
          input.input.submissionId,
          stopHook?.additionalContext ?? [],
        )
      }
      const completion = input.control.takeSteeringOrComplete()
      if (completion.type === "steering") {
        pendingSteering.push(...completion.inputs)
        continue
      }
      return finish(reason)
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
          await input.session.recordContextTokens(input.execution, {
            activeContextTokens: capacity,
            capacityTokens: capacity,
            historyAnchorItemId:
              input.session
                .executionSnapshot(input.execution)
                .context.history.at(-1)?.id ?? input.input.submissionId,
            provider: step.target.provider,
            model: step.target.model,
          })
      }
      throw error
    } finally {
      backgroundAbort.abort()
      warmupController?.abort()
      await backgroundWork
      await warmupWork
      const stoppedTools = await Promise.all(pendingTools)
      await settleTaskResources(async () => {
        await step?.toolRouter.release()
        if (backgroundFailure?.cause instanceof TaskCleanupError)
          throw backgroundFailure.cause
        const failedStop = stoppedTools.find(
          (result) =>
            result.status === "rejected" &&
            result.reason instanceof TaskCleanupError,
        )
        if (failedStop?.status === "rejected") throw failedStop.reason
      })
    }
  }
}

async function consumeModelStream(input: {
  readonly request: ModelRequest
  readonly stream: StreamFn
  readonly threadId: string
  readonly turnId: string
  readonly itemId?: string
  readonly emitModelStream?: WithoutExecution<Session["emitModelStream"]>
  readonly emitWarning?: WithoutExecution<Session["emitWarning"]>
  readonly assistantResponseBytes: number
  readonly onOperationalFailure: TurnLoopOperationalFailureReporter | undefined
  readonly onOutputItem?: (
    content: readonly ModelContentBlock[],
    itemId: string,
    native?: readonly ModelNativeItem[],
  ) => Promise<void>
  readonly attempt?: ReturnType<typeof createModelAttemptTracker>
  readonly recordModelAttempt?: (
    attempt: import("../core/rollout.ts").ModelAttemptRecord,
  ) => Promise<void>
  readonly wireApi?: ModelWireApi | undefined
  readonly onFirstToken?: () => void
  readonly onRetry?: (committedOutput: boolean, nextAttempt: number) => void
  readonly onUsage: (usage: ModelUsage) => void | Promise<void>
  readonly setActiveStream: (
    stream: AsyncIterator<ModelStreamEvent> | undefined,
  ) => void
}): Promise<ModelResponse> {
  const attempt =
    input.attempt ??
    (input.recordModelAttempt === undefined
      ? undefined
      : createModelAttemptTracker(
          input.recordModelAttempt,
          input.request.target,
          input.wireApi,
        ))
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
        await attempt?.end(event)
        attempt?.retry(event.nextAttempt)
        input.onRetry?.(event.committedOutput === true, event.nextAttempt)
        streamedBytes.assistant = 0
        streamedBytes.reasoning = 0
        trailingHighSurrogate.assistant = ""
        trailingHighSurrogate.reasoning = ""
        if (event.usage !== undefined) await input.onUsage(event.usage)
        input.emitWarning?.(
          event.maxAttempts === undefined
            ? `Waiting for network; reconnecting in ${String(Math.round(event.delayMs / 1000))} seconds.`
            : `Model request failed (${event.failure.kind}); retrying attempt ${String(event.nextAttempt)} of ${String(event.maxAttempts)} in ${String(Math.round(event.delayMs))} ms.`,
          {
            message: event.failure.message,
            code: "model.retry",
            details: {
              ...(discardedResponseItemIds.length === 0
                ? {}
                : { discardedResponseItemIds }),
              attempt: event.attempt,
              nextAttempt: event.nextAttempt,
              ...(event.maxAttempts === undefined
                ? {}
                : { maxAttempts: event.maxAttempts }),
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
        await attempt?.end(event)
        if (event.usage !== undefined) await input.onUsage(event.usage)
        if (input.request.signal?.aborted) throw abortError()
        throw new Error("Model provider cancelled without caller cancellation.")
      }
      if (event.type === "failure") {
        await attempt?.end(event)
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
        await input.onOutputItem(event.content, itemId, event.native)
        const indexes = { assistant: 0, reasoning: 0 }
        for (const block of event.content) {
          if (block.type !== "text" && block.type !== "reasoning") continue
          const kind = block.type === "text" ? "assistant" : "reasoning"
          provisionalItems.delete(
            modelOutputItemId(itemId, kind, indexes[kind]++),
          )
        }
        continue
      }
      if (event.type !== "response") {
        if (input.request.compaction === "codex_remote") continue
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
        const parentItemId = displayItemId(event.itemId)
        if (parentItemId !== undefined) {
          const itemId = modelOutputItemId(parentItemId, kind, event.partIndex)
          provisionalItems.add(itemId)
          input.emitModelStream?.({
            itemId,
            kind,
            delta: event.text,
            ...(attempt === undefined
              ? {}
              : {
                  source: {
                    callId: attempt.origin.callId,
                    itemId: parentItemId,
                  },
                }),
            ...(event.type === "delta" && event.purpose !== undefined
              ? { purpose: event.purpose }
              : {}),
            ...(event.type === "reasoning_delta" &&
            event.representation !== undefined
              ? { representation: event.representation }
              : {}),
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
    if (terminal === undefined)
      throw new Error("Model stream ended without a terminal response.")
    const metadataBytes =
      terminal.nativeMetadata === undefined
        ? 0
        : utf8Bytes(JSON.stringify(terminal.nativeMetadata))
    // Compaction has its own summary/window admission. In particular, an
    // encrypted checkpoint can represent existing context larger than a new
    // assistant answer. Its envelope still obeys the diagnostic safety bound.
    if (
      metadataBytes > input.assistantResponseBytes ||
      (input.request.compaction === undefined &&
        utf8Bytes(JSON.stringify(terminal.content)) +
          (terminal.native === undefined
            ? 0
            : utf8Bytes(JSON.stringify(terminal.native))) +
          metadataBytes >
          input.assistantResponseBytes)
    ) {
      throw new Error("Assistant response exceeded the configured byte limit.")
    }
    await attempt?.end({ type: "response", response: terminal })
  } catch (error) {
    await attempt?.fail(error, input.request.signal?.aborted === true)
    if (error instanceof ModelStreamCleanupError)
      throw new TaskCleanupError(error)
    if (error instanceof TaskCleanupError) throw error
    if (input.request.signal?.aborted) {
      throw abortError()
    }
    throw error
  } finally {
    input.setActiveStream(undefined)
    if (!exhausted) {
      await settleTaskResources(async () => {
        try {
          await iterator.return?.()
        } catch (error) {
          reportOperationalFailure(input.onOperationalFailure, {
            operation: "close-model-stream",
            cause: error,
          })
          throw error
        }
      })
    }
  }
  if (terminal === undefined) {
    throw new Error("Model stream ended without a terminal response.")
  }
  return {
    ...terminal,
    ...(attempt === undefined ? {} : { origin: attempt.origin }),
  }
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
    wireApi?: ModelWireApi | undefined
    remoteCompaction?: ModelClientSession["remoteCompaction"]
    fallback?: Readonly<{ step: StepContext; stream: StreamFn }>
    injectWorldState?: boolean
    session: Session
    execution: ExecutionContext
    turnId: string
    step: StepContext
    worldState: WorldState
    history: readonly ResponseItemEnvelope[]
    baseHistoryLength?: number
    stream: StreamFn
    signal: AbortSignal
    rolloutAssets: RolloutAssets | undefined
    assetUrl?: TurnLoopOptions["assetUrl"]
    usages: ModelUsage[]
    onModelTiming: (
      durationMs: number,
      timeToFirstTokenMs: number | undefined,
    ) => void
    rolloutBudget: RolloutBudget | undefined
    hookRunner?: HookRunner
    onOperationalFailure: TurnLoopOperationalFailureReporter | undefined
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
      session_id: input.session.executionSnapshot(input.execution).metadata.id,
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
    input.session,
    input.execution,
    input.turnId,
    preHook?.additionalContext ?? [],
  )

  const compactionItem: StartedExecutionItem = {
    type: "context_compaction",
    itemId: createCompactionId(),
  }
  input.session.emitItemStarted(input.execution, compactionItem)
  let completed = false

  try {
    const compact = async (request: ModelRequest) => {
      const modelStartedAt = Date.now()
      input.session.recordRequestStartedAt(input.execution, modelStartedAt)
      let firstTokenAt: number | undefined
      const response = await consumeModelStream({
        request,
        stream: compactionStream,
        recordModelAttempt: (attempt) =>
          input.session.recordModelAttempt(input.execution, attempt),
        wireApi: input.wireApi,
        threadId: input.session.executionSnapshot(input.execution).metadata.id,
        turnId: input.turnId,
        assistantResponseBytes:
          compactionStep.executionPolicy.assistantResponseBytes,
        emitWarning: (message, diagnostic) =>
          input.session.emitWarning(input.execution, message, diagnostic),
        onOperationalFailure: input.onOperationalFailure,
        onRetry: () =>
          input.session.invalidateRequestStartedAt(input.execution),
        onFirstToken() {
          firstTokenAt ??= Date.now()
        },
        async onUsage(usage) {
          input.usages.push(usage)
          const aggregate = aggregateTokenUsage(input.usages)
          if (aggregate !== undefined)
            await input.session.checkpointUsage(input.execution, aggregate)
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
        (nativeItems.length !== 1 || response.providerResponseId === undefined)
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
        nativeItems: response.native,
        origin: response.origin,
        ...(usage === undefined ? {} : { usage }),
      }
    }
    let result: Awaited<ReturnType<typeof compact>> | undefined
    while (result === undefined) {
      const messages = await prepareModelMedia(
        completeToolCallHistory(source),
        {
          target: compactionStep.target,
          imageCapabilities: compactionStep.modelInfo,
          rolloutAssets: input.rolloutAssets,
          documentReading: compactionStep.documentReading,
          userDocumentReading: compactionStep.userDocumentReading,
          signal: input.signal,
        },
      )
      try {
        result = await compact(
          input.remoteCompaction
            ? {
                compaction: input.remoteCompaction,
                assets: {
                  read: (source, signal) =>
                    readAssetSource(source, input.rolloutAssets, signal),
                  ...(input.assetUrl === undefined
                    ? {}
                    : { url: input.assetUrl }),
                },
                target: compactionStep.target,
                cacheKey: compactionStep.configuration.promptCacheKey,
                system: [compactionStep.configuration.baseInstructions],
                messages,
                tools: compactionStep.toolRouter.modelDefinitions,
                toolWireProtocol: compactionStep.toolWireProtocol,
                signal: input.signal,
              }
            : buildCompactionRequest({
                assets: {
                  read: (source, signal) =>
                    readAssetSource(source, input.rolloutAssets, signal),
                  ...(input.assetUrl === undefined
                    ? {}
                    : { url: input.assetUrl }),
                },
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
          !usedFallback &&
          input.fallback !== undefined &&
          canRetryCompactionWithCurrentModel(error)
        ) {
          usedFallback = true
          fallbackSourceError = error
          compactionStep = input.fallback.step
          compactionStream = input.fallback.stream
          source = input.remoteCompaction
            ? trimRemoteCompactionToolTail(
                input.history.map(({ item }) => item),
                compactionStep.configuration.baseInstructions.text,
                compactionStep.configuration.modelCapacity
                  ?.effectiveContextWindowTokens,
              )
            : input.history.map(({ item }) => item)
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
    const retained =
      input.remoteCompaction === "responses_compact"
        ? []
        : input.remoteCompaction
          ? retainRemoteCompactionMessages(input.history)
          : retainCompactionUserMessages(input.history)
    // Codex keeps its checkpoint last. The public compact API instead supplies
    // an entire canonical window, followed by fresh harness context.
    const summaryItem =
      result.native === undefined
        ? generated.at(-1)
        : envelope(input.turnId, {
            role: "assistant",
            content: [result.native],
            ...(result.nativeItems === undefined
              ? {}
              : { native: result.nativeItems }),
            ...(result.origin === undefined ? {} : { response: result.origin }),
          })
    if (summaryItem === undefined)
      throw new Error("Missing compaction checkpoint.")
    const replacement =
      input.remoteCompaction === "responses_compact"
        ? [summaryItem, ...generated.slice(0, -1)]
        : [
            ...retained.slice(0, -1),
            ...generated.slice(0, -1),
            ...retained.slice(-1),
            summaryItem,
          ]
    await input.session.checkpointHistory(input.execution, {
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
      messages: input.session
        .executionSnapshot(input.execution)
        .context.history.map((item) => item.item),
      tools: [],
      toolWireProtocol: "eager",
    }).estimatedInputTokens
    await input.session.recordContextTokens(input.execution, {
      activeContextTokens: estimatedContextTokens,
      inputTokens: estimatedContextTokens,
      estimatedPrefill: true,
      historyAnchorItemId:
        input.session.executionSnapshot(input.execution).context.history.at(-1)
          ?.id ?? input.turnId,
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
    await input.session.recordItemCompletions(input.execution, [
      completeCompactionItem(compactionItem, "completed"),
    ])
    completed = true
    const postHook = await input.hookRunner?.run({
      event: HookEvent.PostCompact,
      matcher: input.remoteCompaction ? "remote" : "local",
      payload: {
        session_id: input.session.executionSnapshot(input.execution).metadata
          .id,
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
      input.session,
      input.execution,
      input.turnId,
      postHook?.additionalContext ?? [],
    )
    input.rolloutBudget?.rearm(
      input.session.executionSnapshot(input.execution).metadata.id,
    )
    return true
  } catch (error) {
    if (error instanceof TaskCleanupError) throw error
    if (input.signal.aborted || isAbortError(error)) throw abortError()
    if (!completed) {
      await input.session.recordItemCompletions(input.execution, [
        completeCompactionItem(compactionItem, "failed", error),
      ])
    }
    throw error
  }
}

function completedResponseItems(
  response: ResponseItemEnvelope,
): readonly CompletedExecutionItem[] {
  if (response.item.role !== "assistant") return []
  const providerMetadata = response.providerMetadata
  const source =
    response.item.response === undefined
      ? undefined
      : {
          callId: response.item.response.callId,
          itemId: response.id,
        }
  const indexes = { assistant: 0, reasoning: 0 }
  return response.item.content.flatMap<CompletedExecutionItem>((block) => {
    if (block.type !== "text" && block.type !== "reasoning") return []
    const kind = block.type === "text" ? "assistant" : "reasoning"
    const itemId = modelOutputItemId(response.id, kind, indexes[kind]++)
    return [
      {
        ...(block.type === "text"
          ? { type: "agent_message" as const, content: [block] }
          : {
              type: "reasoning" as const,
              text: block.text,
              ...(block.representation === undefined
                ? {}
                : { representation: block.representation }),
            }),
        itemId,
        ...(source === undefined ? {} : { source }),
        ...(providerMetadata === undefined ? {} : { providerMetadata }),
      },
    ]
  })
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

async function recordSteering(
  input: Parameters<typeof executeTurn>[0],
  steering: readonly TurnInput[],
): Promise<readonly TurnInput[]> {
  const accepted: TurnInput[] = []
  if (steering.length === 0) return accepted
  const metadata = input.session.executionSnapshot(input.execution).metadata
  for (const item of steering) {
    const hook =
      item.goalId === undefined && item.provenance === undefined
        ? await input.options.hookRunner?.run({
            event: HookEvent.UserPromptSubmit,
            payload: {
              session_id: metadata.id,
              turn_id: input.input.submissionId,
              prompt: inputContentText(item.content),
            },
            cwd: requireValue(metadata.workingDirectory, "Working directory"),
            signal: input.signal,
          })
        : undefined
    if (hook?.continue !== false) {
      if (item.provenance !== undefined)
        await input.session.recordThreadMessageInput(input.execution, item)
      else
        await input.session.recordConversationItems(input.execution, [
          inputEnvelope(item, item.submissionId),
        ])
      accepted.push(item)
    }
    await recordHookContext(
      input.session,
      input.execution,
      input.input.submissionId,
      hook?.additionalContext ?? [],
    )
  }
  return accepted
}

async function recordHookContext(
  session: Session,
  execution: ExecutionContext,
  turnId: string,
  context: readonly string[],
): Promise<void> {
  const content = context.filter((entry) => entry.trim() !== "")
  if (content.length === 0) return
  await session.recordConversationItems(execution, [
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
      inputContentToModelMessage(input.content, input.goalId),
    ),
    ...turnInputSubmissionMetadata(input),
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
        content: [{ type: "text" as const, text: MISSING_TOOL_RESULT_TEXT }],
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
  callback: TurnLoopOperationalFailureReporter | undefined,
  failure: TurnLoopOperationalFailure,
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
