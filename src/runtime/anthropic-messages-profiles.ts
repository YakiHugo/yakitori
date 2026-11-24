import type {
  MessageCreateParamsStreaming,
  OutputConfig,
} from "@anthropic-ai/sdk/resources/messages"
import { isJsonObject } from "../kernel/index.ts"
import { anthropicModel } from "./anthropic-models.ts"
import type { ModelRequest } from "./model.ts"
import { ModelRequestControlsError } from "./model-request-controls.ts"

type ThinkingFields = Pick<
  MessageCreateParamsStreaming,
  "thinking" | "output_config"
>
export type AnthropicMessagesProfile = Readonly<{
  id: string
  explicitPromptCaching: boolean
  bindThinkingHistory?: boolean
  selectMedia(baseURL: string): "anthropic" | "kimi-code" | undefined
  validateRequest?(request: ModelRequest, model: string): void
  thinking?(
    request: ModelRequest,
    model: string,
  ): { fields: ThinkingFields; effortBeta?: boolean }
}>

function anthropicMedia(baseURL: string) {
  return URL.parse(baseURL)?.href === "https://api.anthropic.com/"
    ? ("anthropic" as const)
    : undefined
}

export const genericMessagesProfile: AnthropicMessagesProfile = {
  id: "generic",
  explicitPromptCaching: false,
  selectMedia: anthropicMedia,
}

export const anthropicMessagesProfile: AnthropicMessagesProfile = {
  id: "anthropic",
  explicitPromptCaching: true,
  bindThinkingHistory: true,
  selectMedia: anthropicMedia,
  validateRequest: validateAnthropicModelRequest,
  thinking(request, model) {
    const contract = anthropicModel(model)
    const effort = request.target.effort
    return {
      fields: {
        ...effortFields(effort),
        ...(effort === "off" && contract?.off === "between_tools"
          ? {
              thinking: { type: "between_tools" } as unknown as NonNullable<
                ThinkingFields["thinking"]
              >,
            }
          : effort !== "off" && contract?.thinking === "adaptive"
            ? { thinking: { type: "adaptive", display: "summarized" } }
            : {}),
      },
    }
  },
}

export const kimiCodeMessagesProfile: AnthropicMessagesProfile = {
  id: "kimi-code",
  explicitPromptCaching: true,
  selectMedia(baseURL) {
    if (
      [
        "https://api.kimi.com/coding",
        "https://api.kimi.com/coding/v1",
      ].includes(new URL(baseURL).href.replace(/\/$/, ""))
    )
      return "kimi-code"
    return anthropicMedia(baseURL)
  },
  validateRequest(request, model) {
    const thinking = request.providerOptions?.body.thinking
    if (
      ["k3.1-pro", "k3.1-pro-highspeed"].includes(model) &&
      (request.target.effort === "off" ||
        (isJsonObject(thinking) && thinking.type === "disabled"))
    )
      throw new ModelRequestControlsError(
        "Kimi Code K3.1 Pro requires thinking; select low, high or max effort instead of off.",
      )
  },
  thinking(request) {
    const fields = effortFields(request.target.effort)
    return { fields, effortBeta: fields.output_config !== undefined }
  },
}

export function defaultAnthropicMessagesProfile(
  baseURL: string,
): AnthropicMessagesProfile {
  return URL.parse(baseURL)?.origin === "https://api.anthropic.com"
    ? anthropicMessagesProfile
    : genericMessagesProfile
}

function effortFields(effort: string | undefined): ThinkingFields {
  if (effort === undefined || effort === "on") return {}
  if (effort === "off") return { thinking: { type: "disabled" } }
  return {
    output_config: { effort: effort as NonNullable<OutputConfig["effort"]> },
  }
}

function validateAnthropicModelRequest(
  request: ModelRequest,
  model: string,
): void {
  const contract = anthropicModel(model)
  if (contract === undefined) return
  const effort = request.target.effort
  if (
    effort !== undefined &&
    !(effort === "off" && contract.off) &&
    !contract.configuration.efforts?.includes(effort)
  )
    throw new ModelRequestControlsError(
      `${model} does not support effort ${effort}.`,
    )
  const thinking = request.providerOptions?.body.thinking
  if (
    effort === "off" &&
    isJsonObject(thinking) &&
    Object.keys(thinking).length > 0
  )
    throw new ModelRequestControlsError(
      "Thinking off cannot be combined with native thinking fields.",
    )
  if (isJsonObject(thinking) && thinking.type !== undefined) {
    const mode = thinking.type
    if (
      (mode === "disabled" && contract.off !== "disabled") ||
      (mode === "between_tools" && contract.off !== "between_tools") ||
      (mode === "adaptive" && contract.thinking !== "adaptive") ||
      (mode === "enabled" &&
        contract.thinking !== "extended" &&
        !["claude-sonnet-4-6", "claude-opus-4-6"].includes(model))
    )
      throw new ModelRequestControlsError(
        `${model} does not support thinking mode ${String(mode)}.`,
      )
    if (
      mode === "between_tools" &&
      Object.keys(thinking).some((key) => key !== "type")
    )
      throw new ModelRequestControlsError(
        "Claude Sonnet 5.5 between_tools accepts no other thinking fields.",
      )
  }
  if (
    !contract.forcedTools &&
    (request.toolChoice === "required" ||
      typeof request.toolChoice === "object")
  )
    throw new ModelRequestControlsError(
      `${model} does not support forced tool choice; select auto instead.`,
    )
  if (
    request.maxOutputTokens !== undefined &&
    (!Number.isInteger(request.maxOutputTokens) ||
      request.maxOutputTokens < 1 ||
      request.maxOutputTokens >
        (contract.configuration.maxOutputTokens ?? Infinity))
  )
    throw new ModelRequestControlsError(
      `${model} maxOutputTokens must be between 1 and ${contract.configuration.maxOutputTokens}.`,
    )
}
