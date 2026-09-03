import {
  catalogModelCapacity,
  type CatalogModel,
  listCatalogModels,
  type ModelCapacity,
  type ResolvedModel,
  resolveModel,
  validateModelSelection,
} from "./model-catalog.ts"

export type ModelSelectionInput = Readonly<{
  provider: string
  model: string
  effort?: string
  speed?: string
}>

// Mirrors Codex's ModelsManager boundary: callers read one provider-scoped
// catalog owner instead of consulting the bundled catalog independently.
// Static managers are the fallback for providers without a discovery API.
export type ModelsManager = {
  readonly provider: string
  listModels(): Promise<readonly CatalogModel[]>
  resolve(selection: ModelSelectionInput): ResolvedModel
  validate(selection: ModelSelectionInput): void
  capacity(selection: ModelSelectionInput): ModelCapacity | undefined
}

export function createStaticModelsManager(provider: string): ModelsManager {
  return {
    provider,
    async listModels() {
      return listCatalogModels(provider)
    },
    resolve(selection) {
      requireProvider(provider, selection.provider)
      return resolveModel(selection)
    },
    validate(selection) {
      requireProvider(provider, selection.provider)
      validateModelSelection(selection)
    },
    capacity(selection) {
      requireProvider(provider, selection.provider)
      return catalogModelCapacity(selection)
    },
  }
}

function requireProvider(expected: string, actual: string): void {
  if (actual !== expected) {
    throw new Error(
      `Models manager for ${expected} cannot resolve provider ${actual}.`,
    )
  }
}
