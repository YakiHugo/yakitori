export type McpServerConfig = Readonly<{
  command: string
  args?: readonly string[]
  cwd?: string
  env?: Readonly<Record<string, string>>
  enabled?: boolean
  startupTimeoutMs?: number
}>
