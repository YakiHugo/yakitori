import type { JsonObject } from "../kernel/index.ts"
import type { ModelNativeItem, ModelRequest } from "./model.ts"

export class ModelRequestControlsError extends Error {}

export function validateModelRequestControls(
  request: ModelRequest,
  wireApi: ModelNativeItem["wireApi"],
): void {
  const options = request.providerOptions
  if (options === undefined) return
  if (options.betas !== undefined && wireApi !== "anthropic_messages")
    throw new ModelRequestControlsError(
      "Beta headers require the Messages API.",
    )
  if (
    options.provider !== request.target.provider ||
    options.wireApi !== wireApi
  )
    throw new ModelRequestControlsError(
      "Provider request controls belong to another provider or API.",
    )
  const reserved = new Set([
    "model",
    "input",
    "messages",
    "contents",
    "system",
    "instructions",
    "systemInstruction",
    "stream",
    "store",
    "n",
    "stream_options",
    "previous_response_id",
    "conversation",
  ])
  if (wireApi === "gemini_interactions") {
    for (const key of [
      "system_instruction",
      "previous_interaction_id",
      "background",
      "agent",
      "agent_config",
      "environment",
      "environment_id",
      "response_modalities",
      "response_mime_type",
      "response_format",
    ])
      reserved.add(key)
    const generation = options.body.generation_config
    if (generation !== undefined && !isRecord(generation))
      throw new ModelRequestControlsError(
        "Native generation_config controls must be an object.",
      )
    if (
      isRecord(generation) &&
      ["max_output_tokens", "tool_choice", "thinking_level"].some(
        (key) => generation[key] !== undefined,
      )
    )
      throw new ModelRequestControlsError(
        "Provider controls cannot replace captured output, effort or tool settings.",
      )
    // Local function definitions belong to the harness tool plan.
    if (
      Array.isArray(options.body.tools) &&
      options.body.tools.some(
        (tool) =>
          isRecord(tool) &&
          (tool.type === "function" || tool.type === "custom"),
      )
    )
      throw new ModelRequestControlsError(
        "Local tool definitions must belong to the harness tool plan.",
      )
  }
  for (const key of Object.keys(options.body)) {
    if (reserved.has(key))
      throw new ModelRequestControlsError(
        `Provider controls cannot replace harness-owned ${key}.`,
      )
  }
  if (options.body.tools !== undefined && !Array.isArray(options.body.tools))
    throw new ModelRequestControlsError("Native tools must be an array.")
  const thinking = options.body.thinking
  const generation = options.body.generationConfig
  const thinkingConfig = isRecord(generation)
    ? generation.thinkingConfig
    : undefined
  if (thinking !== undefined && !isRecord(thinking))
    throw new ModelRequestControlsError(
      "Native thinking controls must be an object.",
    )
  if (thinkingConfig !== undefined && !isRecord(thinkingConfig))
    throw new ModelRequestControlsError(
      "Native thinkingConfig controls must be an object.",
    )
  if (
    request.target.effort !== undefined &&
    ((isRecord(thinking) &&
      (thinking.type !== undefined || thinking.budget_tokens !== undefined)) ||
      (isRecord(thinkingConfig) &&
        (thinkingConfig.thinkingLevel !== undefined ||
          thinkingConfig.thinkingBudget !== undefined)))
  )
    throw new ModelRequestControlsError(
      "Native thinking controls cannot replace captured reasoning effort.",
    )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Native controls intentionally name their owner and API. They extend the wire
// request without handing ownership of the execution loop to a vendor SDK.
export function applyModelRequestControls<T extends object>(
  request: ModelRequest,
  wireApi: ModelNativeItem["wireApi"],
  body: T,
): T {
  const options = request.providerOptions
  if (options === undefined) return body
  validateModelRequestControls(request, wireApi)
  const result: Record<string, unknown> = { ...body, ...options.body }
  if (options.body.tools !== undefined) {
    if (!Array.isArray(options.body.tools))
      throw new ModelRequestControlsError("Native tools must be an array.")
    const tools = "tools" in body ? body.tools : undefined
    result.tools = [
      ...(Array.isArray(tools) ? tools : []),
      ...options.body.tools,
    ]
  }
  for (const key of [
    "reasoning",
    "text",
    "generationConfig",
    "generation_config",
    "output_config",
    "thinking",
  ]) {
    const original =
      key in body ? (body as Record<string, unknown>)[key] : undefined
    const extension = options.body[key]
    if (isRecord(original) && isRecord(extension)) {
      // An explicit mode owns its complete shape, e.g. disabled has no display.
      if (key === "thinking" && extension.type !== undefined) continue
      const merged = { ...original, ...extension }
      // Display controls share this object with the captured thinking level.
      if (
        key === "generationConfig" &&
        isRecord(original.thinkingConfig) &&
        isRecord(extension.thinkingConfig)
      )
        merged.thinkingConfig = {
          ...original.thinkingConfig,
          ...extension.thinkingConfig,
        }
      result[key] = merged
    }
  }
  if (wireApi === "gemini_generate_content") {
    const config = result.generationConfig
    if (
      config !== undefined &&
      (typeof config !== "object" ||
        config === null ||
        !("candidateCount" in config) ||
        config.candidateCount !== 1)
    )
      throw new ModelRequestControlsError(
        "The coding agent requires exactly one Gemini candidate.",
      )
  }
  return result as T
}

export function openAIToolChoice(
  request: ModelRequest,
): JsonObject | "auto" | "none" | "required" | undefined {
  const choice = request.toolChoice
  return typeof choice === "object"
    ? {
        type: request.tools.some(
          (tool) => tool.name === choice.name && tool.kind === "custom",
        )
          ? "custom"
          : "function",
        name: choice.name,
      }
    : choice
}
