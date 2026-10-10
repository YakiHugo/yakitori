import type { JsonObject } from "../kernel/index.ts"
import type { ModelNativeItem, ModelRequest } from "./model.ts"

export class ModelRequestControlsError extends Error {}

// Native controls intentionally name their owner and API. They extend the wire
// request without handing ownership of the execution loop to a vendor SDK.
export function applyModelRequestControls<T extends object>(
  request: ModelRequest,
  wireApi: ModelNativeItem["wireApi"],
  body: T,
): T {
  const options = request.providerOptions
  if (options === undefined) return body
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
  for (const key of Object.keys(options.body)) {
    if (reserved.has(key))
      throw new ModelRequestControlsError(
        `Provider controls cannot replace harness-owned ${key}.`,
      )
  }
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
    "output_config",
  ]) {
    const original =
      key in body ? (body as Record<string, unknown>)[key] : undefined
    const extension = options.body[key]
    if (
      typeof original === "object" &&
      original !== null &&
      !Array.isArray(original) &&
      typeof extension === "object" &&
      extension !== null &&
      !Array.isArray(extension)
    )
      result[key] = { ...original, ...extension }
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
