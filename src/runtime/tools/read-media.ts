import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { basename } from "node:path"
import { inspectImageBytes } from "../../kernel/image-metadata.ts"
import { imageDecodeError } from "../prepare-model-image.ts"
import { noToolApprovalRequired } from "./approval-requirements.ts"
import { resolveReadPath } from "./path-policy.ts"
import { mediaPresentation } from "./result-output.ts"
import { plainToolName } from "./tool-name.ts"
import type {
  RuntimeTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.ts"

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
        : 'Read a local PDF. Accepts workspace-relative or absolute paths. Sends a whole PDF natively when supported; otherwise renders pages for image-capable models or extracts text. Set format to "text" or "image" to select extraction, and pages to a 1-based range such as "1-5,8" or "3-". Extraction reads up to 10 pages automatically or 20 explicitly selected pages (processing safety boundaries).',
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
          : {
              pages: {
                type: "string",
                description:
                  'PDF pages, 1-based: "1-5,8", "3-", or "2". Sorted and deduplicated.',
              },
              format: {
                type: "string",
                enum: ["text", "image"],
                description:
                  "Extract page text or render page images. Omit for provider-appropriate reading.",
              },
            }),
      },
    },
    async execute(input, context) {
      if (
        typeof input !== "object" ||
        input === null ||
        !("path" in input) ||
        typeof input.path !== "string" ||
        Object.keys(input).some(
          (key) =>
            key !== "path" &&
            !(kind === "image"
              ? key === "detail"
              : key === "pages" || key === "format"),
        )
      ) {
        return failure("invalid_tool_input", `${name} requires a path.`)
      }
      const detail = "detail" in input ? input.detail : "high"
      if (detail !== "high" && detail !== "original")
        return failure("invalid_tool_input", "detail must be high or original.")
      const pages = "pages" in input ? input.pages : undefined
      const format = "format" in input ? input.format : undefined
      if (pages !== undefined && typeof pages !== "string")
        return failure(
          "invalid_tool_input",
          "pages must be a page range string.",
        )
      if (format !== undefined && format !== "text" && format !== "image")
        return failure("invalid_tool_input", "format must be text or image.")
      if (format === "image" && context.documentReading?.images !== true)
        return failure(
          "unsupported_document_format",
          'This model cannot view page images; use format: "text".',
        )
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
      if (kind === "document")
        return readDocument(bytes, path, { pages, format }, context)
      const mediaType = inspectImageBytes(bytes).mediaType
      const saved = await context.rolloutAssets.saveToolFile(
        context.rolloutId,
        context.toolCallId,
        `image.${mediaType.split("/")[1]}`,
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
        presentation: mediaPresentation({
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
        }),
      }
    },
  }
}

async function readDocument(
  bytes: Buffer,
  path: { absolutePath: string; displayPath: string },
  input: { pages: string | undefined; format: "text" | "image" | undefined },
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const { rolloutAssets, rolloutId, toolCallId } = context
  if (
    rolloutAssets === undefined ||
    rolloutId === undefined ||
    toolCallId === undefined
  )
    throw new Error("Document reads require rollout asset storage.")
  const format =
    input.format ??
    (input.pages === undefined && context.documentReading?.nativePdf === true
      ? "native"
      : context.documentReading?.images === true
        ? "image"
        : "text")
  const { readPdf } = await import("./read-pdf.ts")
  const result = await readPdf(
    {
      bytes: Uint8Array.from(bytes),
      format,
      ...(input.pages === undefined ? {} : { pages: input.pages }),
    },
    context.signal,
  )
  if (!result.ok) return failure(result.code, result.message)
  const saved = await rolloutAssets.saveToolFile(
    rolloutId,
    toolCallId,
    "document.pdf",
    bytes,
  )
  const summary = `Read PDF: ${path.displayPath} (${result.totalPages} pages)${format === "native" ? "" : `; selected pages: ${result.pages.join(", ")}.`}`
  const output = {
    path: path.displayPath,
    mediaType: "application/pdf",
    sizeBytes: bytes.length,
    file: saved.reference,
    totalPages: result.totalPages,
    format,
    pages: result.pages,
  }
  if (format === "native")
    return {
      ok: true,
      content: summary,
      output,
      presentation: mediaPresentation({
        content: summary,
        documents: [
          {
            type: "document",
            mediaType: "application/pdf",
            name: basename(path.absolutePath),
            file: saved.reference,
            sizeBytes: bytes.length,
          },
        ],
      }),
    }
  if (format === "text")
    return {
      ok: true,
      content: `${summary}\n\n${result.text}`,
      output,
    }
  const images = []
  for (const image of result.images) {
    const saved = await rolloutAssets.saveToolFile(
      rolloutId,
      toolCallId,
      `page-${image.page}.jpg`,
      image.bytes,
    )
    images.push({
      type: "image" as const,
      mediaType: "image/jpeg" as const,
      detail: "original" as const,
      file: saved.reference,
      sizeBytes: image.bytes.byteLength,
    })
  }
  return {
    ok: true,
    content: summary,
    output: { ...output, images },
    presentation: mediaPresentation({ content: summary, images }),
  }
}

function failure(code: string, message: string) {
  return { ok: false as const, code, message, content: message }
}
