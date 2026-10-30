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

export type BrowserInputRequest = Readonly<{
  action: "type" | "fill"
  target: BrowserTarget
  reference: string
  text: string
}>

export function parseBrowserInputRequest(value: unknown): BrowserInputRequest {
  if (
    isJsonObject(value) &&
    Object.keys(value).length === 4 &&
    Object.keys(value).every((key) =>
      ["action", "target", "reference", "text"].includes(key),
    ) &&
    (value.action === "type" || value.action === "fill") &&
    typeof value.reference === "string" &&
    /^browser_node_[a-f0-9-]{36}$/.test(value.reference) &&
    typeof value.text === "string" &&
    (value.text.length > 0 || value.action === "fill") &&
    Buffer.byteLength(value.text) <= 64 * 1024
  ) {
    const observed = parseBrowserObservationRequest({
      action: "observe",
      target: value.target,
    })
    if (observed.action !== "observe")
      throw new Error("Invalid browser target parser result.")
    return {
      action: value.action,
      target: observed.target,
      reference: value.reference,
      text: value.text,
    }
  }
  throw new BrowserControlError(
    "invalid_arguments",
    "Use type or fill with an exact target and a current inputReference; only fill accepts empty text (64KiB input-event safety bound).",
  )
}

export type BrowserNavigationRequest = Readonly<{
  action: "navigate"
  target: BrowserTarget
  fromUrl: string
  url: string
}>

export function parseBrowserNavigationRequest(
  value: unknown,
): BrowserNavigationRequest {
  if (
    isJsonObject(value) &&
    Object.keys(value).length === 4 &&
    Object.keys(value).every((key) =>
      ["action", "target", "fromUrl", "url"].includes(key),
    ) &&
    value.action === "navigate" &&
    typeof value.fromUrl === "string" &&
    value.fromUrl.length <= 8192 &&
    typeof value.url === "string" &&
    value.url.length <= 8192 &&
    URL.canParse(value.url)
  ) {
    const url = new URL(value.url)
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    ) {
      const observed = parseBrowserObservationRequest({
        action: "observe",
        target: value.target,
      })
      if (observed.action !== "observe")
        throw new Error("Invalid browser target parser result.")
      return {
        action: "navigate",
        target: observed.target,
        fromUrl: value.fromUrl,
        url: url.href,
      }
    }
  }
  throw new BrowserControlError(
    "invalid_arguments",
    "Use navigate with an exact listed target, its current fromUrl and an absolute HTTP(S) destination without credentials (8192-character URL safety bound).",
  )
}

export function parseBrowserRequest(
  value: unknown,
): BrowserObservationRequest | BrowserInputRequest | BrowserNavigationRequest {
  if (isJsonObject(value) && value.action === "navigate")
    return parseBrowserNavigationRequest(value)
  return isJsonObject(value) &&
    (value.action === "type" || value.action === "fill")
    ? parseBrowserInputRequest(value)
    : parseBrowserObservationRequest(value)
}

export class BrowserControlError extends Error {
  readonly code: string
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
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

export type BrowserOwner = Readonly<{ sessionId: string; turnId: string }>

export function parseBrowserOwner(value: unknown): BrowserOwner {
  if (
    isJsonObject(value) &&
    Object.keys(value).length === 2 &&
    Object.keys(value).every(
      (key) => key === "sessionId" || key === "turnId",
    ) &&
    typeof value.sessionId === "string" &&
    /^[A-Za-z0-9_-]{1,256}$/.test(value.sessionId) &&
    typeof value.turnId === "string" &&
    /^[A-Za-z0-9_-]{1,256}$/.test(value.turnId)
  )
    return { sessionId: value.sessionId, turnId: value.turnId }
  throw new BrowserControlError(
    "invalid_arguments",
    "Browser operations require an owning session and turn.",
  )
}

export type BrowserOperation = Readonly<
  | {
      operation: "request"
      owner: BrowserOwner
      input:
        | BrowserObservationRequest
        | BrowserInputRequest
        | BrowserNavigationRequest
    }
  | { operation: "finishTurn"; owner: BrowserOwner }
  | { operation: "closeSession"; sessionId: string }
>
export type DesktopBrowserRequest = Readonly<{
  type: "desktop_browser/request"
  requestId: string
}> &
  BrowserOperation
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
    input:
      | BrowserObservationRequest
      | BrowserInputRequest
      | BrowserNavigationRequest,
    owner: BrowserOwner,
    signal?: AbortSignal,
  ): Promise<JsonObject>
  finishTurn(owner: BrowserOwner): Promise<void>
  closeSession(sessionId: string): Promise<void>
}>
