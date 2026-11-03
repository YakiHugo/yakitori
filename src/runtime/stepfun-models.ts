import type { ConfiguredModel } from "../protocol/providers.ts"

// Exact documented API models, checked 2026-11-03. Step Code discovers account
// availability dynamically; these facts do not grant access to a model.
// https://platform.stepfun.ai/docs/en/guides/models/step-5-preview
// https://platform.stepfun.ai/docs/en/guides/models/step-3.7-flash
// https://platform.stepfun.ai/docs/en/guides/models/step-3.5-flash
export const stepfunModels: readonly ConfiguredModel[] = [
  {
    id: "step-5-preview",
    displayName: "Step 5 Preview",
    contextWindowTokens: 1_000_000,
    contextWindowScope: "total",
    maxOutputTokens: 64_000,
    inputModalities: ["text", "image"],
    imageDetailModes: ["high"],
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    id: "step-3.7-flash",
    displayName: "Step 3.7 Flash",
    contextWindowTokens: 256_000,
    contextWindowScope: "total",
    // Only still images are adapted here, not video input.
    inputModalities: ["text", "image"],
    imageDetailModes: ["high"],
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    id: "step-3.5-flash-2603",
    displayName: "Step 3.5 Flash 2603",
    contextWindowTokens: 256_000,
    contextWindowScope: "total",
    inputModalities: ["text"],
    imageDetailModes: [],
    efforts: ["low", "high"],
  },
  {
    id: "step-3.5-flash",
    displayName: "Step 3.5 Flash",
    contextWindowTokens: 256_000,
    contextWindowScope: "total",
    inputModalities: ["text"],
    imageDetailModes: [],
    // No fixed effort list is published for the base variant. Discovery may
    // supply reasoning_effort_support_list for the current account endpoint.
    efforts: [],
  },
]

export function isStepfunVisionModel(model: string): boolean {
  return model === "step-5-preview" || model === "step-3.7-flash"
}

// Step Code's first-party discovery contract, revision fa100638d5b598c600c7926d63904b1689f7e4a1:
// https://github.com/stepfun-ai/Step-Code/blob/fa100638d5b598c600c7926d63904b1689f7e4a1/packages/providers/src/step-provider/index.ts
export function stepfunDiscoveredMetadata(
  entry: Readonly<Record<string, unknown>> & { id: string },
): Partial<ConfiguredModel> {
  const capacity = entry.max_input_tokens
  const efforts = entry.reasoning_effort_support_list
  return {
    ...(typeof capacity === "number" &&
    Number.isSafeInteger(capacity) &&
    capacity > 0
      ? { contextWindowTokens: capacity, contextWindowScope: "input" }
      : {}),
    ...(!isStepfunVisionModel(entry.id) ||
    typeof entry.enable_vision_input === "boolean"
      ? {
          // Unknown model IDs have no verified image preparation contract yet.
          inputModalities:
            entry.enable_vision_input && isStepfunVisionModel(entry.id)
              ? ["text", "image"]
              : ["text"],
          imageDetailModes:
            entry.enable_vision_input && isStepfunVisionModel(entry.id)
              ? ["high"]
              : [],
        }
      : {}),
    ...(entry.enable_reason === false
      ? { efforts: [] }
      : Array.isArray(efforts) &&
          efforts.every((effort) => typeof effort === "string" && effort.trim())
        ? { efforts: efforts as string[] }
        : {}),
  }
}
