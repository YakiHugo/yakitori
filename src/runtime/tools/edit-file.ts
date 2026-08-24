import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { JsonObject } from "../../kernel/index.ts"
import { ToolLimitDefaults } from "../limits.ts"
import {
  closestEditCandidates,
  matchedEditLocations,
} from "./edit-file-diagnostics.ts"
import { locateEditMatches } from "./edit-file-match.ts"
import { resolveReadPath, resolveWritePath } from "./path-policy.ts"
import {
  completeFileChangeExecution,
  fileChangeExecution,
} from "./execution-descriptors.ts"
import {
  dominantLineEnding,
  normalizeReplacementLineEndings,
  preserveCurlyQuoteStyle,
} from "./text-file-format.ts"
import { compareAndWriteTextFile } from "./text-file-write.ts"
import type { RuntimeTool, ToolExecutionResult } from "./types.ts"

type EditInput = {
  readonly path: string
  readonly oldString: string
  readonly newString: string
  readonly replaceAll: boolean
}

export function createEditFileTool(
  maxBytes = ToolLimitDefaults.fileWriteBytes,
): RuntimeTool {
  return {
    name: "edit_file",
    description:
      "Replace text in an existing UTF-8 file, or create a new file by setting oldString to an empty string. Accepts paths relative to the workspace and absolute paths. An empty oldString never overwrites an existing file. Read existing files before editing them. Supply the smallest unique non-empty oldString, usually 2-4 lines, and exclude read_file's {N}\\t line prefixes. A ranged read requires an exact unique oldString; replaceAll requires a complete read. For a complete unchanged revision, matching is exact first, followed only by deterministic line-ending, curly-quote, and trailing-whitespace equivalence. No similarity edit is ever applied.",
    autoAllow: true,
    effect: "mutate",
    describeExecution: fileChangeExecution("edit"),
    completeExecution: completeFileChangeExecution,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative or absolute path of the text file.",
        },
        oldString: {
          type: "string",
          description:
            "Existing text to replace, or an empty string to create a new file without overwriting. Include surrounding context when replacement text is not unique.",
        },
        newString: {
          type: "string",
          description:
            "Replacement text. For an existing file, it must differ from oldString.",
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
      if (parsed.oldString === "") {
        const resolved = await resolveWritePath(
          context.workspaceRoot,
          parsed.path,
        )
        if (!resolved.ok) {
          return editFailure(resolved.error.code, resolved.error.message)
        }
        if (resolved.exists) return fileExistsFailure(resolved.displayPath)

        const written = await compareAndWriteTextFile({
          workspaceRoot: context.workspaceRoot,
          path: resolved.displayPath,
          content: parsed.newString,
          expectedSha256: null,
        })
        if (!written.ok) {
          return written.code === "file_exists"
            ? fileExistsFailure(resolved.displayPath)
            : written
        }
        const baseOutput = asJsonObject(written.output)
        const createdGrant = writeGrant(baseOutput, "edit", { created: true })
        const result = {
          ok: true,
          output: {
            ...baseOutput,
            action: "create",
            ...(createdGrant === undefined
              ? {}
              : { fileObservation: createdGrant }),
          },
          content: `Created ${resolved.displayPath} (${Buffer.byteLength(parsed.newString, "utf8")} bytes).`,
        } satisfies ToolExecutionResult
        return result
      }

      const resolved = await resolveReadPath(context.workspaceRoot, parsed.path)
      if (!resolved.ok) {
        return editFailure(resolved.error.code, resolved.error.message, {
          suggestion: "Read an existing workspace text file before editing it.",
        })
      }

      const observed = context.visibleFileObservations?.latest(
        resolved.displayPath,
      )
      if (observed === undefined) {
        return editFailure(
          "file_not_observed",
          `${resolved.displayPath} is not visible in the current model context.`,
          { suggestion: "Read it first with read_file." },
        )
      }
      const observedSha256 = observed.sha256
      if (!observed.complete && parsed.replaceAll) {
        return editFailure(
          "file_not_fully_observed",
          "replaceAll requires a complete visible file revision.",
          { suggestion: "Read the complete file before retrying replaceAll." },
        )
      }

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
      const observedRevisionKnown = observedSha256 !== undefined
      const optimisticRebase =
        observedRevisionKnown && currentSha256 !== observedSha256
      const exactAnchorRequired = !observed.complete || optimisticRebase
      if (optimisticRebase && parsed.replaceAll) {
        return editFailure(
          "file_changed_since_observation",
          "The file changed since it was observed; replaceAll requires the observed revision.",
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
      if (exactAnchorRequired && located.mode !== "exact") {
        if (optimisticRebase) {
          return editFailure(
            "file_changed_since_observation",
            "The file changed since it was observed and the edit anchor no longer matches exactly.",
            {
              suggestion:
                "Read the file again and rebuild the edit from its latest contents.",
            },
          )
        }
        return editFailure(
          "old_string_not_found",
          `oldString was not found exactly in the current ${resolved.displayPath}.`,
          {
            suggestion: "Read the current text and use an exact unique anchor.",
          },
        )
      }
      if (optimisticRebase && located.matches.length !== 1) {
        return editFailure(
          "file_changed_since_observation",
          "The file changed since it was observed and the exact edit anchor is no longer unique.",
          {
            suggestion:
              "Read the file again and rebuild the edit from its latest contents.",
          },
        )
      }
      if (located.matches.length === 0) {
        const nearMatches = closestEditCandidates(content, parsed.oldString)
        return editFailure(
          "old_string_not_found",
          `oldString was not found in ${resolved.displayPath}.`,
          nearMatches.length === 0 ? {} : { nearMatches },
        )
      }
      if (!parsed.replaceAll && located.matches.length > 1) {
        return editFailure(
          "old_string_ambiguous",
          `oldString matched ${located.matches.length} locations in ${resolved.displayPath}.`,
          {
            matchMode: located.mode,
            matchCount: located.matches.length,
            locations: matchedEditLocations(content, located.matches),
          },
        )
      }

      const matches = parsed.replaceAll
        ? located.matches
        : located.matches.slice(0, 1)
      const changedRanges = matchedEditLocations(content, matches)
      const editWithinObservedRanges =
        observed.complete ||
        changedRanges.every((changed) =>
          observed.ranges?.some(
            (range) =>
              range.startLine <= changed.startLine &&
              range.endLine >= changed.endLine,
          ),
        )
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
        path: resolved.displayPath,
        content: updated,
        expectedSha256: currentSha256,
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
      const editGrant = writeGrant(asJsonObject(written.output), "edit", {
        optimisticRebase,
      })
      const output = {
        ...baseOutput,
        replacementCount: matches.length,
        matchMode: located.mode,
        optimisticRebase,
        observedRevisionKnown,
        ...(observedSha256 === undefined ? {} : { observedSha256 }),
        changedRanges,
        observation: {
          kind: observed.observation,
          complete: observed.complete,
          editWithinObservedRanges,
        },
        ...(editGrant === undefined ? {} : { fileObservation: editGrant }),
      }
      return {
        ok: true,
        output,
        content: `Updated ${resolved.displayPath}: replaced ${matches.length} ${matches.length === 1 ? "match" : "matches"} (${located.mode}).`,
      }
    },
  }
}

function asJsonObject(value: unknown): JsonObject {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonObject
  }
  return {}
}

