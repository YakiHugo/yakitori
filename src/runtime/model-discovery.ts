import type { DiscoveredModel } from "./models-manager.ts"
import type {
  ModelCapabilities,
  ModelToolOutputTruncation,
} from "./model-catalog.ts"

const HIDDEN_CODEX_MODELS = new Set([
  "gpt-reserve",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
])

export async function discoverOpenAiCompatibleModels(input: {
  provider: "grok" | "kimi"
  baseUrl: string
  accessToken: string
  fetchFn?: typeof fetch
}): Promise<readonly DiscoveredModel[]> {
  const response = await (input.fetchFn ?? fetch)(
    `${input.baseUrl.replace(/\/$/, "")}/models`,
    {
      headers: { authorization: `Bearer ${input.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    },
  )
  if (!response.ok) {
    throw new Error(
      `Model discovery failed with HTTP ${String(response.status)}.`,
    )
  }
  const payload: unknown = await response.json()
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("Model discovery returned an invalid response.")
  }
  return payload.data.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") return []
    const contextWindowTokens = positiveInteger(entry.context_length)
    const displayName = stringValue(entry.display_name)
    const efforts =
      input.provider === "kimi" &&
      isRecord(entry.think_efforts) &&
      entry.think_efforts.support === true &&
      Array.isArray(entry.think_efforts.valid_efforts) &&
      entry.think_efforts.valid_efforts.length > 0 &&
      entry.think_efforts.valid_efforts.every(
        (effort) => typeof effort === "string" && effort.length > 0,
      )
        ? (entry.think_efforts.valid_efforts as string[])
        : undefined
    const inputModalities: ("text" | "image" | "video")[] = ["text"]
    if (input.provider === "kimi") {
      if (entry.supports_image_in === true) inputModalities.push("image")
      if (entry.supports_video_in === true) inputModalities.push("video")
    }
    return [
      {
        id: entry.id,
        ...(displayName === undefined ? {} : { displayName }),
        ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
        ...(efforts === undefined ? {} : { efforts }),
        ...(input.provider === "kimi" &&
        typeof entry.supports_image_in === "boolean" &&
        typeof entry.supports_video_in === "boolean"
          ? { inputModalities }
          : {}),
      },
    ]
  })
}

export async function discoverCodexModels(input: {
  baseUrl: string
  accessToken: string
  accountId?: string
  fetchFn?: typeof fetch
}): Promise<readonly DiscoveredModel[]> {
  const response = await (input.fetchFn ?? fetch)(
    `${input.baseUrl.replace(/\/$/, "")}/models?client_version=0.0.0`,
    {
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        ...(input.accountId === undefined
          ? {}
          : { "chatgpt-account-id": input.accountId }),
      },
      signal: AbortSignal.timeout(10_000),
    },
  )
  if (!response.ok) {
    throw new Error(
      `Codex model discovery failed with HTTP ${String(response.status)}.`,
    )
  }
  const payload: unknown = await response.json()
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw new Error("Codex model discovery returned an invalid response.")
  }
  return payload.models
    .flatMap((entry) => parseCodexModel(entry))
    .filter((model) => !HIDDEN_CODEX_MODELS.has(model.id.toLowerCase()))
}

function parseCodexModel(value: unknown): readonly DiscoveredModel[] {
  if (!isRecord(value)) return []
  const id = stringValue(value.slug) ?? stringValue(value.id)
  if (id === undefined) return []
  const instructions =
    isRecord(value.model_messages) &&
    typeof value.model_messages.instructions_template === "string"
      ? value.model_messages.instructions_template
      : undefined
  const capabilities = codexModelCapabilities(value)
  const truncation = value.truncation_policy
  const toolOutputTruncation: ModelToolOutputTruncation | undefined =
    isRecord(truncation) &&
    (truncation.mode === "bytes" || truncation.mode === "tokens") &&
    typeof truncation.limit === "number" &&
    Number.isSafeInteger(truncation.limit) &&
    truncation.limit >= 0
      ? { mode: truncation.mode, limit: truncation.limit }
      : undefined
  const displayName = stringValue(value.display_name ?? value.displayName)
  const contextWindowTokens = positiveInteger(
    value.context_window ?? value.contextWindow,
  )
  const maxContextWindowTokens = positiveInteger(
    value.max_context_window ?? value.maxContextWindow,
  )
  const effectiveContextWindowPercent = positiveNumber(
    value.effective_context_window_percent ??
      value.effectiveContextWindowPercent,
  )
  const autoCompactTokenLimit = positiveInteger(
    value.auto_compact_token_limit ?? value.autoCompactTokenLimit,
  )
  const compactionHash = stringValue(value.comp_hash)
  const efforts = Array.isArray(value.supported_reasoning_levels)
    ? value.supported_reasoning_levels.flatMap((level) =>
        isRecord(level) && typeof level.effort === "string"
          ? [level.effort]
          : [],
      )
    : undefined
  return [
    {
      id,
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(toolOutputTruncation === undefined ? {} : { toolOutputTruncation }),
      ...(efforts === undefined ? {} : { efforts }),
      ...(instructions === undefined ? {} : { instructions }),
      ...(displayName === undefined ? {} : { displayName }),
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
      ...(maxContextWindowTokens === undefined
        ? {}
        : { maxContextWindowTokens }),
      ...(effectiveContextWindowPercent === undefined
        ? {}
        : { effectiveContextWindowPercent }),
      ...(autoCompactTokenLimit === undefined ? {} : { autoCompactTokenLimit }),
      ...(compactionHash === undefined ? {} : { compactionHash }),
    },
  ]
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function codexModelCapabilities(
  value: Record<string, unknown>,
): ModelCapabilities | undefined {
  const shellToolType =
    value.shell_type === "disabled"
      ? "disabled"
      : typeof value.shell_type === "string" &&
          ["unified_exec", "shell_command", "default", "local"].includes(
            value.shell_type,
          )
        ? "unified_exec"
        : undefined
  if (
    shellToolType === undefined ||
    !Array.isArray(value.input_modalities) ||
    (value.apply_patch_tool_type !== null &&
      value.apply_patch_tool_type !== "freeform")
  )
    return undefined
  return {
    inputModalities: value.input_modalities.filter(
      (modality): modality is "text" | "image" =>
        modality === "text" || modality === "image",
    ),
    imageDetailModes: value.input_modalities.includes("image")
      ? value.supports_image_detail_original === true
        ? ["high", "original"]
        : ["high"]
      : [],
    shellToolType,
    ...(value.apply_patch_tool_type === "freeform"
      ? { applyPatchToolType: "custom" as const }
      : {}),
    fileEditingToolType: "none",
    supportsNativeToolSearch: value.supports_search_tool === true,
    supportsCustomTools: value.apply_patch_tool_type === "freeform",
  }
}
