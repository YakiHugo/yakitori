import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { JsonObject } from "../../kernel/index.ts"
import { RuntimeLimits } from "../limits.ts"
import {
  closestEditCandidates,
  formatExpectedEditText,
  matchedEditCandidates,
  type EditDiagnosticCandidate,
} from "./edit-file-diagnostics.ts"
import { locateEditMatches } from "./edit-file-match.ts"
import {
  dominantLineEnding,
  normalizeReplacementLineEndings,
  preserveCurlyQuoteStyle,
} from "./text-file-format.ts"
import { resolveReadPath } from "./path-policy.ts"
import { compareAndWriteTextFile } from "./text-file-write.ts"
import type { RuntimeTool, ToolExecutionResult } from "./types.ts"

type EditInput = {
  readonly path: string
  readonly oldString: string
  readonly newString: string
  readonly replaceAll: boolean
}

export function createEditFileTool(
  maxBytes = RuntimeLimits.fileWriteBytes,
): RuntimeTool {
  return {
    name: "edit_file",
    description:
      "Replace text in an existing UTF-8 file that you read first. Supply the smallest unique oldString, usually 2-4 lines, and exclude read_file's {N}\\t line prefixes. Matching is exact first, followed only by deterministic line-ending, curly-quote, and trailing-whitespace equivalence. Indentation, internal whitespace, and single-vs-double quote delimiters remain exact. No similarity edit is ever applied. Set replaceAll only when every match should change.",
    autoAllow: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path of the existing text file.",
        },
        oldString: {
          type: "string",
          minLength: 1,
          description:
            "Existing text to replace. Include surrounding context when it is not unique.",
        },
        newString: {
          type: "string",
          description: "Replacement text, which must differ from oldString.",
        },
        replaceAll: {
          type: "boolean",
          description:
            "Replace every match instead of requiring exactly one match. Defaults to false.",
        },
      },
      required: ["path", "oldString", "newString"],
    },
    async execute(input, context): Promise<ToolExecutionResult> {
      const parsed = parseEditInput(input, maxBytes)
      if (!parsed.ok) return parsed.result

      const resolved = await resolveReadPath(context.workspaceRoot, parsed.path)
      if (!resolved.ok) {
        return editFailure(resolved.error.code, resolved.error.message, {
          suggestion: "Read an existing workspace text file before editing it.",
        })
      }

      const observed = context.fileObservations?.latest(resolved.relativePath)
      if (observed === undefined) {
        return editFailure(
          "file_not_observed",
          `${resolved.relativePath} has not been observed in this session.`,
          { suggestion: "Read it first with read_file or grep." },
        )
      }
      const observedSha256 = observed.sha256

      let bytes: Buffer
      try {
        bytes = await readFile(resolved.absolutePath)
      } catch {
        return editFailure(
          "read_failed",
          "The file could not be read safely.",
          {
            suggestion: "Read the file again before retrying the edit.",
          },
        )
      }
      if (bytes.byteLength > maxBytes) {
        return editFailure(
          "content_too_large",
          `edit_file cannot edit files larger than ${maxBytes} bytes.`,
        )
      }

      const currentSha256 = sha256(bytes)
      if (currentSha256 !== observedSha256) {
        return editFailure(
          "file_changed_since_observation",
          "The file changed since it was last observed in this session.",
          {
            suggestion:
              "Read the file again and rebuild the edit from its latest contents.",
          },
        )
      }

      const content = bytes.toString("utf8")
      if (
        Buffer.from(content, "utf8").compare(bytes) !== 0 ||
        content.includes("\0")
      ) {
        return editFailure(
          "unsupported_text_encoding",
          "edit_file only supports UTF-8 text files without NUL bytes.",
        )
      }

      const located = locateEditMatches(content, parsed.oldString)
      if (located.matches.length === 0) {
        const candidates = closestEditCandidates(content, parsed.oldString)
        return editFailure(
          "edit_target_not_found",
          `oldString was not found in ${resolved.relativePath}.`,
          {
            expected: formatExpectedEditText(parsed.oldString),
            candidates,
            recovery: editReadRecovery(
              resolved.relativePath,
              candidates[0],
              "Read the suggested range and retry edit_file with exact current text and enough surrounding context.",
            ),
          },
        )
      }
      if (!parsed.replaceAll && located.matches.length > 1) {
        const candidates = matchedEditCandidates(content, located.matches)
        return editFailure(
          "edit_target_ambiguous",
          `oldString matched ${located.matches.length} locations in ${resolved.relativePath}.`,
          {
            matchMode: located.mode,
            matchCount: located.matches.length,
            expected: formatExpectedEditText(parsed.oldString),
            candidates,
            recovery: editReadRecovery(
              resolved.relativePath,
              candidates[0],
              "Read the suggested range and add surrounding oldString context, or set replaceAll only when every occurrence should change.",
            ),
          },
        )
      }

      const matches = parsed.replaceAll
        ? located.matches
        : located.matches.slice(0, 1)
      const replacement = normalizeReplacementLineEndings(
        parsed.newString,
        dominantLineEnding(content),
      )
      let updated = content
      for (const match of [...matches].reverse()) {
        const styledReplacement = located.mode.startsWith("curly_quotes")
          ? preserveCurlyQuoteStyle(
              content.slice(match.start, match.end),
              replacement,
            )
          : replacement
        updated = `${updated.slice(0, match.start)}${styledReplacement}${updated.slice(match.end)}`
      }
      if (updated === content) {
        return editFailure(
          "no_change",
          "The requested replacement does not change the file.",
        )
      }
      if (Buffer.byteLength(updated, "utf8") > maxBytes) {
        return editFailure(
          "content_too_large",
          `The edited file would exceed ${maxBytes} bytes.`,
        )
      }

      const written = await compareAndWriteTextFile({
        workspaceRoot: context.workspaceRoot,
        path: parsed.path,
        content: updated,
        expectedSha256: observedSha256,
      })
      if (!written.ok) {
        if (written.code !== "stale_sha256") return written
        return editFailure(
          "file_changed_since_observation",
          "The file changed while edit_file was preparing the write.",
          { suggestion: "Read it again before rebuilding the edit." },
        )
      }

      const baseOutput =
        typeof written.output === "object" &&
        written.output !== null &&
        !Array.isArray(written.output)
          ? written.output
          : {}
      const output = {
        ...baseOutput,
        replacementCount: matches.length,
        matchMode: located.mode,
      }
      return {
        ok: true,
        output,
        content: JSON.stringify(output),
      }
    },
  }
}

