import {
  catalogModelCapacity,
  type CatalogModel,
  listCatalogModels,
  type ModelCapacity,
  type ResolvedModel,
  resolveModel,
} from "./model-catalog.ts"
import type { ModelsManager, ModelSelectionInput } from "./models-manager.ts"
import { DEFAULT_MESSAGES_MAX_OUTPUT_TOKENS } from "./model.ts"
import type { ConfiguredModel, ProviderPreset } from "./provider-presets.ts"

export class ModelNotConfiguredError extends Error {
  constructor(provider: string, model: string) {
    super(`Model ${model} is not configured for ${provider}.`)
  }
}

// Provider connections own credentials and endpoints. This manager owns only
// their configured model directory; catalogProvider supplies exact known model
// metadata without replacing the connection ID used to route requests.
export function createConfiguredModelsManager(input: {
  provider: string
  catalogProvider?: string
  wireApi?: ProviderPreset["wireApi"]
  models: readonly ConfiguredModel[]
}): ModelsManager {
  const catalog = new Map(
    (input.catalogProvider === undefined
      ? []
      : listCatalogModels(input.catalogProvider)
    ).map((model) => [model.model, model]),
  )
  const models = new Map<
    string,
    {
      resolved: ResolvedModel
      listed: CatalogModel
      capacity: ModelCapacity | undefined
    }
  >()
  for (const configured of input.models) {
    if (configured.id.trim() === "" || models.has(configured.id)) {
      throw new Error(
        `Invalid or duplicate configured model ID: ${configured.id}`,
      )
    }
    const known = catalog.get(configured.id)
    let resolved: ResolvedModel = {
      ...(known === undefined || input.catalogProvider === undefined
        ? {
            instructionProfileId: "default",
            inputModalities: ["text"],
            imageDetailModes: [],
            // These are Yakitori's tools, not a claim about vendor capabilities.
            shellToolType: "unified_exec",
            fileEditingToolType: "edit_write",
            supportsNativeToolSearch: false,
            supportsCustomTools: false,
            usedFallbackModelMetadata: true,
          }
        : resolveModel({
            provider: input.catalogProvider,
            model: configured.id,
          })),
      provider: input.provider,
      model: configured.id,
      ...(configured.instructionProfileId === undefined
        ? {}
        : { instructionProfileId: configured.instructionProfileId }),
      ...(configured.inputModalities === undefined
        ? {}
        : { inputModalities: [...configured.inputModalities] }),
      ...(configured.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: configured.maxOutputTokens }),
    }
    if (input.wireApi !== undefined) {
      // Native schemas need both the wire protocol and the vendor's confirmed
      // implementation. grok-build Responses currently uses FunctionTool only.
      const nativeResponses =
        input.wireApi === "openai_responses" &&
        input.catalogProvider === "openai" &&
        known !== undefined
      const nativeMessages =
        input.wireApi === "anthropic_messages" &&
        input.catalogProvider === "anthropic" &&
        known !== undefined
      const { applyPatchToolType, ...protocolModel } = resolved
      resolved = {
        ...protocolModel,
        ...(nativeResponses && applyPatchToolType !== undefined
          ? { applyPatchToolType }
          : {}),
        fileEditingToolType:
          input.wireApi !== "openai_responses" ||
          (applyPatchToolType !== undefined && !nativeResponses)
            ? "edit_write"
            : resolved.fileEditingToolType,
        supportsNativeToolSearch:
          (nativeResponses || nativeMessages) &&
          resolved.supportsNativeToolSearch,
        supportsCustomTools: nativeResponses && resolved.supportsCustomTools,
      }
    }
    if (input.wireApi === "anthropic_messages") {
      // Messages requires max_tokens. Resolve the harness request budget here
      // so Session admission reserves the same output space as the adapter.
      resolved = {
        ...resolved,
        defaultOutputTokens: Math.min(
          resolved.defaultOutputTokens ?? DEFAULT_MESSAGES_MAX_OUTPUT_TOKENS,
          resolved.maxOutputTokens ?? Number.POSITIVE_INFINITY,
        ),
      }
    }
    const efforts = configured.efforts ?? known?.efforts ?? []
    const defaultEffort =
      configured.defaultEffort ??
      (known?.defaultEffort !== undefined &&
      efforts.includes(known.defaultEffort)
        ? known.defaultEffort
        : undefined)
    if (defaultEffort !== undefined && !efforts.includes(defaultEffort)) {
      throw new Error(
        `Default effort ${defaultEffort} is not supported by ${input.provider}/${configured.id}.`,
      )
    }
    const { provider: _, usedFallbackModelMetadata: __, ...metadata } = resolved
    const listed: CatalogModel = {
      ...metadata,
      ...(configured.displayName === undefined
        ? known?.displayName === undefined
          ? {}
          : { displayName: known.displayName }
        : { displayName: configured.displayName }),
      efforts: [...efforts],
      effortStyle: efforts.length === 0 ? "none" : "levels",
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
      ...(known?.speeds === undefined ||
      (input.wireApi !== undefined && input.wireApi !== "openai_responses")
        ? {}
        : { speeds: [...known.speeds] }),
    }
    const capacity =
      configured.contextWindowTokens === undefined
        ? known === undefined || input.catalogProvider === undefined
          ? undefined
          : catalogModelCapacity({
              provider: input.catalogProvider,
              model: configured.id,
            })
        : {
            contextWindowTokens: configured.contextWindowTokens,
            maxContextWindowTokens: configured.contextWindowTokens,
            effectiveContextWindowPercent: 100,
            contextWindowScope: configured.contextWindowScope ?? "total",
          }
    models.set(configured.id, { resolved, listed, capacity })
  }

  const requireModel = (selection: ModelSelectionInput) => {
    if (selection.provider !== input.provider) {
      throw new Error(
        `Models manager for ${input.provider} cannot resolve provider ${selection.provider}.`,
      )
    }
    const model = models.get(selection.model)
    if (model === undefined) {
      throw new ModelNotConfiguredError(input.provider, selection.model)
    }
    return model
  }

  return {
    provider: input.provider,
    async refresh() {},
    async listModels() {
      return [...models.values()].map((model) => model.listed)
    },
    resolve(selection) {
      return requireModel(selection).resolved
    },
    validate(selection) {
      const model = requireModel(selection).listed
      if (
        selection.effort !== undefined &&
        !model.efforts?.includes(selection.effort)
      ) {
        throw new Error(
          `Reasoning effort ${selection.effort} is not supported by ${input.provider}/${selection.model}.`,
        )
      }
      if (
        selection.speed !== undefined &&
        !model.speeds?.includes(selection.speed)
      ) {
        throw new Error(
          `Speed ${selection.speed} is not supported by ${input.provider}/${selection.model}.`,
        )
      }
    },
    capacity(selection) {
      return requireModel(selection).capacity
    },
  }
}
