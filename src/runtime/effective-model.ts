import type { ConfiguredModel } from "../protocol/providers.ts"
import {
  type CatalogModel,
  type ModelCapabilities,
  type ModelCapacity,
  type ModelToolOutputTruncation,
  type ResolvedModel,
  requireInstructionProfileId,
} from "./model-catalog.ts"
import { mergeModelEfforts } from "./model-effort.ts"
import type { ModelSelectionInput } from "./models-manager.ts"

// One published record supplies both execution facts and the model directory.
// Projections below must not merge a second, independently resolved model.
export type EffectiveModel = Readonly<
  ResolvedModel &
    Pick<
      CatalogModel,
      | "visible"
      | "displayName"
      | "speeds"
      | "contextWindowTokens"
      | "maxContextWindowTokens"
      | "contextWindowScope"
      | "pricing"
    > & { effectiveContextWindowPercent?: number }
>

type ModelOverride = Partial<ConfiguredModel> &
  Readonly<{
    capabilities?: ModelCapabilities
    instructions?: string
    toolOutputTruncation?: ModelToolOutputTruncation
    autoCompactTokenLimit?: number
    compactionHash?: string
    effectiveContextWindowPercent?: number
  }>

export function mergeEffectiveModel(
  base: EffectiveModel,
  override: ModelOverride,
): EffectiveModel {
  const result = mergeModelEfforts(
    {
      ...base,
      ...override.capabilities,
      ...(override.contextWindowTokens === undefined
        ? {}
        : {
            maxContextWindowTokens:
              override.maxContextWindowTokens ?? override.contextWindowTokens,
            effectiveContextWindowPercent:
              override.effectiveContextWindowPercent ?? 100,
          }),
      ...(override.instructionProfileId === undefined
        ? {}
        : {
            instructionProfileId: requireInstructionProfileId(
              override.instructionProfileId,
            ),
          }),
      ...Object.fromEntries(
        [
          "visible",
          "displayName",
          "speeds",
          "contextWindowTokens",
          "maxContextWindowTokens",
          "contextWindowScope",
          "pricing",
          "maxOutputTokens",
          "inputModalities",
          "imageDetailModes",
          "instructions",
          "toolOutputTruncation",
          "autoCompactTokenLimit",
          "compactionHash",
          "effectiveContextWindowPercent",
        ].flatMap((key) => {
          const value = override[key as keyof ModelOverride]
          return value === undefined ? [] : [[key, value]]
        }),
      ),
    },
    override,
    base.provider,
  )
  if (
    override.capabilities !== undefined &&
    override.capabilities.applyPatchToolType === undefined
  )
    delete result.applyPatchToolType
  if (
    result.maxOutputTokens !== undefined &&
    result.defaultOutputTokens !== undefined
  )
    result.defaultOutputTokens = Math.min(
      result.defaultOutputTokens,
      result.maxOutputTokens,
    )
  return result
}

export function effectiveModelDirectory(model: EffectiveModel): CatalogModel {
  const {
    provider: _,
    usedFallbackModelMetadata: __,
    instructions: ___,
    effectiveContextWindowPercent: ____,
    ...metadata
  } = model
  return {
    ...metadata,
    ...(model.efforts === undefined
      ? {}
      : { effortStyle: model.efforts.length ? "levels" : "none" }),
  }
}

export function effectiveModelCapacity(
  model: EffectiveModel,
): ModelCapacity | undefined {
  if (model.contextWindowTokens === undefined) return undefined
  return {
    contextWindowTokens: model.contextWindowTokens,
    maxContextWindowTokens:
      model.maxContextWindowTokens ?? model.contextWindowTokens,
    effectiveContextWindowPercent: model.effectiveContextWindowPercent ?? 100,
    contextWindowScope: model.contextWindowScope ?? "total",
  }
}

export function validateEffectiveModel(
  model: EffectiveModel,
  selection: ModelSelectionInput,
): void {
  if (
    selection.effort !== undefined &&
    model.efforts !== undefined &&
    !model.efforts.includes(selection.effort)
  )
    throw new Error(
      `Reasoning effort ${selection.effort} is not supported by ${selection.provider}/${selection.model}.`,
    )
  if (selection.speed !== undefined && !model.speeds?.includes(selection.speed))
    throw new Error(
      `Speed ${selection.speed} is not supported by ${selection.provider}/${selection.model}.`,
    )
}
