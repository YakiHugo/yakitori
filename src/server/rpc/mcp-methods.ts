import type { McpServerSummary } from "../mcp-service.ts"
import { McpServiceError } from "../mcp-service.ts"
import { INTERNAL_ERROR, INVALID_PARAMS } from "./messages.ts"
import { type RpcMethodDefinition, RpcMethodError } from "./methods.ts"

type ServerParams = Readonly<{ name: string; sessionId?: string }>
export type McpRpcParams = {
  "mcp/status": Readonly<{ sessionId?: string }>
  "mcp/login": ServerParams
  "mcp/logout": ServerParams
  "mcp/reconnect": ServerParams
}
export type McpRpcResponses = {
  "mcp/status": { servers: readonly McpServerSummary[] }
  "mcp/login": { authorizationUrl: string }
  "mcp/logout": Record<string, never>
  "mcp/reconnect": Record<string, never>
}

export const mcpMethods: readonly RpcMethodDefinition[] = (
  ["mcp/status", "mcp/login", "mcp/logout", "mcp/reconnect"] as const
).map((method) => ({
  method,
  scope: () => undefined,
  async invoke(params, context) {
    if (typeof params !== "object" || params === null || Array.isArray(params))
      throw new RpcMethodError(INVALID_PARAMS, "Expected an object.")
    const sessionId = "sessionId" in params ? params.sessionId : undefined
    if (
      sessionId !== undefined &&
      (typeof sessionId !== "string" || sessionId === "")
    )
      throw new RpcMethodError(INVALID_PARAMS, "Invalid sessionId.")
    const service = context.mcp
    if (!service)
      throw new RpcMethodError(
        INTERNAL_ERROR,
        "MCP configuration is unavailable.",
      )
    try {
      if (method === "mcp/status")
        return { result: await service.status(sessionId) }
      if (
        !("name" in params) ||
        typeof params.name !== "string" ||
        params.name.trim() === ""
      )
        throw new RpcMethodError(INVALID_PARAMS, "A server name is required.")
      if (method === "mcp/login")
        return { result: await service.login(params.name, sessionId) }
      if (method === "mcp/logout")
        return { result: await service.logout(params.name, sessionId) }
      return { result: await service.reconnect(params.name, sessionId) }
    } catch (error) {
      if (error instanceof McpServiceError)
        throw new RpcMethodError(INVALID_PARAMS, error.message)
      throw error
    }
  },
}))
