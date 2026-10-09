export type ChatGPTConnectionState = Readonly<{
  accounts: readonly Readonly<{
    id: string
    label: string
    email?: string
    providerId: string
    state: "connected" | "identity_only" | "signed_out"
    remoteRevocation?: "confirmed" | "unconfirmed"
  }>[]
  attempt?: Readonly<{
    id: string
    accountId?: string
    state: "waiting" | "succeeded" | "cancelled" | "failed" | "identity_only"
    message?: string
  }>
  welcomeRequired: boolean
}>

export const computerUseServerName = "cua_repl"

export type ComputerUseStatus = Readonly<{
  available: boolean
  connected: boolean
  backend: "codex-unified" | null
  serverName: typeof computerUseServerName
  tools: readonly string[]
  message?: string
}>

export type McpServerSummary = Readonly<{
  name: string
  transport: "stdio" | "http"
  enabled: boolean
  state: "ready" | "stopped" | "failed" | "unconnected" | "connecting"
  toolCount: number
  required: boolean
  authenticated: boolean
  loginState?: "pending" | "failed"
  error?: string
}>
