import type { ModelSelection } from "./events.ts"
import type { ExecutionView } from "./execution-view.ts"
import type { RuntimePermissionRequest } from "./permissions.ts"
import type { InputContent } from "./user-input.ts"

export type SideChatSnapshot = {
  id: string
  revision: number
  cwd: string
  modelSelection: ModelSelection
  expiresAt: string
  execution: ExecutionView
  activeTurnId?: string
  error?: string
  pendingPermissions?: readonly RuntimePermissionRequest[]
}

export type SideChatCreate = {
  sourceSessionId?: string
  cwd?: string
  modelSelection?: ModelSelection
}

export type SideChatSend = {
  content: InputContent
  sideChatId: string
  requestId: string
  modelSelection?: ModelSelection
}
