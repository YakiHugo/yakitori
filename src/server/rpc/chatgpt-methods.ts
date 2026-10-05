import type {
  ChatGPTConnectionState,
  ChatGPTConnections,
} from "../chatgpt-connections.ts"
import { ConfigurationError } from "../config-errors.ts"
import type { RpcMethodDefinition } from "./methods.ts"

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
export const chatGPTMethods: readonly RpcMethodDefinition[] = [
  {
    method: "chatgpt/read",
    scope: () => ({ kind: "globalSharedRead", name: "config" }),
    async invoke(_params, context) {
      return { result: await requireService(context.chatgpt).read() }
    },
  },
  {
    method: "chatgpt/signIn",
    scope: () => ({ kind: "global", name: "config" }),
    async invoke(params, context) {
      const record = requireRecord(params)
      return {
        result: await requireService(context.chatgpt).signIn({
          ...(record.accountId === undefined
            ? {}
            : { accountId: text(record.accountId, "accountId") }),
          ...(record.label === undefined
            ? {}
            : { label: text(record.label, "label") }),
        }),
      }
    },
  },
  {
    method: "chatgpt/cancel",
    scope: () => undefined,
    async invoke(params, context) {
      return {
        result: await requireService(context.chatgpt).cancel(
          text(requireRecord(params).attemptId, "attemptId"),
        ),
      }
    },
  },
  {
    method: "chatgpt/signOut",
    scope: () => ({ kind: "global", name: "config" }),
    async invoke(params, context) {
      return {
        result: await requireService(context.chatgpt).signOut(
          text(requireRecord(params).accountId, "accountId"),
        ),
      }
    },
  },
  {
    method: "chatgpt/acknowledge",
    scope: () => ({ kind: "global", name: "config" }),
    async invoke(_params, context) {
      return { result: await requireService(context.chatgpt).acknowledge() }
    },
  },
]
function requireService(service: ChatGPTConnections | undefined) {
  if (!service)
    throw new ConfigurationError("ChatGPT connections are unavailable.")
  return service
}
function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ConfigurationError("ChatGPT parameters must be an object.")
  return value as Record<string, unknown>
}
function text(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim())
    throw new ConfigurationError(`ChatGPT ${name} is required.`)
  return value
}
