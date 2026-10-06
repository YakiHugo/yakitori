import type { ModelRequest } from "./model.ts"

// These restrictions describe OpenAI's endpoint and exact documented models,
// not models with similar names on a custom Chat Completions endpoint.
// https://developers.openai.com/api/docs/guides/latest-model
// https://developers.openai.com/api/docs/models/gpt-5.1-codex
export function chatCompletionsIncompatibility(
  options: Readonly<{ baseURL: string; model: string }>,
  request: ModelRequest,
): string | undefined {
  const endpoint = URL.parse(options.baseURL)
  if (
    endpoint?.origin !== "https://api.openai.com" ||
    !["/v1", "/v1/"].includes(endpoint.pathname)
  )
    return undefined

  const model = request.target.model || options.model
  if (model === "gpt-5.1-codex")
    return `OpenAI model ${model} is available only through the Responses API. Select the OpenAI Responses API for this model.`

  const usesTools =
    request.tools.length > 0 ||
    request.messages.some(
      (message) =>
        message.role === "tool" ||
        (message.role === "assistant" &&
          message.content.some((block) => block.type === "tool_call")),
    )
  if (!usesTools) return undefined

  if (model === "gpt-6-astra" || model === "gpt-6.1-sol")
    return `OpenAI model ${model} requires the Responses API for tool calls and tool history. Select the OpenAI Responses API for this model.`

  if (
    (model === "gpt-6-sol" || model === "gpt-6-luna") &&
    request.target.effort !== "none"
  )
    return `OpenAI model ${model} supports tools in Chat Completions only with reasoning_effort "none". Select the Responses API to keep reasoning, or explicitly choose reasoning effort "none".`

  return undefined
}
