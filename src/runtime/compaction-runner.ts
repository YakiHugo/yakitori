import type {
  ModelContextSettings,
  ResponseItemEnvelope,
} from "../core/rollout.ts"
import type { Session } from "../core/session.ts"
import {
  type ExecutionContext,
  settleTaskResources,
  TaskCleanupError,
} from "../core/session-task.ts"
import {
  type ContextCompactionCompletedItem,
  createCompactionId,
  isModelMessage,
  type KernelError,
  type RolloutAssets,
  type SessionConfigurationSnapshot,
  type StartedExecutionItem,
} from "../kernel/index.ts"
import { readAssetSource } from "./asset-media.ts"
import {
  buildCompactionRequest,
  canRetryCompactionWithCurrentModel,
  isContextOverflowError,
  trimRemoteCompactionToolTail,
} from "./compaction.ts"
import { ModelNotConfiguredError } from "./configured-models-manager.ts"
import { isAbortError } from "./errors.ts"
import { HookEvent, type HookRunner } from "./hooks.ts"
import {
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  ModelStopReason,
  type ModelWireApi,
  type StreamFn,
} from "./model.ts"
import {
  createCompactionReplacementHistory,
  retainCompactionUserMessages,
  retainRemoteCompactionMessages,
} from "./model-context.ts"
import { completeToolCallHistory, envelope } from "./model-history.ts"
import { prepareModelMedia } from "./model-media.ts"
import { matchesCompactionOwner } from "./model-native.ts"
import type { ModelClient, ModelClientSession } from "./model-provider.ts"
import { estimateModelRequestBudget } from "./model-request-budget.ts"
import type { RolloutBudget } from "./rollout-budget.ts"
import {
  type ResolvedStepConfiguration,
  resolveModelRequestPolicy,
  SessionConfiguration,
} from "./session-configuration.ts"
import type { ToolRegistry } from "./tools/registry.ts"
import { captureStepContext, type StepContext } from "./tools/spec-plan.ts"
import { waitForTurnReadiness } from "./turn-readiness.ts"
import { diffWorldState, type WorldState } from "./world-state.ts"

export async function compactModelHandoff(
  input: CompactionRunInput &
    Readonly<{
      client: ModelClient | undefined
      selectedSession: ModelClientSession | undefined
      configuration: SessionConfigurationSnapshot
      previousModel: ModelContextSettings | undefined
      checkPreviousModel: boolean
      activeTokens: number
      registry: ToolRegistry
    }>,
): Promise<boolean> {
  const target = {
    ...input.step.target,
    wireApi: input.wireApi,
    scope: input.scope,
  }
  const foreign = input.history
    .map(({ item }) => item)
    .find(
      (item) =>
        item.role === "compaction" &&
        item.mode === "opaque" &&
        !matchesCompactionOwner(item.owner, target),
    )
  const owner =
    foreign?.role === "compaction" && foreign.mode === "opaque"
      ? foreign.owner
      : undefined
  const previous = input.previousModel
  const source = owner ?? (input.checkPreviousModel ? previous : undefined)
  if (source === undefined) return false
  const baseHistoryLength = input.baseHistoryLength ?? input.history.length
  const fallback = () =>
    owner === undefined
      ? false
      : compactLiveHistory({
          ...input,
          baseHistoryLength,
          strategy: undefined,
          history: historyReadableBy(input.history, target),
        })
  const sameProvider = source.provider === target.provider
  if (!sameProvider && !input.client?.hasProvider(source.provider))
    return fallback()
  const sourceSession = sameProvider
    ? input.selectedSession
    : input.client?.startTurn(
        source.provider,
        resolveModelRequestPolicy(
          input.configuration.modelTransport,
          source.provider,
        ),
      )
  try {
    if (
      owner !== undefined &&
      !matchesCompactionOwner(owner, {
        ...source,
        wireApi: sourceSession?.wireApi,
        scope: sourceSession?.continuationScope,
      })
    )
      return await fallback()
    const sourceModels = sourceSession?.models
    await waitForTurnReadiness(
      Promise.resolve().then(() => sourceModels?.refresh()),
      input.signal,
    )
    const { modelContextWindowTokens: _windowOverride, ...sourceSnapshot } =
      input.configuration
    let configuration: ResolvedStepConfiguration
    try {
      configuration = SessionConfiguration.restore(
        {
          ...(sameProvider ? input.configuration : sourceSnapshot),
          defaultTarget: { provider: source.provider, model: source.model },
        },
        sourceModels,
      ).resolveStep(source, sourceModels)
    } catch (error) {
      if (!(error instanceof ModelNotConfiguredError)) throw error
      return await fallback()
    }
    const oldWindow = configuration.modelCapacity?.effectiveContextWindowTokens
    const newWindow =
      input.step.configuration.modelCapacity?.effectiveContextWindowTokens
    const limit = input.step.configuration.autoCompact
    const hashChanged =
      previous?.provider === target.provider &&
      previous.compactionHash !== undefined &&
      input.step.modelInfo.compactionHash !== undefined &&
      previous.compactionHash !== input.step.modelInfo.compactionHash
    const differentModel = !sameProvider || source.model !== target.model
    const downshift =
      differentModel &&
      oldWindow !== undefined &&
      newWindow !== undefined &&
      oldWindow > newWindow &&
      (input.activeTokens >= newWindow ||
        (limit.scope === "total" &&
          limit.limitTokens !== undefined &&
          input.activeTokens > limit.limitTokens))
    if (owner === undefined && !hashChanged && !downshift) return false
    const step = captureStepContext({
      registry: input.registry,
      configuration,
      ...(sourceSession?.wireApi === undefined
        ? {}
        : { wireApi: sourceSession.wireApi }),
      nativePdf: sourceSession?.nativePdf === true,
      ...(sourceSession?.serviceId === undefined
        ? {}
        : { serviceId: sourceSession.serviceId }),
      ...(sourceSession?.toolCapabilities === undefined
        ? {}
        : { toolCapabilities: sourceSession.toolCapabilities }),
    })
    try {
      const wireApi = sourceSession?.wireApi ?? input.wireApi
      const scope = sourceSession?.continuationScope
      return await compactLiveHistory({
        ...input,
        baseHistoryLength,
        step,
        stream: sourceSession?.stream ?? input.stream,
        wireApi,
        scope,
        history: historyReadableBy(input.history, {
          ...step.target,
          wireApi,
          scope,
        }),
        strategy:
          differentModel || owner !== undefined
            ? undefined
            : sourceSession?.compactionStrategy,
        ...(differentModel || owner !== undefined
          ? {
              fallback: {
                step: input.step,
                stream: input.stream,
                wireApi: input.wireApi,
                scope: input.scope,
                history: input.history,
              },
            }
          : {}),
      })
    } finally {
      await settleTaskResources(() => step.toolRouter.release())
    }
  } finally {
    if (sourceSession !== input.selectedSession)
      await settleTaskResources(() => sourceSession?.close())
  }
}

