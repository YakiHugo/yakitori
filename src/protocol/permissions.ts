import type { TurnCompletion } from "./events.ts"

export type AgentStatus =
  | "pending_init"
  | "running"
  | "interrupted"
  | "shutdown"
  | "not_found"
  | Readonly<{
      completed: string | null
      reason?: NonNullable<TurnCompletion["reason"]>
    }>
  | { readonly errored: string }

export type SessionPermissionReason = {
  readonly kind: string
  readonly message?: string
}

export type SessionPermissionEvent =
  | {
      readonly type: "permission.requested"
      readonly permissionRequestId: string
      readonly sessionId: string
      readonly turnId: string
      readonly toolCallId: string
      readonly action: string
      readonly subject?: string
      readonly reason?: string
      readonly createdAt: string
    }
  | {
      readonly type: "permission.resolved"
      readonly permissionRequestId: string
      readonly sessionId: string
      readonly turnId: string
      readonly outcome: "allow" | "deny" | "timeout" | "aborted"
      readonly reason?: SessionPermissionReason
      readonly createdAt: string
    }
