import {
  type ChatCompletionsFlavor,
  resolveChatCompletionsDialect,
} from "../../src/runtime/chat-completions-dialects.ts"
import { providerServices } from "../../src/runtime/provider-services.ts"

export function fixtureChatEndpoint(flavor: ChatCompletionsFlavor) {
  if (flavor === "gemini")
    return "https://generativelanguage.googleapis.com/v1beta/openai"
  return (
    providerServices.find((service) => service.id === flavor)?.baseURL ??
    "https://relay.example/v1"
  )
}

export function fixtureChatDialect(
  flavor: ChatCompletionsFlavor,
  model = "test",
) {
  return resolveChatCompletionsDialect(
    { flavor, baseURL: fixtureChatEndpoint(flavor) },
    model,
  )
}