function parseEditInput(
  input: unknown,
  maxBytes: number,
):
  | ({ readonly ok: true } & EditInput)
  | { readonly ok: false; readonly result: ToolExecutionResult } {
  if (!isRecord(input)) {
    return editInputFailure("edit_file input must be an object.")
  }
  const unsupported = Object.keys(input).find(
    (key) =>
      key !== "path" &&
      key !== "oldString" &&
      key !== "newString" &&
      key !== "replaceAll",
  )
  if (unsupported !== undefined) {
    return editInputFailure(
      `edit_file does not accept the ${unsupported} argument.`,
    )
  }
  if (typeof input.path !== "string") {
    return editInputFailure("edit_file path must be a string.")
  }
  if (typeof input.oldString !== "string") {
    return editInputFailure("edit_file oldString must be a string.")
  }
  if (input.oldString.length === 0) {
    return {
      ok: false,
      result: editFailure(
        "invalid_tool_input",
        "edit_file oldString must not be empty.",
        {
          reason: "empty_old_string",
          suggestion: "Use write_file to create or replace a complete file.",
        },
      ),
    }
  }
  if (typeof input.newString !== "string") {
    return editInputFailure("edit_file newString must be a string.")
  }
  if (input.oldString === input.newString) {
    return editInputFailure(
      "edit_file oldString and newString must differ.",
      "no_change",
    )
  }
  if (input.replaceAll !== undefined && typeof input.replaceAll !== "boolean") {
    return editInputFailure("edit_file replaceAll must be a boolean.")
  }

  const inputBytes =
    Buffer.byteLength(input.oldString, "utf8") +
    Buffer.byteLength(input.newString, "utf8")
  if (inputBytes > maxBytes * 2) {
    return editInputFailure(
      `edit_file replacement input exceeds ${maxBytes * 2} bytes.`,
      "content_too_large",
    )
  }

  return {
    ok: true,
    path: input.path,
    oldString: input.oldString,
    newString: input.newString,
    replaceAll: input.replaceAll ?? false,
  }
}

function editInputFailure(
  message: string,
  code = "invalid_tool_input",
): { readonly ok: false; readonly result: ToolExecutionResult } {
  return { ok: false, result: editFailure(code, message) }
}

function editReadRecovery(
  path: string,
  candidate: EditDiagnosticCandidate | undefined,
  instruction: string,
): JsonObject {
  const offset = Math.max(1, (candidate?.startLine ?? 1) - 3)
  const candidateLines =
    candidate === undefined ? 1 : candidate.endLine - candidate.startLine + 1
  return {
    action: "read_file",
    input: {
      path,
      offset,
      limit: Math.min(50, Math.max(10, candidateLines + 6)),
    },
    instruction,
  }
}

function editFailure(
  code: string,
  message: string,
  details: JsonObject = {},
): ToolExecutionResult {
  const error = { code, message, ...details }
  return {
    ok: false,
    code,
    message,
    content: JSON.stringify({ error }),
    ...(Object.keys(details).length === 0 ? {} : { output: details }),
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
