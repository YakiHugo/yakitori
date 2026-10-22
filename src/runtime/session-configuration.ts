import { createHash } from "node:crypto"
import type {
  ApprovalPolicy,
  AutoCompactTokenLimitScope,
  ModelSelection,
  ModelTransportPolicy,
  SessionConfigurationSnapshot,
  TurnExecutionContext,
  TurnExecutionLimits,
} from "../kernel/index.ts"
import { isSessionConfigurationSnapshot } from "../kernel/index.ts"
import {
  createSessionExecutionPolicy,
  type SessionExecutionPolicy,
  SessionExecutionPolicyDefaults,
} from "./limits.ts"
import type { ModelSystemSection, ModelTarget } from "./model.ts"
import {
  catalogModelCapacity,
  DefaultToolOutputTruncation,
  type ResolvedModel,
  validateModelSelection,
} from "./model-catalog.ts"
import type { ModelRequestPolicy } from "./model-request.ts"
import {
  createStaticModelsManager,
  type ModelsManager,
} from "./models-manager.ts"
import { getModelInstructions } from "./prompt-registry.ts"

export type { ApprovalPolicy } from "../kernel/index.ts"

type ResolvedSessionConfigurationSnapshot = Omit<
  SessionConfigurationSnapshot,
  "promptCacheKey" | "executionPolicyDefaults"
> & {
  readonly promptCacheKey: string
  readonly executionPolicyDefaults: SessionExecutionPolicy
}

export type ResolvedModelCapacity = Readonly<{
  defaultContextWindowTokens: number
  contextWindowTokens: number
  maxContextWindowTokens: number
  effectiveContextWindowPercent: number
  effectiveContextWindowTokens: number
  contextWindowScope: "input" | "total"
  inputContextLimitTokens: number
}>

export type ResolvedStepConfiguration = Readonly<{
  target: ModelTarget
  modelInfo: ResolvedModel
  maxOutputTokens?: number
  promptCacheKey: string
  baseInstructions: ModelSystemSection
  modelInstructions: ModelSystemSection
  workspaceRoot: string
  enabledTools: readonly string[]
  approvalPolicy: ApprovalPolicy
  executionPolicy: SessionExecutionPolicy
  modelCapacity?: ResolvedModelCapacity
  modelRequestPolicy?: ModelRequestPolicy
  autoCompact: Readonly<{
    limitTokens?: number
    scope: AutoCompactTokenLimitScope
  }>
}>

export type TurnContext = Readonly<{
  requestSettings: ResolvedStepConfiguration
  execution: TurnExecutionContext
}>

export class SessionConfiguration {
  readonly snapshot: ResolvedSessionConfigurationSnapshot

  private constructor(snapshot: ResolvedSessionConfigurationSnapshot) {
    this.snapshot = snapshot
  }

  static create(
    input: {
      readonly selection: ModelSelection
      readonly workspaceRoot: string
      readonly enabledTools: readonly string[]
      readonly approvalPolicy: ApprovalPolicy
      readonly promptCacheKey: string
      readonly baseInstructions?: string
      readonly executionPolicy?: SessionExecutionPolicy
      readonly modelContextWindowTokens?: number
      readonly modelAutoCompactTokenLimit?: number
      readonly modelAutoCompactTokenLimitScope?: AutoCompactTokenLimitScope
      readonly modelTransport?: ModelTransportPolicy
    },
    models?: ModelsManager,
  ): SessionConfiguration {
    validateSelection(input.selection, models)
    const model = resolveSelection(input.selection, models)
    const prompt = getModelInstructions(model)
    const baseInstructions = resolveBaseInstructions(input.baseInstructions, {
      prompt,
      model,
    })
    if (input.promptCacheKey.trim().length === 0) {
      throw new Error("promptCacheKey must be non-empty.")
    }
    validateContextWindowOverride(model, input.modelContextWindowTokens, models)
    validateAutoCompactTokenLimit(input.modelAutoCompactTokenLimit)
    return new SessionConfiguration({
      schemaVersion: 5,
      collaborationToolsVersion: 2,
      workspaceRoot: input.workspaceRoot,
      promptCacheKey: input.promptCacheKey,
      defaultTarget: { ...input.selection },
      baseInstructions,
      enabledTools: [...input.enabledTools],
      approvalPolicy: input.approvalPolicy,
      executionPolicyDefaults: {
        ...(input.executionPolicy ?? createSessionExecutionPolicy()),
      },
      ...(input.modelContextWindowTokens === undefined
        ? {}
        : { modelContextWindowTokens: input.modelContextWindowTokens }),
      ...(input.modelAutoCompactTokenLimit === undefined
        ? {}
        : { modelAutoCompactTokenLimit: input.modelAutoCompactTokenLimit }),
      modelAutoCompactTokenLimitScope:
        input.modelAutoCompactTokenLimitScope ?? "total",
      ...(input.modelTransport === undefined
        ? {}
        : { modelTransport: structuredClone(input.modelTransport) }),
    })
  }

