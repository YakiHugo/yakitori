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
  for (const key of Object.keys(options.body)) {
    if (harnessOwnedControls.has(key))
      throw new ModelRequestControlsError(
        `Provider controls cannot replace harness-owned ${key}.`,
      )
  }
  const tools = options.body.tools
  if (tools !== undefined && !Array.isArray(tools))
    throw new ModelRequestControlsError("Native tools must be an array.")
  if (Array.isArray(tools) && tools.some((tool) => !isRecord(tool)))
    throw new ModelRequestControlsError("Native tools must be objects.")
  // Hosted tools extend the provider's own execution. Local function/custom
  // definitions must pass through the harness tool plan and permission owner.
  if (
    Array.isArray(tools) &&
    tools.some(
      (tool) =>
        isRecord(tool) &&
        (tool.type === "function" ||
          tool.type === "custom" ||
          tool.type === "tool_search" ||
          tool.input_schema !== undefined ||
          tool.functionDeclarations !== undefined),
    )
  )
    throw new ModelRequestControlsError(
      "Local tool definitions must belong to the harness tool plan.",
    )
  const reasoning = options.body.reasoning
  for (const key of [
    "reasoning",
    "text",
    "output_config",
    "generationConfig",
    "generation_config",
    "thinking",
  ]) {
    if (options.body[key] !== undefined && !isRecord(options.body[key]))
      throw new ModelRequestControlsError(
        `Native ${key} controls must be an object.`,
      )
  }
  if (isRecord(reasoning) && reasoning.effort !== undefined)
    throw new ModelRequestControlsError(
      "Reasoning effort must use the captured model selection.",
    )
  const text = options.body.text
  const output = options.body.output_config
  const generation = options.body.generationConfig
  const interactionGeneration = options.body.generation_config
  const thinkingConfig = isRecord(generation)
    ? generation.thinkingConfig
    : undefined
  if (thinkingConfig !== undefined && !isRecord(thinkingConfig))
    throw new ModelRequestControlsError(
      "Native thinkingConfig controls must be an object.",
    )
  if (
    (isRecord(text) && text.format !== undefined) ||
    (isRecord(output) &&
      (output.effort !== undefined || output.format !== undefined)) ||
    (isRecord(generation) &&
      [
        "candidateCount",
        "maxOutputTokens",
        "responseMimeType",
        "responseSchema",
        "responseJsonSchema",
      ].some((key) => generation[key] !== undefined)) ||
    (isRecord(interactionGeneration) &&
      ["max_output_tokens", "tool_choice", "thinking_level"].some(
        (key) => interactionGeneration[key] !== undefined,
      ))
  )
    throw new ModelRequestControlsError(
      "Provider controls cannot replace captured output, effort or candidate settings.",
    )
  if (request.target.effort !== undefined) {
    const thinking = options.body.thinking
    if (
      (isRecord(thinking) &&
        (thinking.type !== undefined ||
          thinking.budget_tokens !== undefined)) ||
      (isRecord(reasoning) && reasoning.enabled !== undefined) ||
      (isRecord(thinkingConfig) &&
        (thinkingConfig.thinkingLevel !== undefined ||
          thinkingConfig.thinkingBudget !== undefined))
    )
      throw new ModelRequestControlsError(
        "Native thinking controls cannot replace captured reasoning effort.",
      )
  }
}

const harnessOwnedControls = new Set([
  "model",
  "input",
  "messages",
  "contents",
  "system",
  "instructions",
  "systemInstruction",
  "system_instruction",
  "stream",
  "store",
  "n",
  "stream_options",
  "previous_response_id",
  "previous_interaction_id",
  "conversation",
  "background",
  "agent",
  "agent_config",
  "environment",
  "environment_id",
  "response_modalities",
  "response_mime_type",
  "max_tokens",
  "max_output_tokens",
  "max_completion_tokens",
  "tool_choice",
  "parallel_tool_calls",
  "toolConfig",
  "response_format",
  "reasoning_effort",
  "service_tier",
])

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
