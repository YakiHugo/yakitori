// Node timers clamp larger delays to 1ms. This is a host implementation
// boundary, not an MCP service quota.
export const MAX_MCP_TIMEOUT_MS = 2_147_483_647

type McpServerOptions = Readonly<{
  enabled?: boolean
  startupTimeoutMs?: number
  toolTimeoutMs?: number
  enabledTools?: readonly string[]
  disabledTools?: readonly string[]
}>

export type McpServerConfig = McpServerOptions &
  (
    | Readonly<{
        command: string
        args?: readonly string[]
        cwd?: string
        env?: Readonly<Record<string, string>>
      }>
    | Readonly<{
        url: string
        httpHeaders?: Readonly<Record<string, string>>
        envHttpHeaders?: Readonly<Record<string, string>>
        bearerTokenEnvVar?: string
      }>
  )
