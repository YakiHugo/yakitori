import { chatDialectMedia } from "./chat-completions-dialects.ts"
import type { ModelWireApi } from "./model.ts"
import type { ResolvedModel } from "./model-catalog.ts"
import {
  type ImageTokenEstimator,
  openAIImageTokenEstimator,
} from "./openai-image-budget.ts"
import { hasOpenAIImagePreparation } from "./openai-vision-models.ts"

const profiles: Readonly<
  Record<
    string,
    { wireApi: ModelWireApi; model?: string | ((model: string) => boolean) }
  >
> = {
  codex: { wireApi: "openai_responses" },
  openai: { wireApi: "openai_responses", model: hasOpenAIImagePreparation },
  xai: { wireApi: "openai_responses", model: "grok-4.7" },
  anthropic: { wireApi: "anthropic_messages" },
  "kimi-code": { wireApi: "anthropic_messages" },
  gemini: { wireApi: "gemini_generate_content" },
  moonshot: { wireApi: "openai_responses" },
}

function deferImagePreparation(input: {
  serviceId?: string | undefined
  wireApi?: ModelWireApi | undefined
  model: string
}): boolean {
  // Bedrock's Converse adapter owns image admission regardless of the AWS
  // account's label. This is deliberately a wire-level rule, unlike the rest.
  if (input.wireApi === "bedrock_converse") return true
  if (input.wireApi === "openai_chat_completions")
    return chatDialectMedia(input.serviceId, input.model) !== undefined
  if (
    input.serviceId === undefined ||
    !Object.hasOwn(profiles, input.serviceId)
  )
    return false
  const profile = profiles[input.serviceId]
  return (
    profile !== undefined &&
    profile.wireApi === input.wireApi &&
    (profile.model === undefined ||
      (typeof profile.model === "string"
        ? profile.model === input.model
        : profile.model(input.model)))
  )
}

export function resolveImagePreparation(input: {
  serviceId?: string | undefined
  wireApi?: ModelWireApi | undefined
  model: ResolvedModel
}): Readonly<{
  deferImagePreparation: boolean
  imageTokenEstimator: ImageTokenEstimator | undefined
}> {
  const defer = deferImagePreparation({ ...input, model: input.model.model })
  const imageTokens =
    input.wireApi === "openai_chat_completions"
      ? chatDialectMedia(input.serviceId, input.model.model)?.imageTokens
      : undefined
  return {
    deferImagePreparation: defer,
    imageTokenEstimator:
      input.wireApi === "bedrock_converse"
        ? () => 230
        : imageTokens !== undefined
          ? () => imageTokens
          : openAIImageTokenEstimator(input),
  }
}
