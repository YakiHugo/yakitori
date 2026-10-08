import { randomUUID } from "node:crypto"
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
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
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
  if (
    typeof record.fetchedAt !== "number" ||
    !Number.isFinite(record.fetchedAt)
  )
    return false
  if (record.identity !== undefined && typeof record.identity !== "string")
    return false
  if (!Array.isArray(record.models)) return false
  return record.models.every(isDiscoveredModel)
}

// The cache is an external JSON boundary, just like the discovery response.
// Never assert the full model contract after checking only its ID: malformed
// optional fields otherwise bypass discovery validation on a warm start.
function isDiscoveredModel(value: unknown): value is DiscoveredModel {
  if (!isRecord(value) || typeof value.id !== "string") return false
  for (const key of ["instructions", "displayName", "compactionHash"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false
  }
  for (const key of [
    "autoCompactTokenLimit",
    "contextWindowTokens",
    "maxContextWindowTokens",
  ]) {
    if (value[key] !== undefined && !positiveInteger(value[key])) return false
  }
  const percent = value.effectiveContextWindowPercent
  if (
    percent !== undefined &&
    (typeof percent !== "number" || !Number.isFinite(percent) || percent <= 0)
  )
    return false
  if (value.efforts !== undefined && !stringArray(value.efforts)) return false
  if (
    value.inputModalities !== undefined &&
    !inputModalities(value.inputModalities)
  )
    return false
  const truncation = value.toolOutputTruncation
  if (
    truncation !== undefined &&
    (!isRecord(truncation) ||
      (truncation.mode !== "bytes" && truncation.mode !== "tokens") ||
      typeof truncation.limit !== "number" ||
      !Number.isSafeInteger(truncation.limit) ||
      truncation.limit < 0)
  )
    return false
  const capabilities = value.capabilities
  if (capabilities === undefined) return true
  return (
    isRecord(capabilities) &&
    inputModalities(capabilities.inputModalities) &&
    stringArray(capabilities.imageDetailModes) &&
    capabilities.imageDetailModes.every(
      (mode) => mode === "high" || mode === "original",
    ) &&
    (capabilities.shellToolType === "disabled" ||
      capabilities.shellToolType === "unified_exec") &&
    (capabilities.applyPatchToolType === undefined ||
      capabilities.applyPatchToolType === "custom") &&
    typeof capabilities.fileEditingToolType === "string" &&
    ["edit_write", "none", "search_replace"].includes(
      capabilities.fileEditingToolType,
    ) &&
    typeof capabilities.supportsNativeToolSearch === "boolean" &&
    typeof capabilities.supportsCustomTools === "boolean"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function inputModalities(value: unknown): boolean {
  return (
    stringArray(value) &&
    value.every((item) => ["text", "image", "video"].includes(item))
  )
}
