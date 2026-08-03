import { RuntimeLimits } from "../limits.ts"
import { compareAndWriteTextFile } from "./text-file-write.ts"
import type { RuntimeTool, ToolExecutionResult } from "./types.ts"

export function createWriteFileTool(
  maxBytes = RuntimeLimits.fileWriteBytes,
): RuntimeTool {
  return {
    name: "write_file",
    description:
      "Create or intentionally replace a complete UTF-8 text file using compare-and-write. Existing files require expectedSha256 from a complete read_file result; new files require expectedSha256 null. Prefer edit_file for modifications—it only sends the diff. NEVER create *.md files unless the user explicitly requested one.",
    autoAllow: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path of the text file.",
        },
        content: {
          type: "string",
          description: "Complete desired UTF-8 contents of the file.",
        },
        expectedSha256: {
          type: ["string", "null"],
          description:
            "SHA-256 from a complete read_file result, or null only when creating a new file.",
          pattern: "^[A-Fa-f0-9]{64}$",
        },
      },
      required: ["path", "content", "expectedSha256"],
    },
    async execute(input, context): Promise<ToolExecutionResult> {
      const parsed = parseWriteInput(input, maxBytes)
      if (!parsed.ok) return parsed.result

      return compareAndWriteTextFile({
        workspaceRoot: context.workspaceRoot,
        path: parsed.path,
        content: parsed.content,
        expectedSha256: parsed.expectedSha256,
      })
    },
  }
}

function parseWriteInput(
  input: unknown,
  maxBytes: number,
):
  | {
      readonly ok: true
      readonly path: string
      readonly content: string
      readonly expectedSha256: string | null
    }
  | { readonly ok: false; readonly result: ToolExecutionResult } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      ok: false,
      result: writeInputFailure("write_file input must be an object."),
    }
  }
  const record = input as Record<string, unknown>
  const unsupported = Object.keys(record).find(
    (key) => key !== "path" && key !== "content" && key !== "expectedSha256",
  )
  if (unsupported !== undefined) {
    return {
      ok: false,
      result: writeInputFailure(
        `write_file does not accept the ${unsupported} argument.`,
      ),
    }
  }
  if (typeof record.path !== "string") {
    return {
      ok: false,
      result: writeInputFailure("write_file path must be a string."),
    }
  }
  if (typeof record.content !== "string") {
    return {
      ok: false,
      result: writeInputFailure("write_file content must be a string."),
    }
  }
  if (Buffer.byteLength(record.content, "utf8") > maxBytes) {
    return {
      ok: false,
      result: writeInputFailure(
        `write_file content exceeds ${maxBytes} bytes.`,
        "content_too_large",
      ),
    }
  }
  if (
    !(
      typeof record.expectedSha256 === "string" ||
      record.expectedSha256 === null
    )
  ) {
    return {
      ok: false,
      result: writeInputFailure(
        "write_file expectedSha256 must be a string or null.",
      ),
    }
  }
  if (
    typeof record.expectedSha256 === "string" &&
    !/^[a-f0-9]{64}$/i.test(record.expectedSha256)
  ) {
    return {
      ok: false,
      result: writeInputFailure(
        "write_file expectedSha256 must be a 64-character hex SHA-256.",
      ),
    }
  }
  return {
    ok: true,
    path: record.path,
    content: record.content,
    expectedSha256:
      typeof record.expectedSha256 === "string"
        ? record.expectedSha256.toLowerCase()
        : null,
  }
}

function writeInputFailure(
  message: string,
  code = "invalid_tool_input",
): ToolExecutionResult {
  return {
    ok: false,
    code,
    message,
    content: JSON.stringify({ error: { code, message } }),
  }
}
