import {
  catalogModelCapacity,
  type InstructionProfileId,
  listCatalogModels,
  type ProviderRegistry,
} from "../runtime/index.ts"

export type DirectoryModel = {
  readonly id: string
  readonly displayName: string
  readonly instructionProfileId: InstructionProfileId
  readonly effectiveContextWindowTokens?: number
  readonly effortStyle?: "none" | "levels"
  readonly efforts?: readonly string[]
  readonly defaultEffort?: string
  readonly speeds?: readonly string[]
  readonly inputModalities?: readonly ("image" | "text" | "video")[]
  readonly imageDetailModes?: readonly ("high" | "original")[]
}

export type ModelDirectory = {
  listModels(provider: string): Promise<readonly DirectoryModel[]>
}

export function createModelDirectory(
  providerRegistry?: ProviderRegistry,
): ModelDirectory {
  return {
    async listModels(provider) {
      const manager = providerRegistry?.models(provider)
      const models =
        manager === undefined
          ? listCatalogModels(provider)
          : await manager.listModels()
      return models.map((entry) => {
        const capacity = (manager?.capacity ?? catalogModelCapacity)({
          provider,
          model: entry.model,
        })
        return {
          id: entry.model,
          displayName: entry.displayName ?? entry.model,
          instructionProfileId: entry.instructionProfileId,
          ...(capacity === undefined
            ? {}
            : {
                effectiveContextWindowTokens: Math.floor(
                  (capacity.contextWindowTokens *
                    capacity.effectiveContextWindowPercent) /
                    100,
                ),
              }),
          ...(entry.effortStyle === undefined
            ? {}
            : { effortStyle: entry.effortStyle }),
          ...(entry.efforts === undefined ? {} : { efforts: entry.efforts }),
          ...(entry.defaultEffort === undefined
            ? {}
            : { defaultEffort: entry.defaultEffort }),
          ...(entry.speeds === undefined ? {} : { speeds: entry.speeds }),
          inputModalities: entry.inputModalities,
          imageDetailModes: entry.imageDetailModes,
        }
      })
    },
  }
}
