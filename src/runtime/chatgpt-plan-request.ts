import type {
  ResponseCreateParamsStreaming,
  ResponseOutputItem,
} from "openai/resources/responses/responses"

// SIWC's public Responses route is not the general API-key contract.
// https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
export function toChatGPTPlanRequest(
  body: ResponseCreateParamsStreaming,
): ResponseCreateParamsStreaming {
  if (!body.model)
    throw new Error("ChatGPT plan requests require a selected model.")
  if (!Array.isArray(body.input))
    throw new Error("ChatGPT plan requests require full array history.")
  const tools = (body.tools ?? []).map((tool) => {
    if (tool.type !== "function" && tool.type !== "custom")
      throw new Error(
        "ChatGPT plan requests support local function/custom tools only.",
      )
    if (tool.defer_loading)
      throw new Error("ChatGPT plan tools must be eagerly available.")
    return tool
  })
  const input = body.input.map((item) => {
    if ("role" in item && item.role === "system")
      throw new Error(
        "ChatGPT plan requests require instructions or developer messages.",
      )
    if (
      item.type === "tool_search_call" ||
      item.type === "tool_search_output" ||
      item.type === "compaction_trigger"
    )
      throw new Error(
        "ChatGPT plan requests require local tool-search and compaction projection.",
      )
    if (item.type === "function_call" || item.type === "custom_tool_call")
      return { ...item, namespace: "yakitori" }
    return item
  })
  // Rebuild an allowlisted request rather than passing API-only controls through.
  return {
    model: body.model,
    input,
    ...(body.instructions === undefined
      ? {}
      : { instructions: body.instructions }),
    tools:
      tools.length === 0
        ? []
        : [
            {
              type: "namespace",
              name: "yakitori",
              description: "Locally executed Yakitori tools",
              tools,
            },
          ],
    parallel_tool_calls: true,
    store: false,
    stream: true,
    ...(body.reasoning === undefined ? {} : { reasoning: body.reasoning }),
    ...(body.prompt_cache_key === undefined
      ? {}
      : { prompt_cache_key: body.prompt_cache_key }),
    ...(body.service_tier === undefined
      ? {}
      : { service_tier: body.service_tier }),
  }
}

export function parseChatGPTPlanModels(
  value: unknown,
): readonly { id: string; displayName: string }[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("models" in value) ||
    !Array.isArray(value.models)
  )
    throw new Error("ChatGPT returned an invalid model catalog.")
  return value.models.flatMap((model: unknown) => {
    if (typeof model !== "object" || model === null || !("visibility" in model))
      throw new Error("ChatGPT returned an invalid model entry.")
    if (model.visibility !== "list") return []
    if (
      !("slug" in model) ||
      typeof model.slug !== "string" ||
      !model.slug.trim() ||
      !("display_name" in model) ||
      typeof model.display_name !== "string" ||
      !model.display_name.trim()
    )
      throw new Error("ChatGPT returned an invalid visible model entry.")
    return [{ id: model.slug, displayName: model.display_name }]
  })
}

export function requireChatGPTPlanNamespace(item: ResponseOutputItem): void {
  if (
    (item.type === "function_call" || item.type === "custom_tool_call") &&
    item.namespace !== "yakitori"
  )
    throw new Error(
      "ChatGPT returned a tool call outside the Yakitori namespace.",
    )
}
