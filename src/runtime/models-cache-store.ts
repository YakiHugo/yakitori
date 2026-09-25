import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type {
  DiscoveredModel,
  ModelsCacheStore,
  PersistedModelsCache,
} from "./models-manager.ts"

// Per-provider file store for the discovered model catalog
// (<storeDir>/models-cache/<provider>.json). Writes go through a temp file and
// rename so a concurrent reader never sees a partial document.
export function createFileModelsCacheStore(input: {
  readonly provider: string
  readonly directory: string
}): ModelsCacheStore {
  const path = join(input.directory, `${input.provider}.json`)
  return {
    async load() {
      let raw: string
      try {
        raw = await readFile(path, "utf8")
      } catch {
        // A missing or unreadable cache is a normal cold start.
        return undefined
      }
      try {
        const parsed: unknown = JSON.parse(raw)
        return isPersistedModelsCache(parsed) ? parsed : undefined
      } catch {
        return undefined
      }
    },
    async save(entry) {
      await mkdir(input.directory, { recursive: true })
      const temporary = `${path}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify(entry))
      await rename(temporary, path)
    },
  }
}

function isPersistedModelsCache(value: unknown): value is PersistedModelsCache {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  if (typeof record.fetchedAt !== "number" || !Number.isFinite(record.fetchedAt))
    return false
  if (record.identity !== undefined && typeof record.identity !== "string")
    return false
  if (!Array.isArray(record.models)) return false
  return record.models.every(
    (model): model is DiscoveredModel =>
      typeof model === "object" &&
      model !== null &&
      typeof (model as Record<string, unknown>).id === "string",
  )
}
