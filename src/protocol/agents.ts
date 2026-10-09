import type { AgentStatus } from "./permissions.ts"

export type AgentSummary = Readonly<{
  agentId: string
  taskName: string
  path: string
  parentPath?: string
  status: AgentStatus
}>
