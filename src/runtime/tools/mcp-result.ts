import { isDeepStrictEqual } from "node:util"
import { inspectImageBytes } from "../../kernel/image-metadata.ts"
import type { JsonValue, ModelToolContentBlock } from "../../kernel/index.ts"
import { imageDecodeError } from "../prepare-model-image.ts"
import { finalizeToolContent } from "./result-output.ts"
import type { ToolExecutionContext, ToolExecutionResult } from "./types.ts"

export async function mcpResult(
  value: JsonValue,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const result = record(value)
  const blocks = Array.isArray(result?.content) ? result.content : []
  const text: string[] = []
  const parts: ModelToolContentBlock[] = []
  const appendText = (value: string) => {
    text.push(value)
    parts.push({ type: "text", text: value })
  }
  const visible: JsonValue[] = []
  for (const [index, block] of blocks.entries()) {
    const item = record(block)
    if (item === undefined) continue
    if (item.type === "text" && typeof item.text === "string") {
      appendText(item.text)
      visible.push(item)
      continue
    }
    if (item.type === "resource_link") {
      appendText(`${item.name ?? "Resource"}: ${item.uri}`)
      visible.push(item)
      continue
    }
    const resource = record(item.resource)
    if (typeof resource?.text === "string") {
      appendText(resource.text)
      visible.push(item)
      continue
    }
    const data = item.type === "image" ? item.data : resource?.blob
    const mime = item.type === "image" ? item.mimeType : resource?.mimeType
    const isImage =
      item.type === "image" ||
      (typeof mime === "string" && mime.startsWith("image/"))
    if (typeof data !== "string" || (!isImage && mime !== "application/pdf")) {
      appendText(`[Unsupported MCP content: ${String(item.type)}]`)
      visible.push({ type: String(item.type), unsupported: true })
      continue
    }
    if (
      context.rolloutAssets === undefined ||
      context.rolloutId === undefined ||
      context.toolCallId === undefined
    )
      throw new Error("MCP media requires rollout asset storage.")
    // Reject oversized/invalid transport data before allocating the decoded snapshot.
    if (data.length > 67_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
      throw new Error("Invalid or oversized MCP media payload.")
    const bytes = Buffer.from(data, "base64")
    if (isImage) {
      const error = await imageDecodeError(bytes)
      if (error !== undefined) throw new Error(`Invalid MCP image: ${error}`)
    }
    const mediaType = isImage
      ? inspectImageBytes(bytes).mediaType
      : "application/pdf"
    if (
      mediaType === "application/pdf" &&
      bytes.subarray(0, 5).toString() !== "%PDF-"
    )
      throw new Error("Invalid MCP PDF payload.")
    const saved = await context.rolloutAssets.saveToolFile(
      context.rolloutId,
      context.toolCallId,
      `media-${index}.${mediaType.split("/")[1]}`,
      bytes,
    )
    appendText(
      `[${mediaType === "application/pdf" ? "Document" : "Image"} attached]`,
    )
    if (mediaType === "application/pdf")
      parts.push({
        type: "document",
        mediaType,
        name: `document-${index}.pdf`,
        sizeBytes: bytes.length,
        file: saved.reference,
      })
    else
      parts.push({
        type: "image",
        mediaType,
        detail: "high",
        sizeBytes: bytes.length,
        file: saved.reference,
      })
    visible.push({
      type: item.type ?? "resource",
      mediaType,
      sizeBytes: bytes.length,
      file: saved.reference,
    })
  }
  const structuredContent = result?.structuredContent
  if (
    structuredContent !== undefined &&
    !text.some((part) => carriesStructuredContent(part, structuredContent))
  )
    appendText(JSON.stringify(structuredContent))
  const content = text.join("\n")
  const output = {
    content: visible,
    ...(result?.structuredContent === undefined
      ? {}
      : { structuredContent: result.structuredContent }),
    // MCP metadata belongs to the host/UI, never the model projection.
    ...(result?._meta === undefined ? {} : { _meta: result._meta }),
  }
  const base: ToolExecutionResult =
    result?.isError === true
      ? { ok: false, code: "mcp_tool_error", message: content, content, output }
      : { ok: true, content, output }
  // Text offload remains the common policy, while media never enters text truncation.
  return {
    ...base,
    presentation: {
      async toModelContent(budget) {
        return finalizeToolContent(parts, budget, context)
      },
    },
  }
}

function carriesStructuredContent(text: string, value: JsonValue): boolean {
  if (typeof value === "string" && text === value) return true
  let candidate = text
  if (typeof value === "object" && value !== null) {
    const array = Array.isArray(value)
    const start = text.indexOf(array ? "[" : "{")
    const end = text.lastIndexOf(array ? "]" : "}")
    if (start < 0 || end < start) return false
    // Cover standalone JSON, prose and fences without parsing a document stream.
    // Ambiguous text with multiple JSON documents conservatively keeps the payload.
    candidate = text.slice(start, end + 1)
  }
  try {
    return isDeepStrictEqual(JSON.parse(candidate), value)
  } catch (error) {
    if (error instanceof SyntaxError) return false
    throw error
  }
}

function record(
  value: JsonValue | undefined,
): { [key: string]: JsonValue } | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as { [key: string]: JsonValue })
    : undefined
}
