import { stat } from "node:fs/promises"
import { basename } from "node:path"
import {
  BrowserControlError,
  type BrowserUploadRequest,
  type DesktopBrowser,
  parseBrowserDirectoryUploadRequest,
  parseBrowserUploadRequest,
} from "../protocol/desktop-browser.ts"
import { isJsonObject } from "../protocol/json.ts"
import { resolveReadPath } from "../runtime/tools/path-policy.ts"
import { plainToolName } from "../runtime/tools/tool-name.ts"
import type {
  RuntimeTool,
  ToolExecutionContext,
  ToolFailure,
} from "../runtime/tools/types.ts"
import { inspectUploadDirectory } from "./browser-upload-directory.ts"

function parseUploadInput(input: unknown) {
  if (
    !isJsonObject(input) ||
    !["upload", "upload_directory"].includes(String(input.action)) ||
    (input.action === "upload_directory" &&
      (!Array.isArray(input.paths) || input.paths.length !== 1)) ||
    Object.keys(input).length !== 5 ||
    !["action", "target", "reference", "fromUrl", "paths"].every((key) =>
      Object.hasOwn(input, key),
    ) ||
    !Array.isArray(input.paths) ||
    input.paths.length > 256 ||
    Buffer.byteLength(JSON.stringify(input.paths)) > 65536 ||
    !input.paths.every(
      (path) =>
        typeof path === "string" &&
        path.length > 0 &&
        path.length <= 8192 &&
        !path.includes("\0"),
    )
  )
    throw new BrowserControlError(
      "invalid_arguments",
      "Upload requires an exact elementReference, the observed document fromUrl and local paths. Empty paths clears selection. Path safety bounds: 256 entries, 8192 characters each and 64KiB total.",
    )
  const request = parseBrowserUploadRequest({
    action: "upload",
    target: input.target,
    reference: input.reference,
    fromUrl: input.fromUrl,
    files: [],
  })
  return {
    ...request,
    directory: input.action === "upload_directory",
    paths: input.paths as string[],
  }
}

