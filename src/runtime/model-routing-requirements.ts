import type { SessionConfigurationSnapshot } from "../kernel/events.ts"
import type { UserAttachment } from "../protocol/asset-types.ts"
import type { ModelRouteRequirements } from "../protocol/model-routing.ts"
import type { ModelMessage } from "./model.ts"

// Routing reads active model history. The GUI transcript also contains content
// removed by compaction and cannot establish the next request's requirements.
export function modelRoutingRequirements(
  input: Readonly<{
    history: readonly ModelMessage[]
    attachments?: readonly UserAttachment[]
    configuration?: SessionConfigurationSnapshot
  }>,
): ModelRouteRequirements & Readonly<{ preferredAccount?: string }> {
  const attachments = input.attachments ?? []
  let image = attachments.some((file) => file.mediaType.startsWith("image/"))
  let original = attachments.some(
    (file) => "detail" in file && file.detail === "original",
  )
  for (const message of input.history) {
    if (message.role !== "user" && message.role !== "tool") continue
    for (const block of message.content) {
      if (block.type !== "image") continue
      image = true
      original ||= block.detail === "original"
    }
  }

  return {
    ...(image ? { inputModalities: ["image"] } : {}),
    ...(original ? { imageDetail: "original" } : {}),
    ...(input.configuration === undefined
      ? {}
      : { preferredAccount: input.configuration.defaultTarget.provider }),
    ...(input.configuration?.modelContextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: input.configuration.modelContextWindowTokens }),
  }
}
