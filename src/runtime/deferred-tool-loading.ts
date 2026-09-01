import type { ModelRequest } from "./model.ts"

export type NativeDeferredToolProtocol = "anthropic" | "openai"

export function nativeDeferredToolProtocol(
  request: Pick<ModelRequest, "tools" | "toolWireProtocol">,
): NativeDeferredToolProtocol | undefined {
  if (
    !request.tools.some((tool) => tool.kind === "tool_search") ||
    !request.tools.some((tool) => tool.deferLoading === true)
  ) {
    return undefined
  }
  if (request.toolWireProtocol === "anthropic_deferred") return "anthropic"
  if (request.toolWireProtocol === "openai_deferred") return "openai"
  return undefined
}
