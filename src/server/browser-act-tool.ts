import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import {
  BrowserControlError,
  type BrowserTarget,
  type DesktopBrowser,
  parseBrowserRequest,
} from "../protocol/desktop-browser.ts"
import type { JsonObject, JsonValue } from "../protocol/events.ts"
import { isJsonObject } from "../protocol/json.ts"
import { plainToolName } from "../runtime/tools/tool-name.ts"
import type {
  RuntimeTool,
  ToolExecutionResult,
} from "../runtime/tools/types.ts"
import { createBrowserDownload } from "./browser-download.ts"
import {
  browserDataText,
  browserModelResult,
  browserTargetClient,
  browserToolFailure,
} from "./browser-tool-target.ts"
import { createBrowserUpload } from "./browser-upload.ts"

const pointerActions = [
  "click",
  "hover",
  "type",
  "fill",
  "select",
  "press",
  "scroll",
]
const operations = [
  "new_tab",
  "close_tab",
  "select_tab",
  "navigate",
  "back",
  "forward",
  "reload",
  "stop",
  ...pointerActions,
  "drag",
  "upload",
  "dialog",
  "download",
  "batch",
]

function stepRequest(step: JsonObject, target: BrowserTarget) {
  const { ref, ...input } = step
  if (
    !pointerActions.includes(String(input.action)) ||
    ["target", "reference", "tabId", "returnSnapshot"].some((key) =>
      Object.hasOwn(input, key),
    )
  )
    throw new BrowserControlError(
      "invalid_arguments",
      "Batch steps must be input actions in the same tab.",
    )
  return parseBrowserRequest({
    ...input,
    target,
    ...(ref === undefined ? {} : { reference: ref }),
  })
}

