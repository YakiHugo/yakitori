import type { ProviderModelSettings } from "../protocol/providers.ts"
import { ModelNotConfiguredError } from "./configured-models-manager.ts"
import {
  type CatalogModel,
  type ResolvedModel,
  requireInstructionProfileId,
  resolveModel,
} from "./model-catalog.ts"
import { mergeModelEfforts } from "./model-effort.ts"
import { NonChatModelError } from "./model-kind.ts"
import type { ModelSelectionInput, ModelsManager } from "./models-manager.ts"

// Provider managers apply Yakitori's execution defaults. This final projection
// applies user choices without changing the provider's catalog or its cache.
export function createModelSettingsManager(
  source: ModelsManager,
  settings: () => ProviderModelSettings,
): ModelsManager {
  const configuration = (id: string) =>
    Object.entries(settings()).find(
      ([key]) => key.toLowerCase() === id.toLowerCase(),
    )?.[1]
  const resolve = (selection: ModelSelectionInput): ResolvedModel => {
    let base: ResolvedModel
    try {
      base = source.resolve(selection)
    } catch (error) {
      if (
        !(error instanceof ModelNotConfiguredError) ||
        configuration(selection.model) === undefined
      )
        throw error
      base = resolveModel(selection)
    }
    const configured = configuration(selection.model)
    if (!configured) return base
    const result: ResolvedModel = {
      ...base,
      ...(configured.instructionProfileId === undefined
        ? {}
        : {
            instructionProfileId: requireInstructionProfileId(
              configured.instructionProfileId,
            ),
          }),
      ...(configured.inputModalities === undefined
        ? {}
        : { inputModalities: configured.inputModalities }),
      ...(configured.imageDetailModes === undefined
        ? {}
        : { imageDetailModes: configured.imageDetailModes }),
      ...(configured.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: configured.maxOutputTokens }),
    }
    return mergeModelEfforts(result, configured, selection.provider)
  }
  return {
    provider: source.provider,
    refresh: (options) => source.refresh(options),
    ...(source.subscribe ? { subscribe: source.subscribe.bind(source) } : {}),
    ...(source.status ? { status: source.status.bind(source) } : {}),
    async listModels(options) {
      const listed = await source.listModels({ includeHidden: true })
      const byId = new Map(
        listed.map((model) => [model.model.toLowerCase(), model]),
      )
      for (const id of Object.keys(settings())) {
        if (!byId.has(id.toLowerCase())) {
          let resolved: ResolvedModel
          try {
            resolved = resolve({ provider: source.provider, model: id })
          } catch (error) {
            if (error instanceof NonChatModelError) continue
            throw error
          }
          const {
            provider: _,
            usedFallbackModelMetadata: __,
            ...metadata
          } = resolved
          byId.set(id.toLowerCase(), metadata)
        }
      }
      return [...byId.values()]
        .map((model): CatalogModel => {
          const configured = configuration(model.model)
          const {
            instructionProfileId: _,
            efforts: __,
            defaultEffort: ___,
            ...override
          } = configured ?? {}
          const result = {
            ...mergeModelEfforts(model, configured ?? {}, source.provider),
            ...override,
            visible: configured?.visible ?? model.visible ?? true,
          }
          if (result.efforts !== undefined) {
            result.effortStyle = result.efforts.length ? "levels" : "none"
          }
          return result
        })
        .filter((model) => options?.includeHidden || model.visible)
    },
    resolve,
    validate(selection) {
      const configured = configuration(selection.model)
      if (!configured) return source.validate(selection)
      const { effort, speed, ...identity } = selection
      try {
        source.validate(identity)
      } catch (error) {
        if (!(error instanceof ModelNotConfiguredError)) throw error
      }
      const model = resolve(selection)
      if (
        effort !== undefined &&
        model.efforts !== undefined &&
        !model.efforts.includes(effort)
      )
        throw new Error(
          `Reasoning effort ${effort} is not supported by ${selection.provider}/${selection.model}.`,
        )
      if (
        speed !== undefined &&
        configured.speeds !== undefined &&
        !configured.speeds.includes(speed)
      )
        throw new Error(
          `Speed ${speed} is not supported by ${selection.provider}/${selection.model}.`,
        )
      // Only overridden fields bypass the source's validation.
      const inherited = {
        ...identity,
        ...(configured.efforts === undefined && effort !== undefined
          ? { effort }
          : {}),
        ...(configured.speeds === undefined && speed !== undefined
          ? { speed }
          : {}),
      }
      try {
        source.validate(inherited)
      } catch (error) {
        if (!(error instanceof ModelNotConfiguredError)) throw error
      }
    },
    capacity(selection) {
      const configured = configuration(selection.model)
      let base: ReturnType<ModelsManager["capacity"]>
      try {
        base = source.capacity(selection)
      } catch (error) {
        if (!(error instanceof ModelNotConfiguredError) || !configured)
          throw error
      }
      if (configured?.contextWindowTokens === undefined)
        return base === undefined
          ? undefined
          : {
              ...base,
              ...(configured?.maxContextWindowTokens === undefined
                ? {}
                : {
                    maxContextWindowTokens: configured.maxContextWindowTokens,
                  }),
              ...(configured?.contextWindowScope === undefined
                ? {}
                : { contextWindowScope: configured.contextWindowScope }),
            }
      return {
        contextWindowTokens: configured.contextWindowTokens,
        maxContextWindowTokens:
          configured.maxContextWindowTokens ?? configured.contextWindowTokens,
        effectiveContextWindowPercent: 100,
        contextWindowScope:
          configured.contextWindowScope ?? base?.contextWindowScope ?? "total",
      }
    },
  }
}
