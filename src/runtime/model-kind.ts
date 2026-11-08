import type { ConfiguredModel, ProviderPreset } from "../protocol/providers.ts"

export class NonChatModelError extends Error {
  constructor(provider: string, model: string) {
    super(`Model ${provider}/${model} is not a chat model.`)
    this.name = "NonChatModelError"
  }
}

export function isChatModel(model: Pick<ConfiguredModel, "kind">): boolean {
  return model.kind === undefined || model.kind === "chat"
}

export function discoveredModelKind(
  entry: Readonly<Record<string, unknown>>,
  provider?: string,
  wireApi?: ProviderPreset["wireApi"],
): ConfiguredModel["kind"] {
  // Apply native ID rules only after the endpoint has been identified as the
  // official service. A relay may use these same names for different models.
  // https://platform.openai.com/docs/models
  // https://platform.openai.com/docs/guides/audio
  if (provider === "openai" && typeof entry.id === "string") {
    const id = entry.id.toLowerCase()
    if (/^(?:dall-e-|gpt-image-)/.test(id)) return "image"
    if (/^sora(?:-|$)/.test(id)) return "video"
    if (
      /^(?:whisper-|tts-|text-embedding-|text-moderation-|omni-moderation-)/.test(
        id,
      ) ||
      /^gpt-(?:.*-)?(?:realtime|transcribe|tts)(?:-|$)/.test(id) ||
      /^(?:babbage|davinci)-002$/.test(id)
    )
      return "other"
    // Audio chat models use Chat Completions, not the Responses transport.
    if (wireApi === "openai_responses" && /^gpt-(?:.*-)?audio(?:-|$)/.test(id))
      return "other"
  }
  // xAI's /models omits output modalities for its generation models.
  // These documented API families use /images and /videos, not /responses.
  // https://docs.x.ai/developers/model-capabilities/images/generation
  // https://docs.x.ai/developers/model-capabilities/video/generation
  if (
    (provider === "grok" || provider === "xai") &&
    typeof entry.id === "string"
  ) {
    if (/^grok-imagine-image(?:-|$)/.test(entry.id)) return "image"
    if (/^grok-imagine-video(?:-|$)/.test(entry.id)) return "video"
  }
  if (["chat", "image", "video", "other"].includes(String(entry.kind)))
    return entry.kind as ConfiguredModel["kind"]
  const architecture = entry.architecture
  const outputs =
    typeof architecture === "object" &&
    architecture !== null &&
    "output_modalities" in architecture
      ? architecture.output_modalities
      : entry.output_modalities
  if (Array.isArray(outputs) && outputs.length) {
    if (outputs.includes("image")) return "image"
    if (outputs.includes("video")) return "video"
    if (outputs.includes("text")) return "chat"
    return "other"
  }
  return undefined
}
