import {
  BrowserControlError,
  type DesktopBrowser,
  parseBrowserRequest,
} from "../protocol/desktop-browser.ts"
import { isJsonObject } from "../protocol/json.ts"
import { plainToolName } from "../runtime/tools/tool-name.ts"
import type { RuntimeTool } from "../runtime/tools/types.ts"
import {
  browserDataText,
  browserModelResult,
  browserTargetClient,
  browserToolFailure,
} from "./browser-tool-target.ts"

export function createBrowserWaitTool(browser: DesktopBrowser): RuntimeTool {
  return {
    toolName: plainToolName("browser_wait"),
    description:
      "Wait for a condition without sending page input. Use until=text, text_gone, ref_or_role, url, load, or download. Supply value for a substring, role, or observed ref, and downloadId for a captured file. A timed-out wait never proves a mutation failed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["until"],
      properties: {
        tabId: { type: "string" },
        until: {
          type: "string",
          enum: ["text", "text_gone", "ref_or_role", "url", "load", "download"],
        },
        value: { type: "string", maxLength: 1024 },
        regex: {
          type: "boolean",
          description:
            "For url, match a regular expression with anchors, literals, escaped punctuation, dots and at most one quantifier.",
        },
        timeoutMs: { type: "integer", minimum: 100, maximum: 30000 },
        downloadId: { type: "string" },
      },
    },
    effect: "observe",
    exposure: "deferred",
    supportsParallelToolCalls: false,
    approvalRequirement: { kind: "none" },
    async execute(input, context) {
      try {
        if (!isJsonObject(input))
          throw new BrowserControlError(
            "invalid_arguments",
            "Provide a browser wait condition.",
          )
        const { tabId, until, downloadId, ...fields } = input
        const client = browserTargetClient(browser, context)
        if (until !== "download" && downloadId !== undefined)
          throw new BrowserControlError(
            "invalid_arguments",
            "downloadId is only accepted for a download wait.",
          )
        const { target } =
          until === "download"
            ? await client.resolveDownload(downloadId, tabId)
            : await client.resolve(tabId)
        const request = parseBrowserRequest(
          until === "download"
            ? { ...fields, action: "download_wait", target, downloadId }
            : { ...fields, action: "wait", target, until },
        )
        const data = browserModelResult(await client.request(request))
        const output =
          until === "download"
            ? { ...data, matched: data.state === "completed" }
            : data
        return {
          ok: true,
          output,
          content: browserDataText("browser-wait", JSON.stringify(output)),
        }
      } catch (cause) {
        return browserToolFailure(cause)
      }
    },
  }
}
