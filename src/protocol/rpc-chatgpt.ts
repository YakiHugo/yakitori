import type { ChatGPTConnectionState } from "./connections.ts"
export type ChatGPTRpcParams = {
  "chatgpt/read": Record<string, never>
  "chatgpt/signIn": Readonly<{ accountId?: string; label?: string }>
  "chatgpt/cancel": Readonly<{ attemptId: string }>
  "chatgpt/signOut": Readonly<{ accountId: string }>
  "chatgpt/acknowledge": Record<string, never>
}

export type ChatGPTRpcResponses = {
  [Method in keyof ChatGPTRpcParams]: ChatGPTConnectionState
}