export type CompactionRunInput = Readonly<{
  trigger?: "manual" | "auto"
  wireApi: ModelWireApi | undefined
  scope: string | undefined
  strategy: ModelClientSession["compactionStrategy"]
  fallback?: Readonly<{
    step: StepContext
    stream: StreamFn
    wireApi: ModelWireApi | undefined
    scope: string | undefined
    history: readonly ResponseItemEnvelope[]
  }>
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
  assetUrl: NonNullable<ModelRequest["assets"]>["url"]
  hookRunner: HookRunner | undefined
  rolloutBudget: RolloutBudget | undefined
  onHookContext: (context: readonly string[]) => Promise<void>
  sample: (
    request: ModelRequest,
    stream: StreamFn,
    wireApi: ModelWireApi | undefined,
    toolPolicy: ModelRequest["toolPolicy"],
  ) => Promise<ModelResponse>
}>

export async function compactLiveHistory(
  input: CompactionRunInput,
): Promise<boolean> {
  let compactionStep = input.step
  let compactionStream = input.stream
  let wireApi = input.wireApi
  let scope = input.scope
  let usedFallback = false
  let fallbackSourceError: unknown
  let source = input.history.map((item) => item.item)
  if (source.length === 0) return false
  if (input.strategy) {
    source = trimRemoteCompactionToolTail(
      source,
      compactionStep.configuration.baseInstructions.text,
      compactionStep.configuration.modelCapacity?.effectiveContextWindowTokens,
    )
  }

  const preHook = await input.hookRunner?.run({
    event: HookEvent.PreCompact,
    matcher: input.strategy ? "remote" : "local",
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
  await input.onHookContext(preHook?.additionalContext ?? [])

  const compactionItem: StartedExecutionItem = {
    type: "context_compaction",
    itemId: createCompactionId(),
  }
  input.session.emitItemStarted(input.execution, compactionItem)
  let completed = false

  try {
    const compact = async (request: ModelRequest) => {
      const response = await input.sample(
        request,
        compactionStream,
        wireApi,
        compactionStep.modelInfo.toolPolicy,
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
      if (input.strategy !== undefined) {
        const checkpoint = response.checkpoint
        if (
          checkpoint === undefined ||
          response.providerResponseId === undefined ||
          !isModelMessage(checkpoint) ||
          !matchesCompactionOwner(checkpoint.owner, {
            ...compactionStep.target,
            wireApi,
            scope,
          })
        ) {
          throw new Error(
            "Remote compaction requires one valid native checkpoint with a completed response id.",
          )
        }
        return {
          summary: "",
          checkpoint: {
            ...checkpoint,
            ...(response.origin === undefined
              ? {}
              : { response: response.origin }),
          },
        }
      }
      if (response.checkpoint !== undefined)
        throw new Error(
          "Local compaction returned opaque context instead of a summary.",
        )
      const summary = response.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("")
        .trim()
      if (summary.length === 0)
        throw new Error("Compaction produced an empty checkpoint.")
      return { summary }
    }
    let result: Awaited<ReturnType<typeof compact>> | undefined
    while (result === undefined) {
      const messages = await prepareModelMedia(
        completeToolCallHistory(source),
        {
          target: compactionStep.target,
          imageCapabilities: compactionStep.modelInfo,
          deferImagePreparation: compactionStep.deferImagePreparation,
          rolloutAssets: input.rolloutAssets,
          documentReading: compactionStep.documentReading,
          userDocumentReading: compactionStep.userDocumentReading,
          signal: input.signal,
        },
      )
      try {
        result = await compact(
          input.strategy
            ? {
                compaction: "provider",
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
          wireApi = input.fallback.wireApi
          scope = input.fallback.scope
          source = historyReadableBy(input.fallback.history, {
            ...compactionStep.target,
            wireApi,
            scope,
          }).map(({ item }) => item)
          continue
        }
        // A selected-model fallback still trims an over-long portable history.
        // Any other fallback failure keeps the source model's error.
        if (
          usedFallback &&
          fallbackSourceError !== undefined &&
          (input.strategy || !isContextOverflowError(error))
        ) {
          throw fallbackSourceError
        }
        if (
          input.strategy ||
          !isContextOverflowError(error) ||
          source.length <= 1
        )
          throw error
        // Codex retries local compaction by dropping the oldest input item.
        // The live history stays intact until a complete checkpoint is ready.
        source = source.slice(1)
      }
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
      input.strategy?.replacement === "native_window"
        ? []
        : input.strategy
          ? retainRemoteCompactionMessages(input.history)
          : retainCompactionUserMessages(input.history)
    // Codex keeps its checkpoint last. The public compact API instead supplies
    // an entire canonical window, followed by fresh harness context.
    const summaryItem =
      result.checkpoint === undefined
        ? generated.at(-1)
        : envelope(input.turnId, result.checkpoint)
    if (summaryItem === undefined)
      throw new Error("Missing compaction checkpoint.")
    const replacement = [
      ...(input.strategy?.replacement === "native_window"
        ? [summaryItem, ...generated.slice(0, -1)]
        : [
            ...retained.slice(0, -1),
            ...generated.slice(0, -1),
            ...retained.slice(-1),
            summaryItem,
          ]),
      ...(hasOmittedCheckpoint(source)
        ? [
            envelope(input.turnId, {
              role: "developer",
              content: [{ type: "text", text: OMITTED_ENCRYPTED_CONTEXT }],
            }),
          ]
        : []),
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
    const estimatedContextTokens = estimateModelRequestBudget(
      {
        target: compactionStep.target,
        system: [compactionStep.configuration.baseInstructions],
        messages: input.session
          .executionSnapshot(input.execution)
          .context.history.map((item) => item.item),
        tools: [],
        toolWireProtocol: "eager",
      },
      compactionStep.imageTokenEstimator,
      "history",
    ).estimatedInputTokens
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
      matcher: input.strategy ? "remote" : "local",
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
    await input.onHookContext(postHook?.additionalContext ?? [])
    input.rolloutBudget?.rearm(
      input.session.executionSnapshot(input.execution).metadata.id,
    )
    return true
  } catch (error) {
    if (error instanceof TaskCleanupError) throw error
    if (input.signal.aborted || isAbortError(error))
      throw new DOMException("Turn aborted.", "AbortError")
    if (!completed) {
      await input.session.recordItemCompletions(input.execution, [
        completeCompactionItem(compactionItem, "failed", error),
      ])
    }
    throw error
  }
}

export function completeCompactionItem(
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

const OMITTED_ENCRYPTED_CONTEXT =
  "<filtered_context>\nSome earlier context was filtered out because it was stored in an encrypted checkpoint that this model cannot read.\n</filtered_context>"

function hasOmittedCheckpoint(messages: readonly ModelMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "developer" &&
      message.content.some((block) => block.text === OMITTED_ENCRYPTED_CONTEXT),
  )
}

function historyReadableBy(
  history: readonly ResponseItemEnvelope[],
  target: Parameters<typeof matchesCompactionOwner>[1],
): readonly ResponseItemEnvelope[] {
  const readable = history.filter(
    ({ item }) =>
      item.role !== "compaction" ||
      item.mode !== "opaque" ||
      matchesCompactionOwner(item.owner, target),
  )
  if (
    readable.length === history.length ||
    hasOmittedCheckpoint(readable.map(({ item }) => item))
  )
    return readable
  return [
    ...readable,
    envelope(history.at(-1)?.turnId ?? "turn", {
      role: "developer",
      content: [{ type: "text", text: OMITTED_ENCRYPTED_CONTEXT }],
    }),
  ]
}
