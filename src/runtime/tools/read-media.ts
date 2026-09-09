import { imageDecodeError } from "../prepare-model-image.ts"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { basename } from "node:path"
import { inspectImageBytes } from "../../kernel/image-metadata.ts"
import { noToolApprovalRequired } from "./approval-requirements.ts"
import { resolveReadPath } from "./path-policy.ts"
import { mediaPresentation } from "./result-output.ts"
import { plainToolName } from "./tool-name.ts"
import type { RuntimeTool } from "./types.ts"

// Bound snapshot memory before decoding or storing untrusted local media.
const MEDIA_SNAPSHOT_SAFETY_BYTES = 50_000_000

export function createViewImageTool(): RuntimeTool {
  return createMediaTool("image")
}
export function createReadDocumentTool(): RuntimeTool {
  return createMediaTool("document")
}

function createMediaTool(kind: "image" | "document"): RuntimeTool {
  const name = kind === "image" ? "view_image" : "read_document"
  return {
    toolName: plainToolName(name),
    description:
      kind === "image"
        ? "View a local image visually. Accepts workspace-relative or absolute paths. The image is snapshotted for this conversation. detail can be high or original."
        : "Read a local PDF as a document. Accepts workspace-relative or absolute paths. The document is snapshotted and sent through the provider's native document input when supported.",
    effect: "observe",
    supportsParallelToolCalls: true,
    approvalRequirement: noToolApprovalRequired,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description:
            "Workspace-relative or absolute path to the local media file.",
        },
        ...(kind === "image"
          ? {
              detail: {
                type: "string",
                enum: ["high", "original"],
                description:
                  "high resizes large images; original preserves their dimensions when supported.",
              },
            }
          : {}),
      },
    },
    async execute(input, context) {
      if (
        typeof input !== "object" ||
        input === null ||
        !("path" in input) ||
        typeof input.path !== "string" ||
        Object.keys(input).some(
          (key) => key !== "path" && !(kind === "image" && key === "detail"),
        )
      ) {
        return failure("invalid_tool_input", `${name} requires a path.`)
      }
      const detail = "detail" in input ? input.detail : "high"
      if (detail !== "high" && detail !== "original")
        return failure("invalid_tool_input", "detail must be high or original.")
      if (
        context.rolloutAssets === undefined ||
        context.rolloutId === undefined ||
        context.toolCallId === undefined
      )
        return failure(
          "asset_storage_unavailable",
          "Media reads require rollout asset storage.",
        )
      const path = await resolveReadPath(context.workspaceRoot, input.path)
      if (!path.ok) return failure(path.error.code, path.error.message)
      if (path.kind === "directory")
        return failure(
          "unsupported_file_type",
          "Media path must be a regular file.",
        )
      const handle = await open(
        path.absolutePath,
        constants.O_RDONLY | constants.O_NONBLOCK,
      )
      let bytes: Buffer
      try {
        const stat = await handle.stat()
        if (
          !stat.isFile() ||
          stat.size <= 0 ||
          stat.size > MEDIA_SNAPSHOT_SAFETY_BYTES
        )
          return failure(
            "invalid_media_size",
            "Media must be a nonempty regular file within the snapshot memory safety boundary (50 MB).",
          )
        // A bounded read also protects against concurrent growth after stat.
        bytes = Buffer.alloc(stat.size + 1)
        let length = 0
        while (length < bytes.length) {
          context.signal?.throwIfAborted()
          const read = await handle.read(
            bytes,
            length,
            bytes.length - length,
            length,
          )
          if (read.bytesRead === 0) break
          length += read.bytesRead
        }
        const after = await handle.stat()
        if (
          length !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs
        )
          return failure(
            "file_changed_during_read",
            "Media changed while being read; retry against the current file.",
          )
        bytes = bytes.subarray(0, length)
      } finally {
        await handle.close()
      }
      if (kind === "document" && bytes.subarray(0, 5).toString() !== "%PDF-")
        return failure(
          "unsupported_document",
          "read_document currently supports PDF files only.",
        )
      if (kind === "image") {
        const error = await imageDecodeError(bytes)
        if (error !== undefined)
          return failure("invalid_image", `Unable to decode image: ${error}`)
      }
      const mediaType =
        kind === "image"
          ? inspectImageBytes(bytes).mediaType
          : "application/pdf"
      const saved = await context.rolloutAssets.saveToolFile(
        context.rolloutId,
        context.toolCallId,
        kind === "image" ? `image.${mediaType.split("/")[1]}` : "document.pdf",
        bytes,
      )
      const content = `Read ${kind}: ${path.displayPath}`
      return {
        ok: true,
        content,
        output: {
          path: path.displayPath,
          mediaType,
          sizeBytes: bytes.length,
          file: saved.reference,
        },
        presentation: mediaPresentation(
          kind === "image" && mediaType !== "application/pdf"
            ? {
                content,
                images: [
                  {
                    type: "image",
                    mediaType,
                    detail,
                    file: saved.reference,
                    sizeBytes: bytes.length,
                  },
                ],
              }
            : {
                content,
                documents: [
                  {
                    type: "document",
                    mediaType: "application/pdf",
                    name: basename(path.absolutePath),
                    file: saved.reference,
                    sizeBytes: bytes.length,
                  },
                ],
              },
        ),
      }
    },
  }
}

function failure(code: string, message: string) {
  return { ok: false as const, code, message, content: message }
}
