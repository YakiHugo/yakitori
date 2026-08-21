import type {
  ModelSelection,
  SessionConfigurationSnapshot,
  TurnExecutionContext,
  TurnExecutionLimits,
} from "../kernel/index.ts"
import {
  createRuntimeLimits,
  deriveCompactionContextBytes,
  deriveModelVisibleContextBytes,
  RuntimeLimits,
  type RuntimeLimits as RuntimeLimitsType,
} from "./limits.ts"
import {
  catalogContextWindowTokens,
  catalogModelCapacity,
  resolveModel,
  validateModelSelection,
} from "./model-catalog.ts"
import type { ModelSystemSection, ModelTarget } from "./model.ts"
import { getPrompt } from "./prompt-registry.ts"

export type ApprovalPolicy = "auto_file_tools" | "never"

type ResolvedSessionConfigurationSnapshot = Omit<
  SessionConfigurationSnapshot,
  "runtimeLimits"
> & {
  readonly runtimeLimits: RuntimeLimitsType
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
  baseInstructions: ModelSystemSection
  modelInstructions: ModelSystemSection
  workspaceRoot: string
  enabledTools: readonly string[]
  approvalPolicy: ApprovalPolicy
  limits: RuntimeLimitsType
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
    readonly limits?: RuntimeLimitsType
    readonly modelContextWindowTokens?: number
  }): SessionConfiguration {
    validateModelSelection(input.selection)
    const model = resolveModel(input.selection)
    const prompt = getPrompt(model.promptId)
    validateContextWindowOverride(model, input.modelContextWindowTokens)
    return new SessionConfiguration({
      schemaVersion: 1,
      workspaceRoot: input.workspaceRoot,
      defaultTarget: { ...input.selection },
      baseInstructions: {
        text: prompt.text,
        revision: prompt.revision,
        provenance: {
          type: "model",
          provider: model.provider,
          model: model.model,
          promptId: model.promptId,
        },
      },
      enabledTools: [...input.enabledTools],
      approvalPolicy: input.approvalPolicy,
      runtimeLimits: { ...(input.limits ?? createRuntimeLimits()) },
      ...(input.modelContextWindowTokens === undefined
        ? {}
        : { modelContextWindowTokens: input.modelContextWindowTokens }),
    })
  }

  static restore(snapshot: SessionConfigurationSnapshot): SessionConfiguration {
    const runtimeLimits = requireRuntimeLimits(snapshot.runtimeLimits)
    const model = resolveModel(snapshot.defaultTarget)
    validateContextWindowOverride(model, snapshot.modelContextWindowTokens)
    return new SessionConfiguration({
      ...snapshot,
      defaultTarget: { ...snapshot.defaultTarget },
      baseInstructions: {
        ...snapshot.baseInstructions,
        provenance: { ...snapshot.baseInstructions.provenance },
      },
      enabledTools: [...snapshot.enabledTools],
      runtimeLimits,
    })
  }

  resolveTurn(selection: ModelSelection): ResolvedTurnConfiguration {
    validateModelSelection(selection)
    const model = resolveModel(selection)
    validateContextWindowOverride(model, this.snapshot.modelContextWindowTokens)
    const prompt = getPrompt(model.promptId)
    const modelCapacity = resolveModelCapacity(
      model,
      this.snapshot.modelContextWindowTokens,
    )
    return {
      target: {
        provider: model.provider,
        model: model.model,
        promptId: model.promptId,
        ...(selection.effort === undefined ? {} : { effort: selection.effort }),
        ...(selection.speed === undefined ? {} : { speed: selection.speed }),
      },
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
      limits: requireRuntimeLimits(this.snapshot.runtimeLimits),
      ...(modelCapacity === undefined ? {} : { modelCapacity }),
    }
  }
}

export function createTurnContext(input: {
  readonly configuration: ResolvedTurnConfiguration
  readonly mateId: string
  readonly mateRevisionId: string
}): TurnContext {
  const limits = turnExecutionLimits(input.configuration)
  const capacity = input.configuration.modelCapacity
  return {
    configuration: input.configuration,
    execution: {
      mateId: input.mateId,
      mateRevisionId: input.mateRevisionId,
      provider: input.configuration.target.provider,
      model: input.configuration.target.model,
      promptId: input.configuration.target.promptId,
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
      limits,
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

function requireRuntimeLimits(
  value: SessionConfigurationSnapshot["runtimeLimits"],
): RuntimeLimitsType {
  const keys = new Set(Object.keys(RuntimeLimits))
  if (Object.keys(value).some((key) => !keys.has(key))) {
    throw new Error("Session configuration contains invalid runtime limits.")
  }
  return createRuntimeLimits(value as Partial<RuntimeLimitsType>)
}

function turnExecutionLimits(
  configuration: ResolvedTurnConfiguration,
): TurnExecutionLimits {
  const limits = configuration.limits
  const modelVisibleContextBytes =
    configuration.modelCapacity === undefined ||
    limits.modelVisibleContextBytes !== RuntimeLimits.modelVisibleContextBytes
      ? limits.modelVisibleContextBytes
      : deriveModelVisibleContextBytes(
          configuration.modelCapacity.effectiveContextWindowTokens,
        )
  const compaction = deriveCompactionContextBytes({
    modelVisibleContextBytes,
    triggerRatio: limits.compactionTriggerRatio,
    retainRatio: limits.compactionRetainRatio,
  })
  return {
    modelCallsPerTurn: limits.modelCallsPerTurn,
    toolCallsPerTurn: limits.toolCallsPerTurn,
    modelVisibleMessageBlocks: limits.modelVisibleMessageBlocks,
    modelVisibleContextBytes,
    compactionTriggerContextBytes: compaction.triggerBytes,
    compactionRetainContextBytes: compaction.retainBytes,
    modelVisibleToolResultBytes: limits.modelVisibleToolResultBytes,
    modelVisibleToolResultLines: limits.modelVisibleToolResultLines,
    assistantResponseBytes: limits.assistantResponseBytes,
  }
}
