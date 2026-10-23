import type { JsonObject, ModelSelection } from "../kernel/events.ts"

export type AgentModelOverrides = Readonly<{
  current: ModelSelection
  models: readonly Readonly<{
    provider: string
    model: string
    efforts?: readonly string[]
    defaultEffort?: string
  }>[]
  resolve(selection: ModelSelection): ModelSelection
}>

export class AgentModelSelectionError extends Error {
  readonly code = "invalid_tool_input"
}

export function agentModelOptions(catalog?: AgentModelOverrides): Readonly<{
  properties: JsonObject
  description: string
}> {
  if (catalog === undefined || catalog.models.length === 0)
    return {
      properties: {},
      description:
        "Model overrides are unavailable; omit model and reasoning_effort.",
    }
  const efforts = [
    ...new Set(catalog.models.flatMap((entry) => entry.efforts ?? [])),
  ]
  return {
    properties: {
      model: {
        type: "string",
        enum: catalog.models.map((entry) => `${entry.provider}/${entry.model}`),
        description:
          "Optional exact provider/model reference from the available models. Omit to inherit the current model.",
      },
      ...(efforts.length === 0
        ? {}
        : {
            reasoning_effort: {
              type: "string",
              enum: efforts,
              description:
                "Optional reasoning effort supported by the selected model. Changing models without an effort uses the selected model's default.",
            },
          }),
    },
    description: `Available models across connected providers: ${catalog.models.map((entry) => `${entry.provider}/${entry.model} (reasoning: ${entry.efforts?.join(", ") || "not listed"}${entry.defaultEffort === undefined ? "" : `; default: ${entry.defaultEffort}`})`).join("; ")}.`,
  }
}

export function resolveAgentModelTarget(
  inherited: ModelSelection,
  request: Readonly<{ model?: string; reasoningEffort?: string }>,
  catalog?: AgentModelOverrides,
): ModelSelection {
  if (request.model === undefined && request.reasoningEffort === undefined)
    return inherited
  if (catalog === undefined)
    throw new AgentModelSelectionError(
      "Agent model overrides are disabled in runtime settings.",
    )
  const current = catalog.current
  const reference = request.model ?? `${current.provider}/${current.model}`
  const selected = catalog.models.find(
    (entry) => `${entry.provider}/${entry.model}` === reference,
  )
  if (selected === undefined)
    throw new AgentModelSelectionError(
      `Model ${reference} is not available for delegation.`,
    )
  if (
    request.reasoningEffort !== undefined &&
    !selected.efforts?.includes(request.reasoningEffort)
  )
    throw new AgentModelSelectionError(
      `Reasoning effort ${request.reasoningEffort} is not supported by ${reference}.`,
    )
  const changed =
    selected.provider !== current.provider || selected.model !== current.model
  const effort =
    request.reasoningEffort ??
    (changed ? selected.defaultEffort : inherited.effort)
  const selection: ModelSelection = {
    provider: selected.provider,
    model: selected.model,
    ...(effort === undefined ? {} : { effort }),
    ...(changed || inherited.speed === undefined
      ? {}
      : { speed: inherited.speed }),
  }
  // Validate account availability now; persist the public identity so admission
  // can route it using the host's current account bindings.
  catalog.resolve(selection)
  return selection
}
