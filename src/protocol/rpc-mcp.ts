import type { McpServerSummary } from "./connections.ts"

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
