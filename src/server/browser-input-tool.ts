import {
  BrowserControlError,
  type DesktopBrowser,
  parseBrowserInputRequest,
} from "../protocol/desktop-browser.ts"
import { plainToolName } from "../runtime/tools/tool-name.ts"
import type {
  RuntimeTool,
  ToolExecutionContext,
  ToolFailure,
} from "../runtime/tools/types.ts"

export function createBrowserInputTool(
  browser: DesktopBrowser,
  admit: (context: ToolExecutionContext) => Promise<ToolFailure | undefined>,
): RuntimeTool {
  return {
    toolName: plainToolName("browser_input"),
    description:
      "Type text into an exact text input or textarea observed by the browser tool in this turn. Use its inputReference and exact target. This inserts at the control's current selection; it does not clear the field. Each attempt consumes all references from that observation. The document and focused control are checked before dispatch and the resulting value is checked afterward. On browser_input_unconfirmed, observe again and never automatically replay text. No physical keyboard, clipboard, arbitrary page code or remote debugging port is used. Computer use must be connected; normal permission and shared turn ownership apply. Nonempty text, with a 64KiB per-event implementation safety bound.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action", "target", "reference", "text"],
      properties: {
        action: { type: "string", enum: ["type"] },
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
        reference: { type: "string" },
        text: { type: "string", minLength: 1 },
      },
    },
    effect: "mutate",
    exposure: "deferred",
    supportsParallelToolCalls: false,
    approvalRequirement: {
      kind: "approval",
      action: "command_execution",
      subject: "Type into the connected desktop browser",
    },
    async execute(input, context) {
      context.signal?.throwIfAborted()
      try {
        const request = parseBrowserInputRequest(input),
          refusal = await admit(context)
        if (refusal) return refusal
        if (!context.threadId || !context.turnId)
          throw new Error("Browser input requires an owning session and turn.")
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
