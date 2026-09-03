import { createHash } from "node:crypto"
import type {
  ApprovalPolicy,
  ModelSelection,
  SessionConfigurationSnapshot,
  TurnExecutionContext,
  TurnExecutionLimits,
} from "../kernel/index.ts"
import { isSessionConfigurationSnapshot } from "../kernel/index.ts"
import {
  createSessionExecutionPolicy,
  deriveCompactionContextBytes,
  deriveModelVisibleContextBytes,
  SessionExecutionPolicyDefaults,
  type SessionExecutionPolicy,
} from "./limits.ts"
import {
  catalogContextWindowTokens,
  catalogModelCapacity,
  type ResolvedModel,
  resolveModel,
  validateModelSelection,
} from "./model-catalog.ts"
import type { ModelSystemSection, ModelTarget } from "./model.ts"
import type { ModelsManager } from "./models-manager.ts"
import { getInstructionProfile } from "./prompt-registry.ts"

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
}>

export type ResolvedStepConfiguration = Readonly<{
  target: ModelTarget
  modelInfo: ResolvedModel
  promptCacheKey: string
  baseInstructions: ModelSystemSection
  modelInstructions: ModelSystemSection
  workspaceRoot: string
  enabledTools: readonly string[]
  approvalPolicy: ApprovalPolicy
  executionPolicy: SessionExecutionPolicy
  modelCapacity?: ResolvedModelCapacity
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
    },
    models?: ModelsManager,
  ): SessionConfiguration {
    validateSelection(input.selection, models)
    const model = resolveSelection(input.selection, models)
    const prompt = getInstructionProfile(model.instructionProfileId)
    const baseInstructions = resolveBaseInstructions(input.baseInstructions, {
      prompt,
      model,
    })
    if (input.promptCacheKey.trim().length === 0) {
      throw new Error("promptCacheKey must be non-empty.")
    }
    validateContextWindowOverride(model, input.modelContextWindowTokens, models)
    return new SessionConfiguration({
      schemaVersion: 4,
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
    return new SessionConfiguration({
      ...snapshot,
      defaultTarget: { ...snapshot.defaultTarget },
      baseInstructions: {
        ...snapshot.baseInstructions,
        provenance: { ...snapshot.baseInstructions.provenance },
      },
      enabledTools: [...snapshot.enabledTools],
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
    const prompt = getInstructionProfile(model.instructionProfileId)
    const modelCapacity = resolveModelCapacity(
      model,
      this.snapshot.modelContextWindowTokens,
      models,
    )
    return {
      target: {
        provider: model.provider,
        model: model.model,
        instructionProfileId: model.instructionProfileId,
        ...(selection.effort === undefined ? {} : { effort: selection.effort }),
        ...(selection.speed === undefined ? {} : { speed: selection.speed }),
      },
      modelInfo: model,
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
      ...(modelCapacity === undefined ? {} : { modelCapacity }),
    }
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
  models?: ModelsManager,
): ResolvedModelCapacity | undefined {
  const catalogCapacity =
    models === undefined ? catalogModelCapacity(model) : models.capacity(model)
  const catalogWindow =
    models === undefined ? catalogContextWindowTokens(model) : undefined
  const defaultContextWindowTokens =
    catalogCapacity?.contextWindowTokens ?? catalogWindow ?? override
  if (defaultContextWindowTokens === undefined) return undefined
  const maxContextWindowTokens =
    catalogCapacity?.maxContextWindowTokens ??
    Math.max(defaultContextWindowTokens, override ?? 0)
  const contextWindowTokens = override ?? defaultContextWindowTokens
  const effectiveContextWindowPercent =
    catalogCapacity?.effectiveContextWindowPercent ?? 100
  return {
    defaultContextWindowTokens,
    contextWindowTokens,
    maxContextWindowTokens,
    effectiveContextWindowPercent,
    effectiveContextWindowTokens: Math.floor(
      (contextWindowTokens * effectiveContextWindowPercent) / 100,
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
    ? resolveModel(selection)
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
  const modelVisibleContextBytes =
    configuration.modelCapacity === undefined ||
    executionPolicy.modelVisibleContextBytes !==
      SessionExecutionPolicyDefaults.modelVisibleContextBytes
      ? executionPolicy.modelVisibleContextBytes
      : deriveModelVisibleContextBytes(
          configuration.modelCapacity.effectiveContextWindowTokens,
        )
  const compaction = deriveCompactionContextBytes({
    modelVisibleContextBytes,
    triggerRatio: executionPolicy.compactionTriggerRatio,
    retainRatio: executionPolicy.compactionRetainRatio,
  })
  return {
    modelCallsPerTurn: executionPolicy.modelCallsPerTurn,
    toolCallsPerTurn: executionPolicy.toolCallsPerTurn,
    modelVisibleMessageBlocks: executionPolicy.modelVisibleMessageBlocks,
    modelVisibleContextBytes,
    compactionTriggerContextBytes: compaction.triggerBytes,
    compactionRetainContextBytes: compaction.retainBytes,
    modelVisibleToolResultBytes: executionPolicy.modelVisibleToolResultBytes,
    modelVisibleToolResultLines: executionPolicy.modelVisibleToolResultLines,
    assistantResponseBytes: executionPolicy.assistantResponseBytes,
  }
}