  static restore(
    snapshot: SessionConfigurationSnapshot,
    models?: ModelsManager,
  ): SessionConfiguration {
    if (!isSessionConfigurationSnapshot(snapshot)) {
      throw new Error("Invalid Session configuration snapshot.")
    }
    const executionPolicyDefaults = requireSessionExecutionPolicy(
      snapshot.executionPolicyDefaults,
    )
    const model = resolveSelection(snapshot.defaultTarget, models)
    if (snapshot.promptCacheKey.trim().length === 0) {
      throw new Error("promptCacheKey must be non-empty.")
    }
    validateContextWindowOverride(
      model,
      snapshot.modelContextWindowTokens,
      models,
    )
    validateAutoCompactTokenLimit(snapshot.modelAutoCompactTokenLimit)
    return new SessionConfiguration({
      ...snapshot,
      collaborationToolsVersion: 2,
      defaultTarget: { ...snapshot.defaultTarget },
      baseInstructions: {
        ...snapshot.baseInstructions,
        provenance: { ...snapshot.baseInstructions.provenance },
      },
      enabledTools: restoreCollaborationTools(snapshot),
      executionPolicyDefaults,
    })
  }

  resolveStep(
    selection: ModelSelection,
    models?: ModelsManager,
  ): ResolvedStepConfiguration {
    validateSelection(selection, models)
    const model = resolveSelection(selection, models)
    validateContextWindowOverride(
      model,
      this.snapshot.modelContextWindowTokens,
      models,
    )
    const effort = selection.effort ?? model.defaultEffort
    const prompt = getModelInstructions(model)
    const requestedOutputTokens = model.defaultOutputTokens
    const maxOutputTokens =
      requestedOutputTokens === undefined
        ? undefined
        : Math.min(
            requestedOutputTokens,
            model.maxOutputTokens ?? Number.POSITIVE_INFINITY,
          )
    const modelCapacity = resolveModelCapacity(
      model,
      this.snapshot.modelContextWindowTokens,
      maxOutputTokens,
      models,
    )
    const modelRequestPolicy = resolveModelRequestPolicy(
      this.snapshot.modelTransport,
      model.provider,
    )
    return {
      target: {
        provider: model.provider,
        model: model.model,
        instructionProfileId: model.instructionProfileId,
        ...(effort === undefined ? {} : { effort }),
        ...(selection.speed === undefined ? {} : { speed: selection.speed }),
      },
      modelInfo: model,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      promptCacheKey: this.snapshot.promptCacheKey,
      baseInstructions: {
        id: "base.instructions",
        revision: this.snapshot.baseInstructions.revision,
        text: this.snapshot.baseInstructions.text,
      },
      modelInstructions: {
        id: "model.instructions",
        revision: prompt.revision,
        text: prompt.text,
      },
      workspaceRoot: this.snapshot.workspaceRoot,
      enabledTools: [...this.snapshot.enabledTools],
      approvalPolicy: this.snapshot.approvalPolicy,
      executionPolicy: requireSessionExecutionPolicy(
        this.snapshot.executionPolicyDefaults,
      ),
      autoCompact: resolveAutoCompact(
        model,
        modelCapacity,
        this.snapshot.modelAutoCompactTokenLimit,
        this.snapshot.modelAutoCompactTokenLimitScope,
      ),
      ...(modelRequestPolicy === undefined ? {} : { modelRequestPolicy }),
      ...(modelCapacity === undefined ? {} : { modelCapacity }),
    }
  }
}

