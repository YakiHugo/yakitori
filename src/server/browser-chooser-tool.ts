import {
  BrowserControlError,
  type DesktopBrowser,
  parseBrowserChooserRequest,
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
      "Use arm, inspect or disarm for a managed browser file chooser.",
    )
  return parseBrowserChooserRequest({
    ...input,
    action: `chooser_${input.action}`,
  })
}

export function createBrowserChooserTool(
  browser: DesktopBrowser,
  admit: (context: ToolExecutionContext) => Promise<ToolFailure | undefined>,
  markCleanupPending: (context: ToolExecutionContext) => void,
): RuntimeTool {
  return {
    toolName: plainToolName("browser_chooser"),
    description:
      "Explicitly intercept HTML file pickers in an observed managed-browser renderer, exposing inputs only from the approved document. First arm with target, its observed fromUrl and optional frameReference, then use browser_input to click the page's upload button. inspect with target returns an elementReference for the exact opened input, even if hidden; use that reference and returned fromUrl with browser_upload and explicitly approved paths. File selection keeps browser_upload's native verification and permission boundaries. Arming never provides local files. Interception also suppresses pickers in other local frames sharing that renderer; such an event refuses inspection rather than exposing another document's input. Disarm before manual file picking. Navigation or child-renderer replacement requires disarm and fresh observation/arming; frameReference must remain current. Newly created child renderers are not automatically armed. disarm disables interception, without claiming a selection was cancelled or a web upload completed. Normal command permission and shared computer ownership apply, including inspect. Turn/session cleanup disables interception before debugger detach; unknown configuration acknowledgement keeps computer input quarantined.",
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
      },
    },
    effect: "mutate",
    exposure: "deferred",
    supportsParallelToolCalls: false,
    approvalRequirement: {
      kind: "approval",
      action: "command_execution",
      subject: "Manage a file picker in the connected desktop browser",
    },
    async execute(input, context) {
      context.signal?.throwIfAborted()
      try {
        const request = parse(input),
          refusal = await admit(context)
        if (refusal) return refusal
        if (!context.threadId || !context.turnId)
          throw new Error(
            "Browser file choosers require an owning session and turn.",
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
