import {
  isImageAttachment,
  isModelSelection,
  type ModelSelection,
} from "../../kernel/events.ts"
import { isContextExcerpts } from "../../kernel/input-context.ts"
import {
  SideChatError,
  type SideChatCreate,
  type SideChatSend,
  type SideChatService,
  type SideChatSnapshot,
} from "../side-chat.ts"
import { INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND } from "./messages.ts"
import { RpcMethodError, type RpcMethodDefinition } from "./methods.ts"

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

function string(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== "string" || !value.trim())
    throw new SideChatError(`${key} must be a nonempty string.`)
  return value
}

function model(params: Record<string, unknown>): {
  modelSelection?: ModelSelection
} {
  if (params.modelSelection === undefined) return {}
  if (!isModelSelection(params.modelSelection))
    throw new SideChatError("modelSelection must specify a provider and model.")
  return { modelSelection: params.modelSelection }
}

function entry(
  method: keyof SideChatRpcParams,
  invoke: (
    service: SideChatService,
    params: Record<string, unknown>,
  ) => unknown,
): RpcMethodDefinition {
  return {
    method,
    scope: (params) =>
      method === "sideChat/create"
        ? undefined
        : {
            kind: "session",
            sessionId: `side:${typeof params === "object" && params !== null && "sideChatId" in params ? String(params.sideChatId) : ""}`,
          },
    async invoke(params, context) {
      if (context.sideChats === undefined)
        throw new RpcMethodError(
          METHOD_NOT_FOUND,
          "Side conversations are unavailable.",
        )
      try {
        if (
          typeof params !== "object" ||
          params === null ||
          Array.isArray(params)
        )
          throw new SideChatError("Expected side conversation parameters.")
        return {
          result: await invoke(
            context.sideChats,
            params as Record<string, unknown>,
          ),
        }
      } catch (error) {
        if (error instanceof SideChatError)
          throw new RpcMethodError(
            error.code === "invalid_input" ? INVALID_PARAMS : INTERNAL_ERROR,
            error.message,
            { code: error.code },
          )
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT" || code === "ENOTDIR")
          throw new RpcMethodError(
            INTERNAL_ERROR,
            "The working directory does not exist.",
            { code: "not_found" },
          )
        throw error
      }
    },
  }
}

export const sideChatMethods: readonly RpcMethodDefinition[] = [
  entry("sideChat/create", (service, params) =>
    service.create({
      ...(params.cwd === undefined ? {} : { cwd: string(params, "cwd") }),
      ...(params.sourceSessionId === undefined
        ? {}
        : { sourceSessionId: string(params, "sourceSessionId") }),
      ...model(params),
    }),
  ),
  entry("sideChat/read", (service, params) =>
    service.read(string(params, "sideChatId")),
  ),
  entry("sideChat/send", (service, params) => {
    if (typeof params.text !== "string")
      throw new SideChatError("text must be a string.")
    if (
      params.contextAttachments !== undefined &&
      !isContextExcerpts(params.contextAttachments)
    )
      throw new SideChatError(
        "contextAttachments must contain valid context excerpts.",
      )
    if (
      params.attachments !== undefined &&
      (!Array.isArray(params.attachments) ||
        !params.attachments.every(isImageAttachment))
    )
      throw new SideChatError(
        "attachments must contain valid image attachments.",
      )
    return service.send({
      sideChatId: string(params, "sideChatId"),
      text: params.text,
      requestId: string(params, "requestId"),
      ...(params.contextAttachments === undefined
        ? {}
        : { contextAttachments: params.contextAttachments }),
      ...(params.attachments === undefined
        ? {}
        : { attachments: params.attachments }),
      ...model(params),
    })
  }),
  entry("sideChat/cancel", (service, params) =>
    service.cancel(string(params, "sideChatId"), string(params, "turnId")),
  ),
  entry("sideChat/resolvePermission", (service, params) => {
    if (params.behavior !== "allow" && params.behavior !== "deny")
      throw new SideChatError("behavior must be allow or deny.")
    return service.resolvePermission({
      sideChatId: string(params, "sideChatId"),
      turnId: string(params, "turnId"),
      permissionRequestId: string(params, "permissionRequestId"),
      behavior: params.behavior,
    })
  }),
  entry("sideChat/close", async (service, params) => {
    await service.remove(string(params, "sideChatId"))
    return {}
  }),
]
