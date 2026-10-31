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
import { plainToolName } from "../runtime/tools/tool-name.ts"
import type {
  RuntimeTool,
  ToolExecutionContext,
  ToolFailure,
} from "../runtime/tools/types.ts"

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

export function createBrowserDownloadTool(
  browser: DesktopBrowser,
  admit: (context: ToolExecutionContext) => Promise<ToolFailure | undefined>,
  markCleanupPending: (context: ToolExecutionContext) => void,
): RuntimeTool {
  return {
    toolName: plainToolName("browser_download"),
    description:
      "Capture the next download from an exact Yakitori browser tab, including its frames. First observe the tab, then arm with target and its root document fromUrl; optional url restricts the initial URL before redirects (HTTP(S), blob or data). Arming supplies no file and does not trigger a download: use browser_input on the page's download control. HTTP navigation can itself start a download: if navigation reports unconfirmed, inspect this download ID before considering another page action. The rule accepts at most one download from that tab; root document replacement expires an unconsumed rule; same-document history changes preserve it. While a download rule is armed, mismatched or additional downloads from that tab are cancelled rather than opening an OS save picker. Tabs without a download rule keep their normal handling, including during read-only observation. status returns native state/byte counters and bounded, untrusted filename/URL metadata. wait waits up to ten seconds and may return an ongoing transfer; cancellation of a wait leaves the download owned. cancel waits for Chromium's terminal acknowledgement before removing scratch files. collect persists a completed file in this rollout's immutable attachment area and returns its path/reference, byteLength and SHA-256; use normal file tools to read or copy it to a user destination. It never writes a website-selected name to a user directory. Safety boundaries: sixteen retained jobs per host, one retained job per tab and four per owning turn, 64MiB artifact-memory/observed-transfer cutoff. Native progress events can lag disk writes, so the transfer stop is not an exact disk quota. Changing the current browser target preserves an already armed or captured download; ending the turn cancels captured unfinished transfers and removes remaining scratch data. Cancelling an unconsumed rule disarms capture rather than undoing the page action that might trigger it. Download IDs belong to the original target and turn. Normal command approval and shared computer ownership apply to every action. Unknown native cancellation completion keeps all computer input quarantined; never repeat the page click to retry collection.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action", "target"],
      properties: {
        action: {
          type: "string",
          enum: ["arm", "status", "wait", "cancel", "collect"],
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
        fromUrl: { type: "string", maxLength: 8192 },
        url: { type: "string", maxLength: 8192 },
        downloadId: { type: "string" },
      },
    },
    effect: "mutate",
    exposure: "deferred",
    supportsParallelToolCalls: false,
    approvalRequirement: {
      kind: "approval",
      action: "command_execution",
      subject:
        "Capture or collect a file downloaded by the connected desktop browser",
    },
    async execute(input, context) {
      context.signal?.throwIfAborted()
      let savedFile: JsonObject | undefined
      try {
        const request = parse(input),
          refusal = await admit(context)
        if (refusal) return refusal
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
        if (cause.code === "browser_cleanup_failed") markCleanupPending(context)
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
