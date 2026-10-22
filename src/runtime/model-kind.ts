import type { ConfiguredModel } from "../protocol/providers.ts"

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
): ConfiguredModel["kind"] {
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
  // xAI's /models omits output modalities for its generation models.
  // These documented API families use /images and /videos, not /responses.
  // https://docs.x.ai/developers/model-capabilities/images/generation
  // https://docs.x.ai/developers/model-capabilities/video/generation
  if (provider === "grok" && typeof entry.id === "string") {
    if (/^grok-imagine-image(?:-|$)/.test(entry.id)) return "image"
    if (/^grok-imagine-video(?:-|$)/.test(entry.id)) return "video"
  }
  return undefined
}