export function createBrowserUploadTool(
  browser: DesktopBrowser,
  admit: (context: ToolExecutionContext) => Promise<ToolFailure | undefined>,
  markCleanupPending: (context: ToolExecutionContext) => void,
): RuntimeTool {
  return {
    toolName: plainToolName("browser_upload"),
    description:
      "Provide local regular files to an exact observed HTML file input in the connected Yakitori browser. Use elementReference and fromUrl equal to that observation's document.url, including for a child frame. Paths may be workspace-relative or absolute; they resolve to regular files before Chromium receives them. This gives the page access to those files and may trigger its upload handlers. Empty paths explicitly clears the file selection using synthetic input/change events; nonempty selection uses Chromium. The receipt verifies FileList names, sizes and modification times, not website upload completion or file contents. Multi-file selection requires a multiple input. For a webkitdirectory input use action upload_directory with exactly one folder path; this recursively provides regular files with their relative paths. Symbolic links and device files inside the tree are refused; traversal is bounded to 4096 entries, 64 levels, 256 files and 64KiB metadata. Chromium directory enumeration requires a displayed browser tab and a restored Yakitori window; the tool waits up to five seconds for approval-overlay layout to settle and otherwise returns browser_requires_visibility before file selection. It never shows or focuses a page automatically. Directory completion waits for a trusted Chromium change/cancel event, with a 10-second safety deadline that retains unknown pending effects until confirmed or the original target closes. Setting files does not require the referenced input to be visible or focused, and opens no OS picker. References are single-use; changed documents or unconfirmed results require observation, never automatic replay. Computer connection, shared ownership and normal command permission apply. Safety bounds: 256 paths, 64KiB path data/result metadata, 8192 characters per path.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action", "target", "reference", "fromUrl", "paths"],
      properties: {
        action: { type: "string", enum: ["upload", "upload_directory"] },
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
        fromUrl: { type: "string", minLength: 1, maxLength: 8192 },
        paths: {
          type: "array",
          maxItems: 256,
          items: { type: "string", minLength: 1, maxLength: 8192 },
        },
      },
    },
    effect: "mutate",
    exposure: "deferred",
    supportsParallelToolCalls: false,
    approvalRequirement(input) {
      try {
        const request = parseUploadInput(input)
        return {
          kind: "approval",
          action: "command_execution",
          subject: request.directory
            ? `Provide a local directory to ${request.fromUrl}`
            : request.paths.length
              ? `Provide local files to ${request.fromUrl}`
              : `Clear file selection in ${request.fromUrl}`,
          reason: request.directory
            ? `The page will receive all regular files recursively from this directory, including relative paths:\n${request.paths[0]}`
            : request.paths.length
              ? `The page will receive these files:\n${request.paths.join("\n")}`
              : "Clear the exact observed file input.",
        }
      } catch (cause) {
        if (!(cause instanceof BrowserControlError)) throw cause
        return {
          kind: "approval",
          action: "command_execution",
          subject: "Provide files to the connected desktop browser",
        }
      }
    },
    async execute(input, context) {
      context.signal?.throwIfAborted()
      try {
        const request = parseUploadInput(input),
          refusal = await admit(context)
        if (refusal) return refusal
        if (!context.threadId || !context.turnId)
          throw new Error("Browser uploads require an owning session and turn.")
        if (request.directory) {
          const resolved = await resolveReadPath(
            context.workspaceRoot,
            request.paths[0] ?? "",
          )
          if (!resolved.ok)
            throw new BrowserControlError(
              resolved.error.code,
              resolved.error.message,
            )
          if (resolved.kind !== "directory")
            throw new BrowserControlError(
              "unsupported_file_type",
              "Select one directory for upload_directory.",
            )
          const files = await inspectUploadDirectory(
            resolved.absolutePath,
            context.signal,
          )
          const result = await browser.request(
            parseBrowserDirectoryUploadRequest({
              action: "upload_directory",
              target: request.target,
              reference: request.reference,
              fromUrl: request.fromUrl,
              directory: resolved.absolutePath,
              files,
            }),
            { sessionId: context.threadId, turnId: context.turnId },
            context.signal,
          )
          context.signal?.throwIfAborted()
          return { ok: true, output: result, content: JSON.stringify(result) }
        }
        const files: BrowserUploadRequest["files"] = []
        for (const path of request.paths) {
          context.signal?.throwIfAborted()
          const resolved = await resolveReadPath(context.workspaceRoot, path)
          if (!resolved.ok)
            throw new BrowserControlError(
              resolved.error.code,
              resolved.error.message,
            )
          if (resolved.kind !== "file")
            throw new BrowserControlError(
              "unsupported_file_type",
              "Select regular files, not directories or device files.",
            )
          let metadata: Awaited<ReturnType<typeof stat>>
          try {
            metadata = await stat(resolved.absolutePath)
          } catch (cause) {
            if (
              !(cause instanceof Error) ||
              !("code" in cause) ||
              !["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(
                String(cause.code),
              )
            )
              throw cause
            throw new BrowserControlError(
              "file_unavailable",
              `The selected file is no longer readable: ${path}`,
            )
          }
          if (!metadata.isFile() || !Number.isSafeInteger(metadata.size))
            throw new BrowserControlError(
              "unsupported_file_type",
              "Select regular files with a representable size.",
            )
          if (files.some((file) => file.path === resolved.absolutePath))
            throw new BrowserControlError(
              "invalid_arguments",
              "The same canonical file was selected more than once.",
            )
          files.push({
            path: resolved.absolutePath,
            name: basename(resolved.absolutePath),
            size: metadata.size,
            lastModified: Math.trunc(metadata.mtimeMs),
          })
        }
        const result = await browser.request(
          parseBrowserUploadRequest({
            action: "upload",
            target: request.target,
            reference: request.reference,
            fromUrl: request.fromUrl,
            files,
          }),
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
