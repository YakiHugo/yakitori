import { BrowserControlError } from "../../protocol/desktop-browser.ts"
import { isJsonObject } from "../../protocol/json.ts"
import { INTERNAL_ERROR, INVALID_PARAMS } from "./messages.ts"
import { type RpcMethodDefinition, RpcMethodError } from "./methods.ts"

export const browserTakeoverMethod: RpcMethodDefinition = {
  method: "browser/takeover",
  shutdownContinuation: true,
  scope: () => undefined,
  async invoke(params, context) {
    if (
      !isJsonObject(params) ||
      Object.keys(params).length !== 1 ||
      typeof params.tabId !== "string" ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(params.tabId)
    )
      throw new RpcMethodError(
        INVALID_PARAMS,
        "Select a workspace browser tab to take over.",
      )
    if (!context.browserControl)
      throw new RpcMethodError(
        INTERNAL_ERROR,
        "Browser control requires the desktop app.",
      )
    try {
      await context.browserControl.takeOver(params.tabId)
      return { result: {} }
    } catch (cause) {
      if (!(cause instanceof BrowserControlError)) throw cause
      throw new RpcMethodError(INTERNAL_ERROR, cause.message, {
        code: cause.code,
      })
    }
  },
}
