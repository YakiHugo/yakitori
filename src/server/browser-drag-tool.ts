import {
  BrowserControlError,
  type DesktopBrowser,
  parseBrowserDragRequest,
} from "../protocol/desktop-browser.ts"
import { isJsonObject } from "../protocol/json.ts"
import { plainToolName } from "../runtime/tools/tool-name.ts"
import type {
  RuntimeTool,
  ToolExecutionContext,
  ToolFailure,
} from "../runtime/tools/types.ts"

export function createBrowserDragTool(
  browser: DesktopBrowser,
  admit: (context: ToolExecutionContext) => Promise<ToolFailure | undefined>,
  markCleanupPending: (context: ToolExecutionContext) => void,
): RuntimeTool {
  return {
    toolName: plainToolName("browser_drag"),
    description:
      "Drag between exact observed controls in one managed browser tab, including selected frames. Use browser_view show first: native dragging requires a visible embedded view in a restored Yakitori window. The host waits up to five seconds for approval-overlay layout to settle and otherwise refuses before pressing; it never silently shows a page. First prepare with a source elementReference; this consumes that observation and returns a single-use dragId without pressing the mouse. Observe the destination, then drop with dragId and the destination elementReference. cancel discards a prepared source. Another input or source preparation invalidates the prior source; observing a destination preserves it. Both original documents and iframe ancestry must still match. The host scrolls and hit-tests each endpoint, starts the drag before scrolling to its destination, sends trusted browser mouse input and uses Chromium native HTML5 drag data when the page starts a native drag. Native drag data never enters the model response. Local files are refused; use browser_upload for file inputs. Implementation safety bounds: 64 native drag items, 64KiB serialized drag data and a 10-second native capture/command deadline. delivered confirms dispatch and cleanup, not acceptance by the application. A cancelled or uncertain attempt is never replayed. Native drag cancellation, interception removal, DOM observer removal and mouse release must be acknowledged before other computer input resumes. The gesture temporarily emulates focus inside the browser page and disables that override after acknowledged mouse release; it does not focus the OS window or view. No OS pointer or foreground application changes. Normal command approval and shared computer ownership apply.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action", "target"],
      properties: {
        action: { type: "string", enum: ["prepare", "drop", "cancel"] },
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
        dragId: { type: "string" },
      },
    },
    effect: "mutate",
    exposure: "deferred",
    supportsParallelToolCalls: false,
    approvalRequirement: {
      kind: "approval",
      action: "command_execution",
      subject: "Drag between controls in the connected desktop browser",
    },
    async execute(input, context) {
      context.signal?.throwIfAborted()
      try {
        if (
          !isJsonObject(input) ||
          !["prepare", "drop", "cancel"].includes(String(input.action))
        )
          throw new BrowserControlError(
            "invalid_arguments",
            "Use prepare, drop or cancel for an exact browser drag.",
          )
        const request = parseBrowserDragRequest({
            ...input,
            action: `drag_${input.action}`,
          }),
          refusal = await admit(context)
        if (refusal) return refusal
        if (!context.threadId || !context.turnId)
          throw new Error("Browser drag requires an owning session and turn.")
        const result = await browser.request(
          request,
          { sessionId: context.threadId, turnId: context.turnId },
          context.signal,
        )
        context.signal?.throwIfAborted()
        return { ok: true, output: result, content: JSON.stringify(result) }
      } catch (cause) {
        if (!(cause instanceof BrowserControlError)) throw cause
        if (cause.code === "browser_cleanup_failed") markCleanupPending(context)
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
