import { createHash } from "node:crypto"
import type {
  ModelSelection,
  SessionConfigurationSnapshot,
  TurnExecutionContext,
  TurnExecutionLimits,
} from "../kernel/index.ts"
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
  resolveModel,
  validateModelSelection,
} from "./model-catalog.ts"
import type { ModelSystemSection, ModelTarget } from "./model.ts"
import { getInstructionProfile } from "./prompt-registry.ts"

export type ApprovalPolicy = "auto_file_tools" | "never"

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

export type ResolvedTurnConfiguration = Readonly<{
  target: ModelTarget
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
  configuration: ResolvedTurnConfiguration
  execution: TurnExecutionContext
}>

export class SessionConfiguration {
  readonly snapshot: ResolvedSessionConfigurationSnapshot

  private constructor(snapshot: ResolvedSessionConfigurationSnapshot) {
    this.snapshot = snapshot
  }

  static create(input: {
    readonly selection: ModelSelection
    readonly workspaceRoot: string
    readonly enabledTools: readonly string[]
    readonly approvalPolicy: ApprovalPolicy
    readonly promptCacheKey: string
    readonly baseInstructions?: string
    readonly executionPolicy?: SessionExecutionPolicy
    readonly modelContextWindowTokens?: number
  }): SessionConfiguration {
    validateModelSelection(input.selection)
    const model = resolveModel(input.selection)
    const prompt = getInstructionProfile(model.instructionProfileId)
    const baseInstructions = resolveBaseInstructions(input.baseInstructions, {
      prompt,
      model,
    })
    if (input.promptCacheKey.trim().length === 0) {
      throw new Error("promptCacheKey must be non-empty.")
    }
    validateContextWindowOverride(model, input.modelContextWindowTokens)
    return new SessionConfiguration({
      schemaVersion: 3,
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

  static restore(snapshot: SessionConfigurationSnapshot): SessionConfiguration {
    const executionPolicyDefaults = requireSessionExecutionPolicy(
      snapshot.executionPolicyDefaults,
    )
    const model = resolveModel(snapshot.defaultTarget)
    if (snapshot.promptCacheKey.trim().length === 0) {
      throw new Error("promptCacheKey must be non-empty.")
    }
    validateContextWindowOverride(model, snapshot.modelContextWindowTokens)
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

  resolveTurn(selection: ModelSelection): ResolvedTurnConfiguration {
    validateModelSelection(selection)
    const model = resolveModel(selection)
    validateContextWindowOverride(model, this.snapshot.modelContextWindowTokens)
    const prompt = getInstructionProfile(model.instructionProfileId)
    const modelCapacity = resolveModelCapacity(
      model,
      this.snapshot.modelContextWindowTokens,
    )
    return {
      target: {
        provider: model.provider,
        model: model.model,
        instructionProfileId: model.instructionProfileId,
        ...(selection.effort === undefined ? {} : { effort: selection.effort }),
        ...(selection.speed === undefined ? {} : { speed: selection.speed }),
      },
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
  readonly configuration: ResolvedTurnConfiguration
  readonly mateId: string
  readonly mateRevisionId: string
}): TurnContext {
  const executionPolicy = turnExecutionLimits(input.configuration)
  const capacity = input.configuration.modelCapacity
  return {
    configuration: input.configuration,
    execution: {
      mateId: input.mateId,
      mateRevisionId: input.mateRevisionId,
      provider: input.configuration.target.provider,
      model: input.configuration.target.model,
      instructionProfileId: input.configuration.target.instructionProfileId,
      baseInstructionsRevision: input.configuration.baseInstructions.revision,
      modelInstructionsRevision: input.configuration.modelInstructions.revision,
      ...(input.configuration.target.effort === undefined
        ? {}
        : { effort: input.configuration.target.effort }),
      ...(input.configuration.target.speed === undefined
        ? {}
        : { speed: input.configuration.target.speed }),
      ...(capacity === undefined
        ? {}
        : {
            modelContextWindowTokens: capacity.contextWindowTokens,
            effectiveModelContextWindowTokens:
              capacity.effectiveContextWindowTokens,
          }),
      workingDirectory: input.configuration.workspaceRoot,
      enabledTools: [...input.configuration.enabledTools],
      approvalPolicy: input.configuration.approvalPolicy,
      executionPolicy,
    },
  }
}

function resolveModelCapacity(
  model: { readonly provider: string; readonly model: string },
  override: number | undefined,
): ResolvedModelCapacity | undefined {
  const catalogCapacity = catalogModelCapacity(model)
  const catalogWindow = catalogContextWindowTokens(model)
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
): void {
  if (override === undefined) return
  if (!Number.isInteger(override) || override <= 0) {
    throw new Error("model_context_window must be a positive integer.")
  }
  const capacity = catalogModelCapacity(model)
  if (
    capacity?.maxContextWindowTokens !== undefined &&
    override > capacity.maxContextWindowTokens
  ) {
    throw new Error(
      `model_context_window ${override} exceeds ${model.provider}/${model.model} maximum of ${capacity.maxContextWindowTokens}.`,
    )
  }
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

function turnExecutionLimits(
  configuration: ResolvedTurnConfiguration,
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
