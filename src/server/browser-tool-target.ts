import {
  BrowserControlError,
  type BrowserRequest,
  type DesktopBrowser,
  parseBrowserObservationRequest,
  parseBrowserRequest,
} from "../protocol/desktop-browser.ts"
import type { JsonObject } from "../protocol/events.ts"
import { isJsonObject } from "../protocol/json.ts"
import type {
  ToolExecutionContext,
  ToolFailure,
} from "../runtime/tools/types.ts"

export function browserTargetClient(
  browser: DesktopBrowser,
  context: ToolExecutionContext,
) {
  const { threadId: sessionId, turnId, signal } = context
  if (!sessionId || !turnId)
    throw new Error("Browser operations require an owning turn.")
  const request = (input: BrowserRequest) =>
    browser.request(input, { sessionId, turnId }, signal)
  return {
    request,
    async resolveDownload(downloadId: unknown, tabId: unknown) {
      const data = await request(
        parseBrowserRequest({ action: "download_target", downloadId }),
      )
      const selected = parseBrowserObservationRequest({
        action: "observe",
        target: data.target,
      })
      if (selected.action !== "observe")
        throw new Error("Desktop did not identify the download's tab.")
      if (tabId !== undefined && tabId !== selected.target.tabId)
        throw new BrowserControlError(
          "browser_download_stale",
          "The download belongs to a different tab.",
        )
      return { target: selected.target, url: "" }
    },
    async resolve(tabId: unknown) {
      if (
        tabId !== undefined &&
        (typeof tabId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(tabId))
      )
        throw new BrowserControlError(
          "invalid_arguments",
          "tabId must identify a listed browser tab.",
        )
      const data = await request({
        action: "target",
        ...(tabId === undefined ? {} : { tabId }),
      })
      const selected = parseBrowserObservationRequest({
        action: "observe",
        target: data.target,
      })
      if (selected.action !== "observe" || typeof data.url !== "string")
        throw new Error("Desktop did not identify the resolved tab.")
      return { target: selected.target, url: data.url }
    },
  }
}

export function browserModelResult(result: JsonObject): JsonObject {
  const { target, ...data } = result
  return {
    ...(isJsonObject(target) && typeof target.tabId === "string"
      ? { tabId: target.tabId }
      : {}),
    ...data,
  }
}

export function browserToolFailure(cause: unknown): ToolFailure {
  if (!(cause instanceof BrowserControlError)) throw cause
  return {
    ok: false,
    code: cause.code,
    message: cause.message,
    content: cause.message,
  }
}

export function browserDataText(kind: string, body: string): string {
  return `<${kind} data-only="true">\n${body.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")}\n</${kind}>`
}
