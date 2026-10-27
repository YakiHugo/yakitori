import type { ProviderModelSettings } from "../protocol/providers.ts"
import { ModelNotConfiguredError } from "./configured-models-manager.ts"
import {
  type EffectiveModel,
  effectiveModelCapacity,
  effectiveModelDirectory,
  mergeEffectiveModel,
  validateEffectiveModel,
} from "./effective-model.ts"
import { type CatalogModel, resolveFallbackModel } from "./model-catalog.ts"
import { NonChatModelError } from "./model-kind.ts"
import {
  captureModelsManager,
  type ModelSelectionInput,
  type ModelsManager,
} from "./models-manager.ts"

// Settings project the same effective record for listing and execution. They
// never mutate provider discovery data or the provider's persisted catalog.
export function createModelSettingsManager(
  source: ModelsManager,
  settings: () => ProviderModelSettings,
): ModelsManager {
  const configuration = (id: string) =>
    Object.entries(settings()).find(
      ([key]) => key.toLowerCase() === id.toLowerCase(),
    )?.[1]
  const effective = (
    selection: ModelSelectionInput,
    listed?: CatalogModel,
    models = source,
  ): EffectiveModel => {
    const configured = configuration(selection.model)
    let base: EffectiveModel
    try {
      base = {
        ...(listed === undefined
          ? models.resolve(selection)
          : { ...resolveFallbackModel(selection), ...listed }),
        ...models.capacity(selection),
      }
    } catch (error) {
      if (!(error instanceof ModelNotConfiguredError) || !configured)
        throw error
      base = resolveFallbackModel(selection)
    }
    return applySettings(base, configured)
  }
  const applySettings = (
    base: EffectiveModel,
    configured: ProviderModelSettings[string] | undefined,
  ): EffectiveModel => {
    // User request budgets may narrow an authoritative model limit; editing
    // settings cannot grant a larger window or output limit to that backend.
    const output = configured?.maxOutputTokens
    const window = configured?.contextWindowTokens
    const maximum = configured?.maxContextWindowTokens ?? window
    const maxContextWindowTokens =
      maximum === undefined
        ? base.maxContextWindowTokens
        : Math.min(
            maximum,
            base.maxContextWindowTokens ?? Number.POSITIVE_INFINITY,
          )
    const contextWindowTokens =
      window === undefined && configured?.maxContextWindowTokens === undefined
        ? undefined
        : Math.min(
            window ?? base.contextWindowTokens ?? Number.POSITIVE_INFINITY,
            maxContextWindowTokens ?? Number.POSITIVE_INFINITY,
          )
    return mergeEffectiveModel(base, {
      ...configured,
      ...(output === undefined
        ? {}
        : {
            maxOutputTokens: Math.min(
              output,
              base.maxOutputTokens ?? Number.POSITIVE_INFINITY,
            ),
          }),
      ...(contextWindowTokens === undefined ||
      !Number.isFinite(contextWindowTokens)
        ? {}
        : { contextWindowTokens, effectiveContextWindowPercent: 100 }),
      ...(maxContextWindowTokens === undefined
        ? {}
        : { maxContextWindowTokens }),
    })
  }

  return {
    provider: source.provider,
    refresh: (options) => source.refresh(options),
    capture: () => {
      const captured = structuredClone(settings())
      return createModelSettingsManager(
        captureModelsManager(source),
        () => captured,
      )
    },
    ...(source.subscribe ? { subscribe: source.subscribe.bind(source) } : {}),
    ...(source.status ? { status: source.status.bind(source) } : {}),
    async listModels(options) {
      const snapshot = captureModelsManager(source)
      const listed = await snapshot.listModels({ includeHidden: true })
      const byId = new Map(
        listed.map((model) => [model.model.toLowerCase(), model]),
      )
      for (const id of Object.keys(settings())) {
        if (byId.has(id.toLowerCase())) continue
        try {
          byId.set(
            id.toLowerCase(),
            effectiveModelDirectory(
              effective(
                { provider: source.provider, model: id },
                undefined,
                snapshot,
              ),
            ),
          )
        } catch (error) {
          if (error instanceof NonChatModelError) continue
          throw error
        }
      }
      return [...byId.values()]
        .map((model) => ({
          ...effectiveModelDirectory(
            effective(
              { provider: source.provider, model: model.model },
              model,
              snapshot,
            ),
          ),
          visible: configuration(model.model)?.visible ?? model.visible ?? true,
        }))
        .filter((model) => options?.includeHidden || model.visible)
    },
    resolve: effective,
    validate: (selection) =>
      validateEffectiveModel(effective(selection), selection),
    capacity(selection) {
      const configured = configuration(selection.model)
      let capacity: ReturnType<ModelsManager["capacity"]>
      try {
        capacity = source.capacity(selection)
      } catch (error) {
        if (!(error instanceof ModelNotConfiguredError) || !configured)
          throw error
      }
      return effectiveModelCapacity(
        applySettings(
          { ...resolveFallbackModel(selection), ...capacity },
          configured,
        ),
      )
    },
  }
}
