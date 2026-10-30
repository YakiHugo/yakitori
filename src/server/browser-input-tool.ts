import {
  BrowserControlError,
  browserNamedKeys,
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
  markCleanupPending: (context: ToolExecutionContext) => void,
): RuntimeTool {
  return {
    toolName: plainToolName("browser_input"),
    description:
      "Interact with an exact browser control observed in this turn. type/fill use inputReference and require text; click/hover/scroll/press/select use elementReference and accept no text. Select operates on a native HTML select using options descriptors with exactly one value, label or index each. Empty options clears selection; single selects accept at most one descriptor. Missing, ambiguous or disabled options refuse selection. It emits synthetic input/change events and verifies the resulting selected values; selectionVerified does not confirm business success. Safety bounds: 256 descriptors, 64KiB serialized descriptors/results and 10000 DOM options per action. press focuses the exact element, verifies focus before each key-down, sends one key with optional distinct Alt/Control/Meta/Shift modifiers, then releases the key and modifiers in reverse order. Only page input is delivered; Yakitori application shortcuts are suppressed until turn cleanup. Meta+A, Meta+Z and Meta+Shift+Z use Chromium editing commands. Keyboard shortcuts can invoke page handlers and normal browser editing behavior, including clipboard shortcuts. Click accepts button left/middle/right (default left) and clickCount 1/2 (default 1). Hover moves only the browser pointer. Scroll requires deltaX and deltaY in CSS pixels, at least one nonzero; positive values scroll right/down. A 10000 CSS-pixel per-axis implementation safety bound limits each compositor scroll jump; observe again before longer scrolling. Pointer input scrolls the exact element into view, hit-tests it before and after moving the browser pointer, then dispatches the requested pointer event. Click releases every owned press, including both pairs for double click. delivered confirms input, not business success or changed scroll position. Covered or disabled controls refuse clicking. Text, keyboard and pointer actions support the selected frame, including cross-process frames. Pointer actions verify every embedding frame and refuse moved or covered targets. Use the exact listed target. type inserts at the current selection; fill selects and replaces the entire field, including an empty string to clear it. Each attempt consumes all references from that observation. Text actions check the document and focused control before dispatch and verify the resulting value. On browser_input_unconfirmed, observe again and never automatically replay input. No OS mouse/keyboard, arbitrary page code or remote debugging port is used. Typing/filling uses no clipboard. Computer use must be connected; normal permission and shared turn ownership apply. type requires nonempty text; fill permits empty text. A 64KiB per-event implementation safety bound applies.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action", "target", "reference"],
      properties: {
        action: {
          type: "string",
          enum: ["type", "fill", "click", "hover", "scroll", "press", "select"],
        },
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
        text: { type: "string" },
        key: {
          type: "string",
          description: `For press: one printable ASCII character, F1–F24, or ${browserNamedKeys.join(", ")}. Unicode text uses type/fill.`,
        },
        modifiers: {
          type: "array",
          uniqueItems: true,
          maxItems: 4,
          items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] },
        },
        button: { type: "string", enum: ["left", "middle", "right"] },
        clickCount: { type: "integer", enum: [1, 2] },
        deltaX: { type: "number", minimum: -10000, maximum: 10000 },
        deltaY: { type: "number", minimum: -10000, maximum: 10000 },
        options: {
          type: "array",
          maxItems: 256,
          description:
            "For select: each descriptor has exactly one value, label or index. Empty clears selection; a single select accepts at most one descriptor.",
          items: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["value"],
                properties: { value: { type: "string" } },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["label"],
                properties: { label: { type: "string" } },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["index"],
                properties: { index: { type: "integer", minimum: 0 } },
              },
            ],
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
      subject: "Interact with the connected desktop browser",
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