function restoreCollaborationTools(
  snapshot: SessionConfigurationSnapshot,
): string[] {
  const enabledTools = [...snapshot.enabledTools]
  if (snapshot.collaborationToolsVersion !== undefined) return enabledTools
  // Match the complete pre-thread-collaboration defaults, not merely the six
  // agent tools: a custom allowlist may intentionally include only those six.
  // These historical lists must not track future registry additions.
  const runtimeDefaults = [
    "read_file",
    "view_image",
    "read_document",
    "grep",
    "glob",
    "edit_file",
    "write_file",
    "apply_patch",
    "exec_command",
    "write_stdin",
    "web_fetch",
    "web_search",
    "request_user_input_async",
    "spawn_agent",
    "send_message",
    "followup_task",
    "wait_agent",
    "interrupt_agent",
    "list_agents",
  ]
  const applicationDefaults = [
    ...runtimeDefaults,
    "get_goal",
    "create_goal",
    "update_goal",
    "configure_model_sources",
  ]
  const previousDefaults = [
    runtimeDefaults,
    applicationDefaults,
    applicationDefaults.filter((name) => name !== "request_user_input_async"),
  ]
  // Upgrade once without rewriting history. Restricted or unknown old lists
  // and explicit current overrides remain authoritative.
  if (
    previousDefaults.some(
      (defaults) =>
        enabledTools.length === defaults.length &&
        defaults.every((name) => enabledTools.includes(name)),
    )
  ) {
    for (const name of [
      "list_threads",
      "read_thread",
      "send_message_to_thread",
      "wait_threads",
    ]) {
      if (!enabledTools.includes(name)) enabledTools.push(name)
    }
  }
  return enabledTools
}

export function resolveModelRequestPolicy(
  transport: ModelTransportPolicy | undefined,
  provider: string,
): ModelRequestPolicy | undefined {
  if (transport === undefined) return undefined
  const { providers, ...defaults } = transport
  const policy = { ...defaults, ...providers?.[provider] }
  return Object.keys(policy).length === 0 ? undefined : policy
}

function validateAutoCompactTokenLimit(limit: number | undefined): void {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw new Error(
      "model_auto_compact_token_limit must be a positive integer.",
    )
  }
}

function resolveAutoCompact(
  model: ResolvedModel,
  capacity: ResolvedModelCapacity | undefined,
  configuredLimit: number | undefined,
  scope: AutoCompactTokenLimitScope,
): ResolvedStepConfiguration["autoCompact"] {
  const limits = [
    capacity === undefined
      ? undefined
      : Math.floor(capacity.contextWindowTokens * 0.9),
    model.autoCompactTokenLimit,
    configuredLimit,
  ].filter((limit): limit is number => limit !== undefined)
  return {
    ...(limits.length === 0 ? {} : { limitTokens: Math.min(...limits) }),
    scope,
  }
}

function resolveBaseInstructions(
  custom: string | undefined,
  input: {
    readonly prompt: { readonly text: string; readonly revision: string }
    readonly model: {
      readonly provider: string
      readonly model: string
      readonly instructionProfileId: string
    }
  },
): SessionConfigurationSnapshot["baseInstructions"] {
  if (custom === undefined) {
    return {
      text: input.prompt.text,
      revision: input.prompt.revision,
      provenance: {
        type: "model",
        provider: input.model.provider,
        model: input.model.model,
        instructionProfileId: input.model.instructionProfileId,
      },
    }
  }
  const text = custom.trim()
  if (text.length === 0) {
    throw new Error("baseInstructions must be non-empty.")
  }
  return {
    text,
    revision: createHash("sha256").update(text).digest("hex"),
    provenance: { type: "custom" },
  }
}

export function createTurnContext(input: {
  readonly requestSettings: ResolvedStepConfiguration
  readonly mateId: string
  readonly mateRevisionId: string
}): TurnContext {
  const executionPolicy = stepExecutionLimits(input.requestSettings)
  const capacity = input.requestSettings.modelCapacity
  return {
    requestSettings: input.requestSettings,
    execution: {
      mateId: input.mateId,
      mateRevisionId: input.mateRevisionId,
      provider: input.requestSettings.target.provider,
      model: input.requestSettings.target.model,
      instructionProfileId: input.requestSettings.target.instructionProfileId,
      baseInstructionsRevision: input.requestSettings.baseInstructions.revision,
      modelInstructionsRevision:
        input.requestSettings.modelInstructions.revision,
      ...(input.requestSettings.target.effort === undefined
        ? {}
        : { effort: input.requestSettings.target.effort }),
      ...(input.requestSettings.target.speed === undefined
        ? {}
        : { speed: input.requestSettings.target.speed }),
      ...(capacity === undefined
        ? {}
        : {
            modelContextWindowTokens: capacity.contextWindowTokens,
            effectiveModelContextWindowTokens:
              capacity.effectiveContextWindowTokens,
          }),
      workingDirectory: input.requestSettings.workspaceRoot,
      enabledTools: [...input.requestSettings.enabledTools],
      approvalPolicy: input.requestSettings.approvalPolicy,
      executionPolicy,
    },
  }
}

