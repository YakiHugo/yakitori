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
import type { RuntimeTool } from "../runtime/tools/types.ts"
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
      "Upload requires an exact ref, the observed document fromUrl and local paths. Empty paths clears selection. Path safety bounds: 256 entries, 8192 characters each and 64KiB total.",
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

export function createBrowserUpload(
  browser: DesktopBrowser,
): Pick<RuntimeTool, "execute"> {
  return {
    async execute(input, context) {
      context.signal?.throwIfAborted()
      try {
        const request = parseUploadInput(input)
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
