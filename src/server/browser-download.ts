import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { extname } from "node:path"
import {
  BrowserControlError,
  browserDownloadSafetyBytes,
  type DesktopBrowser,
  parseBrowserDownloadRequest,
} from "../protocol/desktop-browser.ts"
import type { JsonObject } from "../protocol/events.ts"
import { isJsonObject } from "../protocol/json.ts"
import type { RuntimeTool } from "../runtime/tools/types.ts"

function parse(input: unknown) {
  if (
    !isJsonObject(input) ||
    !["arm", "status", "wait", "cancel", "collect"].includes(
      String(input.action),
    )
  )
    throw new BrowserControlError(
      "invalid_arguments",
      "Use arm, status, wait, cancel or collect for an owned browser download.",
    )
  return parseBrowserDownloadRequest({
    ...input,
    action: `download_${input.action}`,
  })
}

async function snapshotDownload(
  path: string,
  expectedSize: number,
  signal?: AbortSignal,
) {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await file.stat()
      if (!before.isFile() || before.size !== expectedSize)
        throw new BrowserControlError(
          "browser_download_changed",
          "The completed download file changed before collection.",
        )
      const chunks: Buffer[] = [],
        digest = createHash("sha256")
      let size = 0
      for await (const chunk of file.createReadStream({
        autoClose: false,
      })) {
        signal?.throwIfAborted()
        if (!Buffer.isBuffer(chunk))
          throw new Error("A download file stream returned non-byte data.")
        size += chunk.length
        if (size > browserDownloadSafetyBytes)
          throw new BrowserControlError(
            "browser_download_unavailable",
            "The download exceeded its artifact-memory safety boundary.",
          )
        digest.update(chunk)
        chunks.push(chunk)
      }
      const after = await file.stat()
      if (
        size !== expectedSize ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      )
        throw new BrowserControlError(
          "browser_download_changed",
          "The completed download changed while being collected.",
        )
      return {
        bytes: Buffer.concat(chunks, size),
        sha256: digest.digest("hex"),
      }
    } finally {
      await file.close()
    }
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      ["ENOENT", "ELOOP", "EACCES", "EPERM"].includes(String(cause.code))
    )
      throw new BrowserControlError(
        "browser_download_unavailable",
        "The completed native file is no longer available for collection.",
        { cause },
      )
    throw cause
  }
}

export function createBrowserDownload(
  browser: DesktopBrowser,
): Pick<RuntimeTool, "execute"> {
  return {
    async execute(input, context) {
      context.signal?.throwIfAborted()
      let savedFile: JsonObject | undefined
      try {
        const request = parse(input)
        if (!context.threadId || !context.turnId)
          throw new Error(
            "Browser downloads require an owning session and turn.",
          )
        const owner = { sessionId: context.threadId, turnId: context.turnId }
        if (request.action !== "download_collect") {
          const result = await browser.request(request, owner, context.signal)
          context.signal?.throwIfAborted()
          return { ok: true, output: result, content: JSON.stringify(result) }
        }
        if (!context.rolloutAssets || !context.rolloutId || !context.toolCallId)
          throw new BrowserControlError(
            "browser_download_unavailable",
            "Collecting a download requires this rollout's owned artifact storage.",
          )
        const result = await browser.request(request, owner, context.signal)
        if (
          typeof result.path !== "string" ||
          !result.path.startsWith("/") ||
          result.path.includes("\0") ||
          result.path.length > 8192 ||
          typeof result.size !== "number" ||
          !Number.isSafeInteger(result.size) ||
          result.size < 0 ||
          result.size > browserDownloadSafetyBytes ||
          typeof result.filename !== "string"
        )
          throw new BrowserControlError(
            "browser_download_unavailable",
            "Desktop did not identify a bounded completed download file.",
          )
        const { bytes, sha256 } = await snapshotDownload(
          result.path,
          result.size,
          context.signal,
        )
        context.signal?.throwIfAborted()
        const suffix = extname(result.filename),
          name = `${request.downloadId}${/^\.[a-z0-9]{1,8}$/i.test(suffix) ? suffix : ".bin"}`,
          saved = await context.rolloutAssets.saveToolFile(
            context.rolloutId,
            context.toolCallId,
            name,
            bytes,
          )
        savedFile = {
          target: request.target,
          fromUrl: result.fromUrl ?? "",
          urlChain: result.urlChain ?? [],
          downloadId: request.downloadId,
          filename: result.filename,
          byteLength: bytes.length,
          sha256,
          file: saved.reference,
          path: saved.path,
        }
        // Artifact persistence precedes scratch deletion. Release is cleanup,
        // independent of ordinary tool cancellation and never re-clicks the page.
        await browser.request(
          {
            action: "download_release",
            target: request.target,
            downloadId: request.downloadId,
          },
          owner,
        )
        return {
          ok: true,
          output: savedFile,
          content: JSON.stringify(savedFile),
        }
      } catch (cause) {
        if (!(cause instanceof BrowserControlError)) throw cause
        const message = savedFile
          ? `${cause.message} The completed file is already saved at ${savedFile.path}; do not download it again.`
          : cause.message
        return {
          ok: false,
          code: cause.code,
          message,
          content: message,
          ...(savedFile ? { output: savedFile } : {}),
        }
      }
    },
  }
}
