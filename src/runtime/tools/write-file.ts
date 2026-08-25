import { ToolLimitDefaults } from "../limits.ts"
import { fileChangeApprovalRequirement } from "./approval-requirements.ts"
import { resolveWritePath } from "./path-policy.ts"
import { compareAndWriteTextFile } from "./text-file-write.ts"
import {
  completeFileChangeExecution,
  fileChangeExecution,
} from "./execution-descriptors.ts"
import type { RuntimeTool, ToolExecutionResult } from "./types.ts"

export function createWriteFileTool(
  maxBytes = ToolLimitDefaults.fileWriteBytes,
): RuntimeTool {
  return {
    name: "write_file",
    description:
      "Create or intentionally replace a complete UTF-8 text file using compare-and-write. Accepts paths relative to the workspace and absolute paths. New files are created without a prior read. Before replacing an existing file, read the complete current file; write_file rejects missing, partial, or stale observations. Prefer edit_file for focused modifications.",
    approvalRequirement: fileChangeApprovalRequirement,
    effect: "mutate",
    describeExecution: fileChangeExecution("write"),
    completeExecution: completeFileChangeExecution,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative or absolute path of the text file.",
        },
        content: {
          type: "string",
          description: "Complete desired UTF-8 contents of the file.",
        },
      },
      required: ["path", "content"],
    },
    async execute(input, context): Promise<ToolExecutionResult> {
      const parsed = parseWriteInput(input, maxBytes)
      if (!parsed.ok) return parsed.result
      const resolved = await resolveWritePath(
        context.workspaceRoot,
        parsed.path,
      )
      if (!resolved.ok) {
        return writeFailure(resolved.error.code, resolved.error.message)
      }
      const observed = context.visibleFileObservations?.latest(
        resolved.displayPath,
      )
      if (resolved.exists && observed === undefined) {
        return writeFailure(
          "file_not_observed",
          `${resolved.displayPath} has not been read in the current model context.`,
          "Read the complete file before replacing it.",
        )
      }
      if (
        observed !== undefined &&
        (!observed.complete || observed.sha256 === undefined)
      ) {
        return writeFailure(
          "file_not_fully_observed",
          `${resolved.displayPath} has only been partially observed.`,
          "Read the complete file before replacing it.",
        )
      }

      const written = await compareAndWriteTextFile({
        workspaceRoot: context.workspaceRoot,
        path: resolved.displayPath,
        content: parsed.content,
        expectedSha256: observed?.sha256 ?? null,
      })
      if (!written.ok) return written
      const observedResult = withFileObservation(written, "write")
      if (!observedResult.ok) return observedResult
      return observedResult
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
    (key) => key !== "path" && key !== "content",
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
  return {
    ok: true,
    path: record.path,
    content: record.content,
  }
}

function withFileObservation(
  written: Extract<ToolExecutionResult, { readonly ok: true }>,
  kind: "write" | "edit",
): ToolExecutionResult {
  if (!isRecord(written.output) || typeof written.output.path !== "string") {
    return written
  }
  const sha256 =
    typeof written.output.sha256 === "string"
      ? written.output.sha256
      : undefined
  if (sha256 === undefined) return written
  return {
    ...written,
    output: {
      ...written.output,
      fileObservation: {
        path: written.output.path,
        kind,
        complete: true,
        sha256,
        ...(written.output.created === true ? { created: true } : {}),
      },
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function writeFailure(
  code: string,
  message: string,
  suggestion?: string,
): ToolExecutionResult {
  return {
    ok: false,
    code,
    message,
    content: [
      `${code}: ${message}`,
      ...(suggestion === undefined ? [] : [`Suggestion: ${suggestion}`]),
    ].join("\n"),
    ...(suggestion === undefined ? {} : { output: { suggestion } }),
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
    content: `${code}: ${message}`,
  }
}
