import type { RuntimeTool, ToolExecutionResult } from "./types.ts"

// Leave room under the 50 KiB model-result cap for base64 expansion and the
// cursor footer. Text pages use the same bound so callers have one contract.
const DEFAULT_LIMIT = 32 * 1024
const MAX_LIMIT = 32 * 1024
const UTF8_BOUNDARY_BYTES = 3

export function createReadSessionFileTool(): RuntimeTool {
  return {
    name: "read_session_file",
    description:
      "Read a bounded byte range from a file produced inside the current Session, such as retained run_command stdout or stderr. Pass the relative path returned by the producing tool. Text pages preserve UTF-8 character boundaries; binary pages are returned as base64. This cannot read workspace or other Session files.",
    autoAllow: true,
    effect: "observe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description:
            "Session-relative file path returned by a tool, for example tools/<tool-call-id>/stdout.log.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Zero-based byte offset. Defaults to 0.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Maximum bytes to return. Defaults to ${DEFAULT_LIMIT}.`,
        },
      },
      required: ["path"],
    },
    async execute(input, context): Promise<ToolExecutionResult> {
      const parsed = parseInput(input)
      if (!parsed.ok) return failure("invalid_tool_input", parsed.message)
      if (
        context.sessionFiles === undefined ||
        context.sessionId === undefined
      ) {
        return failure(
          "session_files_unavailable",
          "Session file storage is unavailable for this execution.",
        )
      }
      try {
        const result = await context.sessionFiles.readRange(
          { sessionId: context.sessionId, path: parsed.path },
          parsed.offset,
          parsed.limit + UTF8_BOUNDARY_BYTES,
        )
        const page = decodePage(result.bytes, parsed.offset, parsed.limit)
        const endOffset = page.offset + page.bytes.byteLength
        const hasMore = endOffset < result.totalBytes
        const content = [
          page.content,
          `(${page.offset}-${endOffset} of ${result.totalBytes} bytes; ${page.encoding}${hasMore ? "; more available" : ""})`,
        ]
          .filter((part) => part.length > 0)
          .join("\n")
        return {
          ok: true,
          content,
          output: {
            path: parsed.path,
            content: page.content,
            encoding: page.encoding,
            offset: page.offset,
            endOffset,
            totalBytes: result.totalBytes,
            hasMore,
          },
        }
      } catch (error) {
        return failure(
          "session_file_read_failed",
          `Could not read Session file: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
  }
}

function decodePage(
  bytes: Buffer,
  requestedOffset: number,
  limit: number,
): {
  readonly bytes: Buffer
  readonly content: string
  readonly encoding: "base64" | "utf8"
  readonly offset: number
} {
  const start = 0
  let end = Math.min(bytes.byteLength, limit)
  while (end < bytes.byteLength && isUtf8Continuation(bytes[end])) end += 1
  const textBytes = bytes.subarray(start, end)
  if (!textBytes.includes(0)) {
    try {
      return {
        bytes: textBytes,
        content: new TextDecoder("utf-8", { fatal: true }).decode(textBytes),
        encoding: "utf8",
        offset: requestedOffset + start,
      }
    } catch {
      // Invalid UTF-8 is returned without lossy replacement characters below.
    }
  }
  const binaryBytes = bytes.subarray(0, Math.min(limit, bytes.byteLength))
  return {
    bytes: binaryBytes,
    content: binaryBytes.toString("base64"),
    encoding: "base64",
    offset: requestedOffset,
  }
}

function isUtf8Continuation(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80
}

function parseInput(input: unknown):
  | {
      readonly ok: true
      readonly path: string
      readonly offset: number
      readonly limit: number
    }
  | { readonly ok: false; readonly message: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, message: "read_session_file input must be an object." }
  }
  const value = input as Record<string, unknown>
  if (typeof value.path !== "string" || value.path.length === 0) {
    return {
      ok: false,
      message: "read_session_file path must be a non-empty string.",
    }
  }
  const unknown = Object.keys(value).filter(
    (key) => key !== "path" && key !== "offset" && key !== "limit",
  )
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `read_session_file does not accept: ${unknown.join(", ")}.`,
    }
  }
  const offset = value.offset ?? 0
  const limit = value.limit ?? DEFAULT_LIMIT
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
    return {
      ok: false,
      message: "read_session_file offset must be a non-negative integer.",
    }
  }
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIMIT
  ) {
    return {
      ok: false,
      message: `read_session_file limit must be an integer from 1 to ${MAX_LIMIT}.`,
    }
  }
  return { ok: true, path: value.path, offset, limit }
}

function failure(code: string, message: string): ToolExecutionResult {
  return { ok: false, code, message, content: message }
}
