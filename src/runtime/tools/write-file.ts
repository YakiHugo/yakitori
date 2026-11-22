import { ToolLimitDefaults } from "../limits.ts"
import { fileChangeApprovalRequirement } from "./approval-requirements.ts"
import {
  completeFileChangeExecution,
  fileChangeExecution,
} from "./execution-descriptors.ts"
import { isSameWriteTarget, resolveWritePath } from "./path-policy.ts"
import { readTextFileSnapshot } from "./text-file-snapshot.ts"
import { withTextFileWriteLocks } from "./text-file-write.ts"
import { plainToolName } from "./tool-name.ts"
import type { RuntimeTool, ToolExecutionResult } from "./types.ts"

export function createWriteFileTool(
  maxBytes = ToolLimitDefaults.fileWriteBytes,
): RuntimeTool {
  return {
    toolName: plainToolName("write_file"),
    description:
      "Create or intentionally replace a complete UTF-8 text file using compare-and-write. Accepts paths relative to the workspace and absolute paths. New files are created without a prior read. An existing file may be intentionally replaced without a full read. If a previously observed revision has changed, read it again before replacing it. Prefer edit_file for focused modifications.",
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
        true,
      )
      if (!resolved.ok) {
        return writeFailure(resolved.error.code, resolved.error.message)
      }
      return withTextFileWriteLocks(
        [resolved.absolutePath, ...resolved.missingParents],
        async (locked) => {
          context.signal?.throwIfAborted()
          const target = await resolveWritePath(
            context.workspaceRoot,
            parsed.path,
            true,
          )
          if (!target.ok)
            return writeFailure(target.error.code, target.error.message)
          if (
            !(await isSameWriteTarget(
              context.workspaceRoot,
              resolved.absolutePath,
              target.absolutePath,
              !resolved.exists,
            ))
          ) {
            return writeFailure(
              "path_changed",
              `The target of ${parsed.path} changed. Read it again before replacing it.`,
            )
          }
          const observations = context.visibleFileObservations
          if (
            observations?.targetChanged(
              target.displayPath,
              target.requestedDisplayPath,
            )
          ) {
            return writeFailure(
              "path_changed",
              `The target of ${parsed.path} changed since it was observed. Read it again before replacing it.`,
            )
          }
          if (observations?.requiresRefresh(target.displayPath)) {
            return writeFailure(
              "file_revision_unknown",
              `Read ${target.displayPath} before replacing it after the incomplete change.`,
            )
          }
          let expectedSha256 =
            observations?.latest(target.displayPath)?.sha256 ?? null
          if (target.exists) {
            const current = await readTextFileSnapshot(
              target.absolutePath,
              target.displayPath,
              maxBytes,
            )
            if (!current.ok) return current
            expectedSha256 ??= current.sha256
          }
          context.signal?.throwIfAborted()
          const written = await locked.write(resolved.absolutePath, {
            workspaceRoot: context.workspaceRoot,
            path: parsed.path,
            content: parsed.content,
            expectedSha256,
            maxBytes,
            createParentDirectories: true,
          })
          if (!written.ok) return written
          return {
            ...written,
            output: {
              ...written.output,
              fileObservation: {
                path: written.output.path,
                ...(target.requestedDisplayPath === written.output.path
                  ? {}
                  : { aliases: [target.requestedDisplayPath] }),
                kind: "write",
                complete: true,
                sha256: written.output.sha256,
                ...(written.output.created ? { created: true } : {}),
              },
            },
          }
        },
      )
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
  if (record.content.includes("\0")) {
    return {
      ok: false,
      result: writeInputFailure("write_file content cannot contain NUL bytes."),
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
