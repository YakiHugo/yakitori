import {
  type InstructionProfileId,
  listCatalogModels,
} from "../runtime/index.ts"

export type DirectoryModel = {
  readonly id: string
  readonly displayName: string
  readonly instructionProfileId: InstructionProfileId
  readonly effortStyle?: "none" | "levels"
  readonly efforts?: readonly string[]
  readonly speeds?: readonly string[]
  readonly inputModalities?: readonly ("image" | "text" | "video")[]
  readonly imageDetailModes?: readonly ("high" | "original")[]
}

export type ModelDirectory = {
  listModels(provider: string): Promise<readonly DirectoryModel[]>
}

export function createModelDirectory(): ModelDirectory {
  return {
    async listModels(provider) {
      return listCatalogModels(provider).map((entry) => ({
        id: entry.model,
        displayName: entry.displayName ?? entry.model,
        instructionProfileId: entry.instructionProfileId,
        ...(entry.effortStyle === undefined
          ? {}
          : { effortStyle: entry.effortStyle }),
        ...(entry.efforts === undefined ? {} : { efforts: entry.efforts }),
        ...(entry.speeds === undefined ? {} : { speeds: entry.speeds }),
        inputModalities: entry.inputModalities,
        imageDetailModes: entry.imageDetailModes,
      }))
    },
  }
}
