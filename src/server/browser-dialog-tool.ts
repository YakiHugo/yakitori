import {
  BrowserControlError,
  type DesktopBrowser,
  parseBrowserDialogRequest,
} from "../protocol/desktop-browser.ts"
import { isJsonObject } from "../protocol/json.ts"
import { plainToolName } from "../runtime/tools/tool-name.ts"
import type {
  RuntimeTool,
  ToolExecutionContext,
  ToolFailure,
} from "../runtime/tools/types.ts"

function parse(input: unknown) {
  if (
    !isJsonObject(input) ||
    !["arm", "inspect", "disarm"].includes(String(input.action))
  )
    throw new BrowserControlError(
      "invalid_arguments",
      "Use arm, inspect or disarm for a managed browser JavaScript dialog.",
    )
  return parseBrowserDialogRequest({
    ...input,
    action: `dialog_${input.action}`,
  })
}

export function createBrowserDialogTool(
  browser: DesktopBrowser,
  admit: (context: ToolExecutionContext) => Promise<ToolFailure | undefined>,
  markCleanupPending: (context: ToolExecutionContext) => void,
): RuntimeTool {
  return {
    toolName: plainToolName("browser_dialog"),
    description:
      "Arm one reply to the next matching native JavaScript alert, confirm, prompt or beforeunload in an observed managed-browser document. Use arm with exact target, observed fromUrl, optional frameReference and response {type, accept, optional exact message}. Alert requires accept true. Then trigger the dialog with browser_input; the response is sent while the click/key awaits native completion, preventing a serial-tool modal deadlock. inspect reports waiting/answering/answered/mismatch and expired state. One arm consumes at most one response. Other documents, renderer sessions, navigation and mismatched types/messages never receive the reply. A mismatched dialog remains open; it may require manual dismissal or closing the owned tab. disarm removes the rule, and turn cleanup waits for response acknowledgement before releasing input and detaching. Normal command approval and shared computer ownership apply to all actions. Prompt rules temporarily restore a native synchronous prompt in the original main-world context and optionally provide promptText. Accepted prompts return promptText or an empty string when omitted; dismissal returns null. Disarm/turn cleanup restores the original function only if the page still uses this adapter; context destruction retires its remote ticket.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action", "target"],
      properties: {
        action: { type: "string", enum: ["arm", "inspect", "disarm"] },
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
        fromUrl: { type: "string", minLength: 1, maxLength: 8192 },
        frameReference: { type: "string" },
        response: {
          type: "object",
          additionalProperties: false,
          required: ["type", "accept"],
          properties: {
            type: {
              type: "string",
              enum: ["alert", "confirm", "beforeunload", "prompt"],
            },
            accept: { type: "boolean" },
            message: { type: "string", maxLength: 8192 },
            promptText: { type: "string", maxLength: 8192 },
          },
        },
      },
    },
    effect: "mutate",
    exposure: "deferred",
    supportsParallelToolCalls: false,
    approvalRequirement: {
      kind: "approval",
      action: "command_execution",
      subject: "Manage JavaScript dialogs in the connected desktop browser",
    },
    async execute(input, context) {
      context.signal?.throwIfAborted()
      try {
        const request = parse(input),
          refusal = await admit(context)
        if (refusal) return refusal
        if (!context.threadId || !context.turnId)
          throw new Error("Browser dialogs require an owning session and turn.")
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
