import {
  type EffectiveModel,
  effectiveModelCapacity,
  effectiveModelDirectory,
  mergeEffectiveModel,
  validateEffectiveModel,
} from "./effective-model.ts"
import { DEFAULT_MESSAGES_MAX_OUTPUT_TOKENS } from "./model.ts"
import {
  catalogModelCapacity,
  listCatalogModels,
  type ResolvedModel,
  resolveFallbackModel,
  resolveModel,
} from "./model-catalog.ts"
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
  const configuredModels = structuredClone(input.models)
  const catalog = new Map(
    (input.catalogProvider === undefined
      ? []
      : listCatalogModels(input.catalogProvider)
    ).map((model) => [model.model, model]),
  )
  const models = new Map<string, EffectiveModel>()
  for (const configured of configuredModels) {
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
    }
    resolved = mergeEffectiveModel(resolved, configured)
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
    if (
      configured.speeds === undefined &&
      input.wireApi !== undefined &&
      input.wireApi !== "openai_responses"
    ) {
      const { speeds: _, ...withoutInheritedSpeeds } = resolved
      resolved = withoutInheritedSpeeds
    }
    const {
      applyPatchToolType: _,
      speeds: knownSpeeds,
      ...knownMetadata
    } = known ?? {}
    const effective = mergeEffectiveModel(
      {
        ...knownMetadata,
        ...(knownSpeeds === undefined ||
        (input.wireApi !== undefined && input.wireApi !== "openai_responses")
          ? {}
          : { speeds: knownSpeeds }),
        ...resolved,
        ...(known === undefined || input.catalogProvider === undefined
          ? {}
          : catalogModelCapacity({
              provider: input.catalogProvider,
              model: configured.id,
            })),
        visible:
          configured.visible ??
          modelVisibleByDefault(
            input.catalogProvider ?? input.provider,
            configured.id,
            configured.defaultVisible,
          ),
      },
      configured,
    )
    models.set(configured.id, effective)
  }

  const requireModel = (selection: ModelSelectionInput) => {
    if (selection.provider !== input.provider) {
      throw new Error(
        `Models manager for ${input.provider} cannot resolve provider ${selection.provider}.`,
      )
    }
    const configured = configuredModels.find(
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

  const manager: ModelsManager = {
    provider: input.provider,
    capture: () => manager,
    async refresh() {},
    async listModels(options) {
      return [...models.values()]
        .map(effectiveModelDirectory)
        .filter((model) => options?.includeHidden || model.visible !== false)
    },
    resolve(selection) {
      return requireModel(selection)
    },
    validate(selection) {
      validateEffectiveModel(requireModel(selection), selection)
    },
    capacity(selection) {
      return effectiveModelCapacity(requireModel(selection))
    },
  }
  return manager
}