function resolveModelCapacity(
  model: { readonly provider: string; readonly model: string },
  override: number | undefined,
  maxOutputTokens: number | undefined,
  models?: ModelsManager,
): ResolvedModelCapacity | undefined {
  const catalogCapacity =
    models === undefined ? catalogModelCapacity(model) : models.capacity(model)
  const defaultContextWindowTokens =
    catalogCapacity?.contextWindowTokens ?? override
  if (defaultContextWindowTokens === undefined) return undefined
  const maxContextWindowTokens =
    catalogCapacity?.maxContextWindowTokens ??
    Math.max(defaultContextWindowTokens, override ?? 0)
  const contextWindowTokens = override ?? defaultContextWindowTokens
  const effectiveContextWindowPercent =
    catalogCapacity?.effectiveContextWindowPercent ?? 100
  const effectiveContextWindowTokens = Math.floor(
    (contextWindowTokens * effectiveContextWindowPercent) / 100,
  )
  const contextWindowScope =
    // An override for an unknown model retains its existing input-budget
    // meaning; no provider capability establishes a combined token window.
    catalogCapacity?.contextWindowScope ?? "input"
  return {
    defaultContextWindowTokens,
    contextWindowTokens,
    maxContextWindowTokens,
    effectiveContextWindowPercent,
    effectiveContextWindowTokens,
    contextWindowScope,
    // A percentage may already leave enough headroom. Reserve output against
    // the total window, then intersect with the effective input capacity.
    inputContextLimitTokens:
      contextWindowScope === "input"
        ? effectiveContextWindowTokens
        : Math.max(
            0,
            Math.min(
              effectiveContextWindowTokens,
              contextWindowTokens - (maxOutputTokens ?? 0),
            ),
          ),
  }
}

function validateContextWindowOverride(
  model: { readonly provider: string; readonly model: string },
  override: number | undefined,
  models?: ModelsManager,
): void {
  if (override === undefined) return
  if (!Number.isInteger(override) || override <= 0) {
    throw new Error("model_context_window must be a positive integer.")
  }
  const capacity =
    models === undefined ? catalogModelCapacity(model) : models.capacity(model)
  if (
    capacity?.maxContextWindowTokens !== undefined &&
    override > capacity.maxContextWindowTokens
  ) {
    throw new Error(
      `model_context_window ${override} exceeds ${model.provider}/${model.model} maximum of ${capacity.maxContextWindowTokens}.`,
    )
  }
}

function resolveSelection(
  selection: ModelSelection,
  models: ModelsManager | undefined,
) {
  return models === undefined
    ? createStaticModelsManager(selection.provider).resolve(selection)
    : models.resolve(selection)
}

function validateSelection(
  selection: ModelSelection,
  models: ModelsManager | undefined,
): void {
  if (models === undefined) validateModelSelection(selection)
  else models.validate(selection)
}

function requireSessionExecutionPolicy(
  value: SessionConfigurationSnapshot["executionPolicyDefaults"],
): SessionExecutionPolicy {
  const expectedKeys = Object.keys(SessionExecutionPolicyDefaults)
  const actualKeys = Object.keys(value)
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(
      "Session configuration contains an invalid execution policy.",
    )
  }
  return createSessionExecutionPolicy(value)
}

export function stepExecutionLimits(
  configuration: ResolvedStepConfiguration,
): TurnExecutionLimits {
  const executionPolicy = configuration.executionPolicy
  return {
    modelVisibleToolResultBytes: executionPolicy.modelVisibleToolResultBytes,
    modelVisibleToolResultLines: executionPolicy.modelVisibleToolResultLines,
    assistantResponseBytes: executionPolicy.assistantResponseBytes,
  }
}

export function toolHistoryOutputBudget(
  configuration: ResolvedStepConfiguration,
): import("../core/rollout.ts").HistoryOutputBudget {
  const policy =
    configuration.modelInfo.toolOutputTruncation ?? DefaultToolOutputTruncation
  // Match Codex's four-byte token estimate and 20% serialization allowance.
  const maxBytes =
    Math.ceil(policy.limit * 1.2) * (policy.mode === "tokens" ? 4 : 1)
  return {
    maxBytes: Math.min(
      maxBytes,
      Number.MAX_SAFE_INTEGER,
      configuration.executionPolicy.modelVisibleToolResultBytes,
    ),
    maxLines: configuration.executionPolicy.modelVisibleToolResultLines,
  }
}
