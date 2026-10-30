import {
  BrowserControlError,
  type DesktopBrowser,
  parseBrowserNavigationRequest,
} from "../protocol/desktop-browser.ts"
import { plainToolName } from "../runtime/tools/tool-name.ts"
import type {
  RuntimeTool,
  ToolExecutionContext,
  ToolFailure,
} from "../runtime/tools/types.ts"

export function createBrowserNavigationTool(
  browser: DesktopBrowser,
  admit: (context: ToolExecutionContext) => Promise<ToolFailure | undefined>,
): RuntimeTool {
  return {
    toolName: plainToolName("browser_navigate"),
    description:
      "Navigate an exact browser target owned by Yakitori desktop. Pass target and its current URL as fromUrl from browser list; blank tabs are supported. Destination must be an absolute HTTP(S) URL without credentials, matching the workspace browser policy. A changed/loading source refuses navigation. This waits for page load, including redirects; loaded means Electron completed loading, not HTTP or business success. Cancellation stops only this load, never a later user navigation. An unconfirmed result must be inspected with browser list; never replay automatically. Normal permission and shared computer ownership apply. URL implementation safety bound:8192 characters.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action", "target", "fromUrl", "url"],
      properties: {
        action: { type: "string", enum: ["navigate"] },
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
        fromUrl: { type: "string" },
        url: { type: "string" },
      },
    },
    effect: "mutate",
    exposure: "deferred",
    supportsParallelToolCalls: false,
    approvalRequirement: {
      kind: "approval",
      action: "command_execution",
      subject: "Navigate the connected desktop browser",
    },
    async execute(input, context) {
      context.signal?.throwIfAborted()
      try {
        const request = parseBrowserNavigationRequest(input),
          refusal = await admit(context)
        if (refusal) return refusal
        if (!context.threadId || !context.turnId)
          throw new Error(
            "Browser navigation requires an owning session and turn.",
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