export function createBrowserActTool(browser: DesktopBrowser): RuntimeTool {
  const upload = createBrowserUpload(browser)
  const download = createBrowserDownload(browser)
  return {
    toolName: plainToolName("browser_act"),
    description:
      "Operate a managed desktop browser tab with approval. Use new_tab, close_tab, select_tab, navigate, back, forward, reload, stop, click, hover, type, fill, select, press, scroll, drag, upload, dialog, download or batch. New tabs are selected unless background is true. tabId defaults to the active tab; uploads require the tabId that issued the ref. Pin a source URL with expectedUrl. Coordinates are viewport CSS pixels. Batch runs 1–32 fixed input steps in one tab and stops at the first failure. Use returnSnapshot for follow-up state; do not replay an unconfirmed action.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: operations },
        tabId: { type: "string" },
        url: { type: "string" },
        expectedUrl: { type: "string" },
        background: { type: "boolean" },
        ref: { type: "string" },
        fromRef: { type: "string" },
        toRef: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        deltaX: { type: "number" },
        deltaY: { type: "number" },
        button: { type: "string", enum: ["left", "middle", "right"] },
        clickCount: { type: "integer", enum: [1, 2] },
        text: { type: "string" },
        key: { type: "string" },
        modifiers: { type: "array", items: { type: "string" } },
        options: { type: "array", items: { type: "object" } },
        paths: { type: "array", items: { type: "string" }, maxItems: 256 },
        directory: { type: "boolean" },
        operation: {
          type: "string",
          description:
            "Dialog: arm, answer, inspect or disarm. Download: arm, status, wait, cancel or collect.",
        },
        response: {
          type: "object",
          description:
            "Dialog response with type (alert, confirm, prompt or beforeunload), accept, optional exact message, and optional promptText for accepted prompts.",
        },
        frameRef: {
          type: "string",
          description:
            "Frame reference from browser_inspect frames for a dialog.",
        },
        downloadId: { type: "string" },
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: { type: "object" },
        },
        returnSnapshot: { type: "boolean" },
      },
    },
    effect: "mutate",
    exposure: "deferred",
    supportsParallelToolCalls: false,
    approvalRequirement(input) {
      const action = isJsonObject(input) ? String(input.action) : "operate"
      return {
        kind: "approval",
        action: "command_execution",
        subject:
          action === "upload" && isJsonObject(input)
            ? `Browser: provide local files to tab ${String(input.tabId).slice(0, 256)}, ref ${String(input.ref).slice(0, 32)}`
            : `Browser: ${action}`,
        ...(isJsonObject(input) &&
        input.action === "upload" &&
        Array.isArray(input.paths)
          ? {
              reason:
                (input.directory === true
                  ? "The selected page can read regular files recursively from this directory: "
                  : "The selected page can read these local paths: ") +
                input.paths.map(String).join(", ").slice(0, 4096),
            }
          : {}),
      }
    },
    async execute(input, context): Promise<ToolExecutionResult> {
      try {
        if (
          !isJsonObject(input) ||
          !operations.includes(String(input.action)) ||
          Object.hasOwn(input, "target") ||
          Object.hasOwn(input, "reference")
        )
          throw new BrowserControlError(
            "invalid_arguments",
            "Provide a browser action using tabId and short references.",
          )
        const client = browserTargetClient(browser, context)
        const { action, tabId, returnSnapshot, ...fields } = input
        if (returnSnapshot !== undefined && typeof returnSnapshot !== "boolean")
          throw new BrowserControlError(
            "invalid_arguments",
            "returnSnapshot must be a boolean.",
          )
        let target: BrowserTarget, url: string, result: JsonObject
        if (action === "new_tab") {
          if (
            tabId !== undefined ||
            !Object.keys(fields).every(
              (key) => key === "url" || key === "background",
            ) ||
            (fields.background !== undefined &&
              typeof fields.background !== "boolean")
          )
            throw new BrowserControlError(
              "invalid_arguments",
              "A new tab accepts optional url and background.",
            )
          const newId = `agent_tab_${randomUUID()}`
          const authorized = parseBrowserRequest({
            action: "new_tab",
            tabId: newId,
            ...(fields.url === undefined ? {} : { url: fields.url }),
          })
          if (authorized.action !== "new_tab")
            throw new Error("New tab parser returned another action.")
          result = await client.request({ action: "new_tab", tabId: newId })
          ;({ target, url } = await client.resolve(newId))
          try {
            if (authorized.url)
              result = await client.request({
                action: "navigate",
                target,
                fromUrl: url,
                url: authorized.url,
              })
            if (fields.background !== true) {
              const current = await client.resolve(newId)
              const selection = await client.request({
                action: "show",
                target,
                fromUrl: current.url,
              })
              result = { ...result, ...selection }
            }
          } catch (cause) {
            const failure = browserToolFailure(cause)
            return {
              ...failure,
              content: `Created tab ${newId}; follow-up unconfirmed: ${failure.message}`,
            }
          }
        } else {
          if (action === "upload" && typeof tabId !== "string")
            throw new BrowserControlError(
              "invalid_arguments",
              "Upload requires the tabId from the listing or snapshot.",
            )
          ;({ target, url } =
            action === "download" && fields.operation !== "arm"
              ? await client.resolveDownload(fields.downloadId, tabId)
              : await client.resolve(tabId))
          if (action === "batch") {
            if (
              Object.keys(fields).length !== 1 ||
              !Array.isArray(fields.steps) ||
              fields.steps.length < 1 ||
              fields.steps.length > 32
            )
              throw new BrowserControlError(
                "invalid_arguments",
                "Batch requires 1–32 fixed input steps.",
              )
            const steps = fields.steps.map((value) => {
              if (!isJsonObject(value))
                throw new BrowserControlError(
                  "invalid_arguments",
                  "Each batch step is an input object.",
                )
              return stepRequest(value, target)
            })
            const completed: JsonObject[] = []
            for (const step of steps) {
              try {
                completed.push(browserModelResult(await client.request(step)))
              } catch (cause) {
                const failure = browserToolFailure(cause)
                return {
                  ...failure,
                  content: browserDataText(
                    "browser-action-result",
                    JSON.stringify({
                      tabId: target.tabId,
                      completedSteps: completed.length,
                      steps: completed,
                      code: failure.code,
                      message: failure.message,
                    }),
                  ),
                  output: {
                    tabId: target.tabId,
                    completedSteps: completed.length,
                    steps: completed,
                  },
                }
              }
            }
            result = {
              target,
              completedSteps: completed.length,
              steps: completed,
            }
          } else if (pointerActions.includes(String(action))) {
            result = await client.request(
              stepRequest({ action: String(action), ...fields }, target),
            )
          } else if (
            [
              "navigate",
              "back",
              "forward",
              "reload",
              "stop",
              "close_tab",
              "select_tab",
            ].includes(String(action))
          ) {
            const { expectedUrl, ...parameters } = fields
            if (expectedUrl !== undefined && expectedUrl !== url)
              throw new BrowserControlError(
                "browser_target_changed",
                "The tab URL no longer matches expectedUrl.",
              )
            result = await client.request(
              parseBrowserRequest({
                ...parameters,
                action:
                  action === "close_tab"
                    ? "close"
                    : action === "select_tab"
                      ? "show"
                      : action,
                target,
                fromUrl: url,
              }),
            )
          } else if (action === "drag") {
            if (Object.keys(fields).length !== 2)
              throw new BrowserControlError(
                "invalid_arguments",
                "Use fromRef and toRef for a drag.",
              )
            if (
              typeof fields.fromRef !== "string" ||
              typeof fields.toRef !== "string" ||
              !/^e[1-9][0-9]{0,15}$/.test(fields.toRef)
            )
              throw new BrowserControlError(
                "invalid_arguments",
                "A drag needs an observed destination ref.",
              )
            const from = parseBrowserRequest({
              action: "drag_prepare",
              target,
              reference: fields.fromRef,
            })
            const prepared = await client.request(from)
            result = await client.request(
              parseBrowserRequest({
                action: "drag_drop",
                target,
                dragId: prepared.dragId,
                reference: fields.toRef,
              }),
            )
          } else if (action === "dialog") {
            const { operation, frameRef, ...parameters } = fields
            result = await client.request(
              parseBrowserRequest({
                ...parameters,
                action: `dialog_${String(operation ?? "arm")}`,
                target,
                ...(operation === "inspect" || operation === "disarm"
                  ? {}
                  : { fromUrl: url }),
                ...(frameRef === undefined ? {} : { frameReference: frameRef }),
              }),
            )
          } else if (action === "upload") {
            const { ref, expectedUrl, directory, paths, ...unsupported } =
              fields
            if (
              Object.keys(unsupported).length ||
              typeof ref !== "string" ||
              (directory !== undefined && typeof directory !== "boolean") ||
              (expectedUrl !== undefined && typeof expectedUrl !== "string") ||
              !Array.isArray(paths) ||
              paths.length > 256 ||
              Buffer.byteLength(JSON.stringify(paths)) > 65536 ||
              !paths.every(
                (path) =>
                  typeof path === "string" &&
                  path.length > 0 &&
                  path.length <= 8192 &&
                  !path.includes("\0"),
              )
            )
              throw new BrowserControlError(
                "invalid_arguments",
                "Upload requires ref and paths, optionally directory and expectedUrl.",
              )
            const fileTarget = await client.request(
              parseBrowserRequest({
                action: "file_target",
                target,
                reference: ref,
              }),
            )
            const { fromUrl, frameReference, fileInput } = fileTarget
            if (typeof fromUrl !== "string")
              throw new Error("Missing file input document URL.")
            if (expectedUrl !== undefined && expectedUrl !== fromUrl)
              throw new BrowserControlError(
                "browser_target_changed",
                "The file input document no longer matches expectedUrl.",
              )
            const provide = (reference: string, isDirectory: boolean) =>
              upload.execute(
                {
                  action: isDirectory ? "upload_directory" : "upload",
                  target,
                  reference,
                  fromUrl,
                  paths,
                },
                context,
              )
            let receipt: ToolExecutionResult
            if (fileInput === true)
              receipt = await provide(ref, directory === true)
            else {
              if (!paths.length || (directory === true && paths.length !== 1))
                throw new BrowserControlError(
                  "invalid_arguments",
                  "Provide files or one directory before opening a chooser.",
                )
              await client.request(
                parseBrowserRequest({
                  action: "chooser_arm",
                  target,
                  fromUrl,
                  ...(typeof frameReference === "string"
                    ? { frameReference }
                    : {}),
                }),
              )
              try {
                await client.request(
                  stepRequest({ action: "click", ref }, target),
                )
                const deadline = performance.now() + 750
                for (;;) {
                  const chooser = await client.request({
                    action: "chooser_inspect",
                    target,
                  })
                  if (
                    chooser.opened === true &&
                    typeof chooser.ref === "string"
                  ) {
                    receipt = await provide(chooser.ref, directory === true)
                    break
                  }
                  if (performance.now() >= deadline)
                    throw new BrowserControlError(
                      "browser_chooser_unavailable",
                      "The click did not open a file input in the observed document.",
                    )
                  await delay(50, undefined, { signal: context.signal })
                }
              } finally {
                if (!context.signal?.aborted)
                  await client.request({ action: "chooser_disarm", target })
              }
            }
            if (!receipt.ok || !isJsonObject(receipt.output)) return receipt
            result = receipt.output
          } else if (action === "download") {
            const { operation, ref, ...parameters } = fields
            if (
              ref !== undefined &&
              (operation !== "arm" || typeof ref !== "string")
            )
              throw new BrowserControlError(
                "invalid_arguments",
                "Only download arm accepts an optional trigger ref.",
              )
            const trigger =
              ref === undefined
                ? undefined
                : stepRequest({ action: "click", ref }, target)
            const receipt = await download.execute(
              {
                ...parameters,
                action: operation,
                target,
                ...(operation === "arm" ? { fromUrl: url } : {}),
              },
              context,
            )
            if (!receipt.ok || !isJsonObject(receipt.output)) return receipt
            result = receipt.output
            if (trigger) {
              try {
                result = {
                  ...result,
                  trigger: browserModelResult(await client.request(trigger)),
                }
              } catch (cause) {
                const failure = browserToolFailure(cause)
                return {
                  ...failure,
                  output: browserModelResult(result),
                  content: browserDataText(
                    "browser-action-result",
                    JSON.stringify({
                      ...browserModelResult(result),
                      code: failure.code,
                      message: failure.message,
                    }),
                  ),
                }
              }
            }
          } else {
            throw new BrowserControlError(
              "invalid_arguments",
              "Unknown browser action.",
            )
          }
        }
        const output: Record<string, JsonValue> = {
          ...browserModelResult({ target, ...result }),
        }
        if (result.dispatched === false) output.noEffect = true
        if (returnSnapshot && action !== "close_tab") {
          try {
            const observed = browserModelResult(
              await client.request({
                action: "observe",
                target,
                interactiveOnly: true,
              }),
            )
            const { outline, nodes: _nodes, ...metadata } = observed
            output.snapshot = {
              ...metadata,
              ...(typeof outline === "string" ? { outline } : {}),
            }
          } catch (cause) {
            const failure = browserToolFailure(cause)
            output.snapshotError = {
              code: failure.code,
              message: failure.message,
            }
          }
        }
        return {
          ok: true,
          output,
          content: browserDataText(
            "browser-action-result",
            JSON.stringify(output),
          ),
        }
      } catch (cause) {
        return browserToolFailure(cause)
      }
    },
  }
}
