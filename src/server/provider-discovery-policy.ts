import type { ProviderPreset } from "../protocol/providers.ts"
import { rekaVisionModel } from "../runtime/reka-vision.ts"

type DiscoveryPolicy = Readonly<{
  source?: "preset"
  missingCatalog?: "error"
  query?: Readonly<Record<string, string>>
  allowedModels?: "preset" | readonly string[]
  fillPresetMetadata?: boolean
  maxOutputTokensField?: string
}>

// These are catalog selection/defaults, not wire parsers or account access.
// The caller must first bind the service to its documented endpoint/protocol.
// Native payload parsing and account-reported restrictions remain in discovery.
const policies: Readonly<Record<string, DiscoveryPolicy>> = {
  // Neither API documents GET /models. Static availability does not test keys.
  "amazon-nova": { source: "preset" },
  spark: { source: "preset" },
  siliconflow: { query: { sub_type: "chat" } },
  // Shared catalogs include models outside the explicitly adapted API profile.
  // Select from actual returned IDs; never add unavailable preset entries.
  moonshot: { allowedModels: "preset" },
  nvidia: { allowedModels: "preset" },
  reka: {
    missingCatalog: "error",
    allowedModels: [rekaVisionModel],
    maxOutputTokensField: "max_output_length",
  },
  stepfun: { missingCatalog: "error" },
  // Exact native facts fill omissions; catalog fields are applied afterwards.
  minimax: { fillPresetMetadata: true },
  glm: { fillPresetMetadata: true },
}

export function providerDiscoveryPolicy(
  service: ProviderPreset | undefined,
): Omit<DiscoveryPolicy, "allowedModels"> & {
  allowedModels?: readonly string[]
} {
  if (service === undefined) return {}
  const { allowedModels, ...policy } = policies[service.id] ?? {}
  return {
    ...policy,
    ...(allowedModels === undefined
      ? {}
      : {
          allowedModels:
            allowedModels === "preset"
              ? service.models.map((model) => model.id)
              : allowedModels,
        }),
  }
}
