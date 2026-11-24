import {
  BrowserControlError,
  type DesktopBrowser,
  parseBrowserViewRequest,
} from "../protocol/desktop-browser.ts"
import { plainToolName } from "../runtime/tools/tool-name.ts"
import type { RuntimeTool } from "../runtime/tools/types.ts"

export function createBrowserViewTool(browser: DesktopBrowser): RuntimeTool {
  return {
    toolName: plainToolName("browser_view"),
    description:
      "Explicitly select and display an exact managed browser tab in the currently selected conversation's Yakitori workspace. Use show with target and its current fromUrl from browser list; close closes that exact tab after approval. This changes workspace UI and uses normal command permission plus per-tab browser ownership. It refuses tabs from other conversations or while settings are open. It does not restore or focus the OS window; use an explicitly approved native computer action if that is needed. selectionApplied confirms the renderer's completed selection; visible confirms the embedded view became available before its five-second layout safety deadline. A hidden/minimized window or a later user tab change can leave visible false. Directory uploads require a displayed view. Cancellation before the renderer claims the request prevents it from being applied; a claimed request retains ownership until acknowledgement or renderer termination. Do not replay an unconfirmed result automatically.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action", "target", "fromUrl"],
      properties: {
        action: { type: "string", enum: ["show", "close"] },
        target: {
          type: "object",
          additionalProperties: false,
          required: ["tabId", "webContentsId", "instanceId"],
          properties: {
            tabId: { type: "string" },
            webContentsId: { type: "integer", minimum: 1 },
            instanceId: { type: "string" },
          },
        },
        fromUrl: { type: "string", maxLength: 8192 },
      },
    },
    effect: "mutate",
    exposure: "deferred",
    supportsParallelToolCalls: false,
    approvalRequirement(input) {
      try {
        const request = parseBrowserViewRequest(input)
        return {
          kind: "approval",
          action: "command_execution",
          subject: `${request.action === "show" ? "Show" : "Close"} browser tab: ${request.fromUrl || "(blank)"}`,
        }
      } catch (cause) {
        if (!(cause instanceof BrowserControlError)) throw cause
        return {
          kind: "approval",
          action: "command_execution",
          subject: "Show or close a tab in the connected desktop browser",
        }
      }
    },
    async execute(input, context) {
      context.signal?.throwIfAborted()
      try {
        const request = parseBrowserViewRequest(input)
        if (!context.threadId || !context.turnId)
          throw new Error(
            "Browser display requires an owning session and turn.",
          )
        const result = await browser.request(
          request,
          { sessionId: context.threadId, turnId: context.turnId },
          context.signal,
        )
        context.signal?.throwIfAborted()
        return { ok: true, output: result, content: JSON.stringify(result) }
      } catch (cause) {
        if (!(cause instanceof BrowserControlError)) throw cause
        return {
          ok: false,
          code: cause.code,
          message: cause.message,
          content: cause.message,
        }
      }
    },
  }
}
