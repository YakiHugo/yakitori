import type {
  ModelSettingsConfiguration,
  ProviderModelSettings,
} from "../protocol/providers.ts"
import { ConfigurationError } from "./config-errors.ts"
import { requireConfiguredModels } from "./provider-configuration.ts"

export function requireModelSettingsProvider(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9_-]*$/.test(value) ||
    ["constructor", "prototype"].includes(value)
  )
    throw new ConfigurationError("Invalid model settings provider.")
  return value
}

export function requireProviderModelSettings(
  value: unknown,
): ProviderModelSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ConfigurationError(
      "Model settings must be an object keyed by model ID.",
    )
  const entries = Object.entries(value).map(([id, raw]) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new ConfigurationError(
        `Model settings for ${id} must be an object.`,
      )
    const record = raw as Record<string, unknown>
    if (record.visible !== undefined && typeof record.visible !== "boolean")
      throw new ConfigurationError("Model visible must be a boolean.")
    if (record.defaultVisible !== undefined)
      throw new ConfigurationError("Use visible to override model visibility.")
    if (record.kind !== undefined)
      throw new ConfigurationError(
        "Model purpose comes from the provider catalog.",
      )
    const parsed = requireConfiguredModels([{ ...record, id }], {
      inheritEfforts: true,
    })[0]
    if (!parsed) throw new Error("Model settings validation returned no model.")
    const { id: _, ...settings } = parsed
    return [
      parsed.id,
      {
        ...settings,
        ...(record.visible === undefined
          ? {}
          : { visible: record.visible as boolean }),
      },
    ] as const
  })
  if (new Set(entries.map(([id]) => id.toLowerCase())).size !== entries.length)
    throw new ConfigurationError(
      "Model setting IDs must be unique within a connection.",
    )
  return Object.fromEntries(entries)
}

export function modelSettingsFromConfig(
  value: unknown,
): ModelSettingsConfiguration {
  if (value === undefined) return {}
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ConfigurationError(
      "models must be an object keyed by provider ID.",
    )
  return Object.fromEntries(
    Object.entries(value).map(([id, settings]) => [
      requireModelSettingsProvider(id),
      requireProviderModelSettings(settings),
    ]),
  )
}
