import type { ModelSelection } from "./events.ts"
import type { RuntimePermissionRequest } from "./permissions.ts"
import type { InputContent } from "./user-input.ts"

export type SideChatMessage = {
  id: string
  turnId: string
  streaming: boolean
} & (
  | { role: "user"; content: InputContent }
  | { role: "assistant"; text: string }
)

export type SideChatSnapshot = {
  id: string
  revision: number
  cwd: string
  modelSelection: ModelSelection
  expiresAt: string
  messages: SideChatMessage[]
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