function writeGrant(
  output: JsonObject,
  kind: "edit" | "write",
  flags: { readonly created?: boolean; readonly optimisticRebase?: boolean },
): JsonObject | undefined {
  const path = output.path
  const sha256 = output.sha256
  if (typeof path !== "string" || typeof sha256 !== "string") return undefined
  return {
    path,
    kind,
    complete: flags.created === true || kind === "write",
    sha256,
    ...(flags.created === true ? { created: true } : {}),
    ...(flags.optimisticRebase === true ? { optimisticRebase: true } : {}),
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
  if (typeof input.newString !== "string") {
    return editInputFailure("edit_file newString must be a string.")
  }
  if (input.replaceAll !== undefined && typeof input.replaceAll !== "boolean") {
    return editInputFailure("edit_file replaceAll must be a boolean.")
  }
  if (input.oldString === "" && input.replaceAll === true) {
    return editInputFailure(
      "replaceAll cannot be used when oldString is empty.",
    )
  }
  if (input.oldString !== "" && input.oldString === input.newString) {
    return editInputFailure(
      "edit_file oldString and newString must differ.",
      "no_change",
    )
  }

  const inputBytes =
    Buffer.byteLength(input.oldString, "utf8") +
    Buffer.byteLength(input.newString, "utf8")
  if (
    input.oldString === "" &&
    Buffer.byteLength(input.newString, "utf8") > maxBytes
  ) {
    return editInputFailure(
      `The new file would exceed ${maxBytes} bytes.`,
      "content_too_large",
    )
  }
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

function fileExistsFailure(path: string): ToolExecutionResult {
  return editFailure(
    "file_exists",
    `Cannot create ${path} because the file already exists.`,
    {
      suggestion:
        "Use a non-empty oldString to edit it, or write_file for an intentional whole-file replacement.",
    },
  )
}

function editFailure(
  code: string,
  message: string,
  details: JsonObject = {},
): ToolExecutionResult {
  return {
    ok: false,
    code,
    message,
    content: renderEditFailure(code, message, details),
    ...(Object.keys(details).length === 0 ? {} : { output: details }),
  }
}

function renderEditFailure(
  code: string,
  message: string,
  details: JsonObject,
): string {
  const lines = [`${code}: ${message}`]
  if (typeof details.suggestion === "string") {
    lines.push(`Suggestion: ${details.suggestion}`)
  }
  if (Array.isArray(details.nearMatches)) {
    lines.push("Near matches:")
    for (const match of details.nearMatches) {
      if (!isRecord(match)) continue
      lines.push(
        `Lines ${String(match.startLine)}-${String(match.endLine)} (score ${String(match.score)}):`,
      )
      if (typeof match.text === "string") lines.push(match.text)
    }
  }
  if (Array.isArray(details.locations)) {
    lines.push("Exact match locations:")
    for (const location of details.locations) {
      if (!isRecord(location)) continue
      lines.push(
        `- lines ${String(location.startLine)}-${String(location.endLine)}`,
      )
    }
  }
  return lines.join("\n")
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
