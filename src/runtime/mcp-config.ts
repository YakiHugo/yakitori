// Node timers clamp larger delays to 1ms. This is a host implementation
// boundary, not an MCP service quota.
export const MAX_MCP_TIMEOUT_MS = 2_147_483_647

type McpServerOptions = Readonly<{
  enabled?: boolean
  // Required servers block Session creation and fail it when they cannot
  // connect; optional servers connect in the background (codex-rs
  // McpServerConfig.required).
  required?: boolean
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
        oauth?: Readonly<{
          clientId?: string
          clientSecretEnvVar?: string
          scopes?: readonly string[]
        }>
      }>
  )
