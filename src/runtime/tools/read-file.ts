import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { StringDecoder } from "node:string_decoder"
import { RuntimeLimits } from "../limits.ts"
import { resolveReadPath } from "./path-policy.ts"
import type { RuntimeTool, ToolExecutionResult } from "./types.ts"

export function createReadFileTool(
  maxBytes = RuntimeLimits.rawFileReadBytes,
): RuntimeTool {
  return {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the session workspace. Returns content, SHA-256, and truncation metadata.",
    autoAllow: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["path"],
    },
    async execute(input, context): Promise<ToolExecutionResult> {
      const parsed = parseReadInput(input)
      if (!parsed.ok) return parsed.result

      const resolved = await resolveReadPath(context.workspaceRoot, parsed.path)
      if (!resolved.ok) {
        return {
          ok: false,
          code: resolved.error.code,
          message: resolved.error.message,
          content: resolved.error.message,
        }
      }

      const startLine = parsed.offset ?? 0
      const selectedEnd =
        parsed.limit === undefined
          ? Number.POSITIVE_INFINITY
          : startLine + parsed.limit
      const hash = createHash("sha256")
      const decoder = new StringDecoder("utf8")
      const selectedChars: string[] = []
      let selectedBytes = 0
      let totalBytes = 0
      let totalLines = 1
      let currentLine = 0
      let pendingNewline = false
      let truncatedByBytes = false

      const append = (value: string) => {
        const bytes = Buffer.byteLength(value, "utf8")
        if (selectedBytes + bytes > maxBytes) {
          truncatedByBytes = true
          return
        }
        selectedChars.push(value)
        selectedBytes += bytes
      }
      const processText = (text: string) => {
        for (const char of text) {
          const selected = currentLine >= startLine && currentLine < selectedEnd
          if (selected && pendingNewline) {
            append("\n")
            pendingNewline = false
          }
          if (char !== "\n") {
            if (selected) append(char)
            continue
          }

          currentLine += 1
          totalLines += 1
          pendingNewline =
            selected && currentLine >= startLine && currentLine < selectedEnd
        }
      }

      for await (const chunk of createReadStream(resolved.absolutePath, {
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      })) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        totalBytes += buffer.byteLength
        hash.update(buffer)
        processText(decoder.write(buffer))
      }
      processText(decoder.end())
      if (
        pendingNewline &&
        currentLine >= startLine &&
        currentLine < selectedEnd
      ) {
        append("\n")
      }

      const endLine = Math.min(totalLines, selectedEnd)
      const truncatedByLines = endLine < totalLines || startLine > 0
      const selected = truncatedByBytes
        ? addTruncationMarker(selectedChars.join(""), maxBytes)
        : selectedChars.join("")

      const truncated = truncatedByLines || truncatedByBytes
      const output = {
        path: resolved.relativePath,
        content: selected,
        sha256: hash.digest("hex"),
        byteCount: totalBytes,
        lineCount: totalLines,
        truncated,
        truncatedByBytes,
        truncatedByLines,
        range: {
          offset: startLine,
          limit: Math.max(0, endLine - startLine),
        },
      }

      return {
        ok: true,
        output,
        content: JSON.stringify(output),
      }
    },
  }
}

function parseReadInput(input: unknown):
  | {
      readonly ok: true
      readonly path: string
      readonly offset?: number
      readonly limit?: number
    }
  | { readonly ok: false; readonly result: ToolExecutionResult } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      ok: false,
      result: {
        ok: false,
        code: "invalid_tool_input",
        message: "read_file input must be an object.",
        content: "read_file input must be an object.",
      },
    }
  }
  const record = input as Record<string, unknown>
  if (typeof record.path !== "string") {
    return {
      ok: false,
      result: {
        ok: false,
        code: "invalid_tool_input",
        message: "read_file path must be a string.",
        content: "read_file path must be a string.",
      },
    }
  }
  if (
    record.offset !== undefined &&
    !(Number.isInteger(record.offset) && (record.offset as number) >= 0)
  ) {
    return {
      ok: false,
      result: {
        ok: false,
        code: "invalid_tool_input",
        message: "read_file offset must be a non-negative integer.",
        content: "read_file offset must be a non-negative integer.",
      },
    }
  }
  if (
    record.limit !== undefined &&
    !(Number.isInteger(record.limit) && (record.limit as number) > 0)
  ) {
    return {
      ok: false,
      result: {
        ok: false,
        code: "invalid_tool_input",
        message: "read_file limit must be a positive integer.",
        content: "read_file limit must be a positive integer.",
      },
    }
  }
  return {
    ok: true,
    path: record.path,
    ...(record.offset === undefined ? {} : { offset: record.offset as number }),
    ...(record.limit === undefined ? {} : { limit: record.limit as number }),
  }
}

function addTruncationMarker(value: string, maxBytes: number): string {
  const marker = "\n...[truncated bytes]"
  const markerBytes = Buffer.byteLength(marker, "utf8")
  if (markerBytes >= maxBytes) return truncateUtf8(marker, maxBytes)
  return `${truncateUtf8(value, maxBytes - markerBytes)}${marker}`
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0
  let end = 0
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8")
    if (bytes + charBytes > maxBytes) break
    bytes += charBytes
    end += char.length
  }
  return value.slice(0, end)
}
