import { DEFAULT_MESSAGES_MAX_OUTPUT_TOKENS } from "./model.ts"
import {
  type CatalogModel,
  catalogModelCapacity,
  listCatalogModels,
  type ModelCapacity,
  type ResolvedModel,
  requireInstructionProfileId,
  resolveFallbackModel,
  resolveModel,
} from "./model-catalog.ts"
import { mergeModelEfforts } from "./model-effort.ts"
import { isChatModel, NonChatModelError } from "./model-kind.ts"
import { modelVisibleByDefault } from "./model-policy.ts"
import type { ModelSelectionInput, ModelsManager } from "./models-manager.ts"
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
    if (!isChatModel(configured)) continue
    if (configured.id.trim() === "" || models.has(configured.id)) {
      throw new Error(
        `Invalid or duplicate configured model ID: ${configured.id}`,
      )
    }
    const known = catalog.get(configured.id)
    let resolved: ResolvedModel = {
      ...(input.catalogProvider === undefined
        ? resolveFallbackModel({
            provider: input.provider,
            model: configured.id,
          })
        : resolveModel({
            provider: input.catalogProvider,
            model: configured.id,
          })),
      provider: input.provider,
      model: configured.id,
      ...(configured.instructionProfileId === undefined
        ? {}
        : {
            instructionProfileId: requireInstructionProfileId(
              configured.instructionProfileId,
            ),
          }),
      ...(configured.inputModalities === undefined
        ? {}
        : { inputModalities: [...configured.inputModalities] }),
      ...(configured.imageDetailModes === undefined
        ? {}
        : { imageDetailModes: configured.imageDetailModes }),
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
    resolved = mergeModelEfforts(resolved, configured, input.provider)
    const { efforts } = resolved
    const { provider: _, usedFallbackModelMetadata: __, ...metadata } = resolved
    const listed: CatalogModel = {
      ...metadata,
      visible:
        configured.visible ??
        modelVisibleByDefault(
          input.catalogProvider ?? input.provider,
          configured.id,
          configured.defaultVisible,
        ),
      ...(configured.displayName === undefined
        ? known?.displayName === undefined
          ? {}
          : { displayName: known.displayName }
        : { displayName: configured.displayName }),
      ...(efforts === undefined
        ? {}
        : {
            efforts: [...efforts],
            effortStyle:
              efforts.length === 0 ? ("none" as const) : ("levels" as const),
          }),
      ...(configured.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: configured.contextWindowTokens }),
      ...(configured.contextWindowScope === undefined
        ? {}
        : { contextWindowScope: configured.contextWindowScope }),
      ...(configured.pricing === undefined
        ? {}
        : { pricing: configured.pricing }),
      ...(configured.speeds !== undefined
        ? { speeds: configured.speeds }
        : known?.speeds === undefined ||
            (input.wireApi !== undefined &&
              input.wireApi !== "openai_responses")
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
            maxContextWindowTokens:
              configured.maxContextWindowTokens ??
              configured.contextWindowTokens,
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
    const configured = input.models.find(
      (model) => model.id.toLowerCase() === selection.model.toLowerCase(),
    )
    if (configured && !isChatModel(configured))
      throw new NonChatModelError(input.provider, selection.model)
    const model = models.get(selection.model)
    if (model === undefined) {
      throw new ModelNotConfiguredError(input.provider, selection.model)
    }
    return model
  }

  return {
    provider: input.provider,
    async refresh() {},
    async listModels(options) {
      return [...models.values()]
        .map((model) => model.listed)
        .filter((model) => options?.includeHidden || model.visible !== false)
    },
    resolve(selection) {
      return requireModel(selection).resolved
    },
    validate(selection) {
      const model = requireModel(selection).listed
      if (
        selection.effort !== undefined &&
        model.efforts !== undefined &&
        !model.efforts.includes(selection.effort)
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
