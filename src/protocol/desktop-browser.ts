import type { JsonObject } from "./events.ts"
import { isJsonObject } from "./json.ts"

export type BrowserTarget = Readonly<{
  tabId: string
  webContentsId: number
  instanceId: string
}>
export type BrowserObservationRequest =
  | Readonly<{ action: "list"; offset?: number }>
  | Readonly<{ action: "observe"; target: BrowserTarget }>

export class BrowserControlError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export function parseBrowserObservationRequest(
  value: unknown,
): BrowserObservationRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new BrowserControlError(
      "invalid_arguments",
      "Browser control requires an object.",
    )
  const input = value as Record<string, unknown>
  if (!Object.hasOwn(input, "action"))
    throw new BrowserControlError(
      "invalid_arguments",
      "Browser action must be an own field.",
    )
  if (
    input.action === "list" &&
    Object.keys(input).every((key) => key === "action" || key === "offset") &&
    (input.offset === undefined ||
      (typeof input.offset === "number" &&
        Number.isSafeInteger(input.offset) &&
        input.offset >= 0))
  )
    return {
      action: "list",
      ...(input.offset === undefined ? {} : { offset: input.offset }),
    }
  if (
    input.action === "observe" &&
    Object.keys(input).length === 2 &&
    Object.keys(input).every((key) => key === "action" || key === "target") &&
    typeof input.target === "object" &&
    input.target !== null &&
    !Array.isArray(input.target)
  ) {
    const target = input.target as Record<string, unknown>
    if (
      Object.keys(target).length === 3 &&
      Object.keys(target).every((key) =>
        ["tabId", "webContentsId", "instanceId"].includes(key),
      ) &&
      typeof target.tabId === "string" &&
      /^[A-Za-z0-9_-]{1,256}$/.test(target.tabId) &&
      typeof target.webContentsId === "number" &&
      Number.isSafeInteger(target.webContentsId) &&
      target.webContentsId > 0 &&
      typeof target.instanceId === "string" &&
      /^browser_target_[a-f0-9-]{36}$/.test(target.instanceId)
    )
      return {
        action: "observe",
        target: {
          tabId: target.tabId,
          webContentsId: target.webContentsId,
          instanceId: target.instanceId,
        },
      }
  }
  throw new BrowserControlError(
    "invalid_arguments",
    "Use list, or observe with the exact tabId, webContentsId and instanceId target returned by list. Extra fields are not accepted.",
  )
}

export type DesktopBrowserRequest = Readonly<{
  type: "desktop_browser/request"
  requestId: string
  input: BrowserObservationRequest
}>
export type DesktopBrowserCancellation = Readonly<{
  type: "desktop_browser/cancel"
  requestId: string
}>
export type DesktopBrowserResponse = Readonly<
  {
    type: "desktop_browser/response"
    requestId: string
  } & (
    | { ok: true; result: JsonObject }
    | { ok: false; code: string; error: string }
  )
>

export function isDesktopBrowserResponse(
  value: unknown,
): value is DesktopBrowserResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    value.type !== "desktop_browser/response" ||
    !("requestId" in value) ||
    typeof value.requestId !== "string" ||
    !("ok" in value)
  )
    return false
  return value.ok === true
    ? "result" in value && isJsonObject(value.result)
    : value.ok === false &&
        "code" in value &&
        typeof value.code === "string" &&
        "error" in value &&
        typeof value.error === "string"
}

export type DesktopBrowser = Readonly<{
  request(
    input: BrowserObservationRequest,
    signal?: AbortSignal,
  ): Promise<JsonObject>
}>
