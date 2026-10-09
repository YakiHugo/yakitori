import type {
  SideChatCreate,
  SideChatSend,
  SideChatSnapshot,
} from "./side-chat.ts"
export type SideChatRpcParams = {
  "sideChat/create": SideChatCreate
  "sideChat/read": { sideChatId: string }
  "sideChat/send": SideChatSend
  "sideChat/cancel": { sideChatId: string; turnId: string }
  "sideChat/close": { sideChatId: string }
  "sideChat/resolvePermission": {
    sideChatId: string
    turnId: string
    permissionRequestId: string
    behavior: "allow" | "deny"
  }
}

export type SideChatRpcResponses = {
  "sideChat/create": SideChatSnapshot
  "sideChat/read": SideChatSnapshot
  "sideChat/send": SideChatSnapshot
  "sideChat/cancel": SideChatSnapshot
  "sideChat/close": Record<string, never>
  "sideChat/resolvePermission": SideChatSnapshot
}
