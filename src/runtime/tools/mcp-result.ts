import { imageDecodeError } from "../prepare-model-image.ts"
import type {
  JsonValue,
  ModelDocumentBlock,
  ModelImageBlock,
} from "../../kernel/index.ts"
import { inspectImageBytes } from "../../kernel/image-metadata.ts"
import { finalizeToolOutput } from "./result-output.ts"
import type { ToolExecutionContext, ToolExecutionResult } from "./types.ts"

export async function mcpResult(
  value: JsonValue,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const result = record(value)
  const blocks = Array.isArray(result?.content) ? result.content : []
  const text: string[] = []
  const images: ModelImageBlock[] = []
  const documents: ModelDocumentBlock[] = []
  const visible: JsonValue[] = []
  for (const [index, block] of blocks.entries()) {
    const item = record(block)
    if (item === undefined) continue
    if (item.type === "text" && typeof item.text === "string") {
      text.push(item.text)
      visible.push(item)
      continue
    }
    if (item.type === "resource_link") {
      text.push(`${item.name ?? "Resource"}: ${item.uri}`)
      visible.push(item)
      continue
    }
    const resource = record(item.resource)
    if (typeof resource?.text === "string") {
      text.push(resource.text)
      visible.push(item)
      continue
    }
    const data = item.type === "image" ? item.data : resource?.blob
    const mime = item.type === "image" ? item.mimeType : resource?.mimeType
    if (
      typeof data !== "string" ||
      (item.type !== "image" && mime !== "application/pdf")
    ) {
      text.push(`[Unsupported MCP content: ${String(item.type)}]`)
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
    if (item.type === "image") {
      const error = await imageDecodeError(bytes)
      if (error !== undefined) throw new Error(`Invalid MCP image: ${error}`)
    }
    const mediaType =
      item.type === "image"
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
    if (mediaType === "application/pdf")
      documents.push({
        type: "document",
        mediaType,
        name: `document-${index}.pdf`,
        sizeBytes: bytes.length,
        file: saved.reference,
      })
    else
      images.push({
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
    text.push(
      `[${mediaType === "application/pdf" ? "Document" : "Image"} attached]`,
    )
  }
  const content =
    text.length > 0
      ? text.join("\n")
      : JSON.stringify(result?.structuredContent ?? value)
  const output = {
    content: visible,
    ...(result?.structuredContent === undefined
      ? {}
      : { structuredContent: result.structuredContent }),
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
        const projected = await finalizeToolOutput(base, budget, context)
        return {
          ...projected,
          ...(images.length === 0 ? {} : { images }),
          ...(documents.length === 0 ? {} : { documents }),
        }
      },
    },
  }
}
function record(
  value: JsonValue | undefined,
): { [key: string]: JsonValue } | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as { [key: string]: JsonValue })
    : undefined
}
