import type { JsonObject } from "../../kernel/index.ts"
import { ToolLimitDefaults } from "../limits.ts"
import { fileChangeApprovalRequirement } from "./approval-requirements.ts"
import { editFailure } from "./edit-file-diagnostics.ts"
import {
  type EditReplacement,
  prepareEdit,
  staleEditFailure,
} from "./edit-file-replacement.ts"
import { completeFileChangeExecution } from "./execution-descriptors.ts"
import {
  conflictingFileTargets,
  isSameWriteTarget,
  resolveReadPath,
  resolveWritePath,
} from "./path-policy.ts"
import {
  fileCommitFailureAtPath,
  withTextFileWriteLocks,
  type TextFileWriteOutput,
} from "./text-file-write.ts"
import { readTextFileSnapshot } from "./text-file-snapshot.ts"
import { plainToolName } from "./tool-name.ts"
import type { RuntimeTool, ToolFailure } from "./types.ts"

// The batch holds one bounded snapshot and diff per target in memory.
const MAX_BATCH_EDITS = 32

type EditInput = EditReplacement & Readonly<{ path: string }>

type EditTarget = Extract<
  Awaited<ReturnType<typeof resolveWritePath>>,
  { ok: true }
>

const editProperties = {
  path: {
    type: "string",
    description: "Workspace-relative or absolute path of the text file.",
  },
  oldString: {
    type: "string",
    description:
      "Unique existing text to replace, or an empty string to create a new file without overwriting.",
  },
  newString: {
    type: "string",
    description:
      "Replacement text, which must differ from oldString when editing.",
  },
  replaceAll: {
    type: "boolean",
    description: "Replace every match. Defaults to false.",
  },
} satisfies JsonObject
const requiredEditFields = ["path", "oldString", "newString"]

export function createEditFileTool(
  maxBytes = ToolLimitDefaults.fileWriteBytes,
): RuntimeTool {
  return {
    toolName: plainToolName("edit_file"),
    description:
      "Replace matching UTF-8 text or create a new file with an empty oldString. For one change, pass path, oldString, and newString directly. For multiple changes, pass an edits array with those fields on each entry. Entries are checked before writing any file and run in order, including edits to the same file. Read the relevant text when possible. Omit read_file’s display prefixes. Use a unique anchor of a few lines, or set replaceAll for an intentional global replacement. Line-ending differences are allowed. Other normalization requires a complete current observation. A stale revision permits only a unique exact or line-ending-equivalent anchor.",
    approvalRequirement(input) {
      const parsed = parseEdits(input, maxBytes)
      return {
        ...fileChangeApprovalRequirement(input),
        ...(parsed.ok
          ? {
              subject: [...new Set(parsed.edits.map((edit) => edit.path))].join(
                ", ",
              ),
            }
          : {}),
      }
    },
    effect: "mutate",
    describeExecution(input) {
      const parsed = parseEdits(input, maxBytes)
      return {
        type: "file_change",
        changes: [],
        request: {
          operation: "edit",
          paths: parsed.ok
            ? [...new Set(parsed.edits.map((edit) => edit.path))]
            : [],
        },
      }
    },
    completeExecution: completeFileChangeExecution,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...editProperties,
        edits: {
          type: "array",
          description:
            "Ordered changes across one or more files. Use only this field for a batch.",
          minItems: 1,
          maxItems: MAX_BATCH_EDITS,
          items: {
            type: "object",
            additionalProperties: false,
            properties: editProperties,
            required: requiredEditFields,
          },
        },
      },
    },
    async execute(input, context) {
      const parsed = parseEdits(input, maxBytes)
      if (!parsed.ok) return parsed.result
      const selected = await resolveEditTargets(
        parsed.edits,
        context.workspaceRoot,
      )
      if (!selected.ok) return selected
      const writePaths = selected.entries.flatMap(({ target }) => [
        target.absolutePath,
        ...target.missingParents,
      ])
      return withTextFileWriteLocks(writePaths, async (locked) => {
        context.signal?.throwIfAborted()
        const current = await resolveEditTargets(
          parsed.edits,
          context.workspaceRoot,
        )
        if (!current.ok) return current
        for (const [index, { target }] of current.entries.entries()) {
          const planned = selected.entries[index]?.target
          if (
            planned === undefined ||
            !(await isSameWriteTarget(
              context.workspaceRoot,
              planned.absolutePath,
              target.absolutePath,
              !planned.exists,
            ))
          ) {
            return editFailure(
              "path_changed",
              `The target ${target.requestedDisplayPath} changed before preflight.`,
            )
          }
        }
        const conflict = await conflictingFileTargets(
          current.entries.map(({ target }) => target),
        )
        if (conflict !== undefined) {
          return editFailure(
            "conflicting_edit_paths",
            conflict.kind === "parent"
              ? `An edit target cannot also be a parent directory: ${conflict.path}`
              : `Multiple edit targets resolve to the same filename: ${conflict.path}`,
          )
        }
        const plans = new Map<string, EditPlan>()
        for (const { target, edit } of current.entries) {
          const observations = context.visibleFileObservations
          if (
            observations?.targetChanged(
              target.displayPath,
              target.requestedDisplayPath,
            )
          ) {
            return editFailure(
              "path_changed",
              `The target of ${edit.path} changed since it was observed. Read it again before editing.`,
            )
          }
          if (
            edit.replaceAll &&
            observations?.requiresRefresh(target.displayPath)
          ) {
            return editFailure(
              "file_revision_unknown",
              `Read ${target.displayPath} before replacing all matches after the incomplete change.`,
            )
          }
          let plan = plans.get(target.absolutePath)
          if (edit.oldString === "") {
            if (target.exists || plan !== undefined)
              return fileExistsFailure(target.displayPath)
            plans.set(target.absolutePath, {
              target,
              requestedPath: edit.path,
              content: edit.newString,
              expectedSha256: null,
              edits: [],
              aliases: new Set([target.requestedDisplayPath]),
            })
            continue
          }
          if (plan === undefined) {
            const snapshot = await readTextFileSnapshot(
              target.absolutePath,
              target.displayPath,
              maxBytes,
            )
            if (!snapshot.ok) return snapshot
            plan = {
              target,
              requestedPath: edit.path,
              content: snapshot.content,
              expectedSha256: snapshot.sha256,
              edits: [],
              aliases: new Set([target.requestedDisplayPath]),
            }
            plans.set(target.absolutePath, plan)
          }
          plan.aliases.add(target.requestedDisplayPath)
          const observed = observations?.latest(target.displayPath)
          const result = prepareEdit(
            plan.content,
            edit,
            target.displayPath,
            plan.expectedSha256,
            observed,
            maxBytes,
          )
          if (!result.ok) return result
          plan.content = result.content
          plan.edits.push(result.details)
        }

        context.signal?.throwIfAborted()
        const results: {
          output: TextFileWriteOutput
          grant: JsonObject
          edits: JsonObject[]
          content: string
        }[] = []
        const batchOutput = () => ({
          changes: results
            .filter(({ output }) => output.sha256 !== output.previousSha256)
            .map(({ output, edits }) => ({
              path: output.path,
              kind: output.created ? "add" : "update",
              diff: output.diff,
              edits,
            })),
          fileObservations: results.map(({ grant }) => grant),
        })
        const failureWithProgress = (failure: ToolFailure, path: string) => {
          if (!parsed.batch) return failure
          const atPath = fileCommitFailureAtPath(failure, path)
          if (results.length === 0) return atPath
          return {
            ...atPath,
            output: {
              ...(isRecord(atPath.output) ? atPath.output : {}),
              ...batchOutput(),
            },
            content: [
              atPath.content,
              "Processed before failure:",
              ...results.map((result) => result.content),
            ].join("\n"),
          }
        }
        for (const plan of plans.values()) {
          if (context.signal?.aborted && results.length > 0) {
            return failureWithProgress(
              editFailure(
                "batch_cancelled",
                "The edit batch stopped before writing the next file.",
              ),
              plan.target.displayPath,
            )
          }
          const written = await locked.write(plan.target.absolutePath, {
            workspaceRoot: context.workspaceRoot,
            path: plan.requestedPath,
            content: plan.content,
            expectedSha256: plan.expectedSha256,
            maxBytes,
            createParentDirectories: plan.expectedSha256 === null,
          })
          if (!written.ok) {
            const failure =
              written.code === "file_exists" && plan.expectedSha256 === null
                ? fileExistsFailure(plan.target.displayPath)
                : written.code === "stale_sha256"
                  ? staleEditFailure(
                      context.visibleFileObservations?.latest(
                        plan.target.displayPath,
                      )?.sha256 !== undefined,
                      "The file changed while edit_file was preparing the write.",
                    )
                  : written
            return failureWithProgress(
              {
                ...failure,
                ...(isRecord(written.output)
                  ? {
                      output: {
                        ...written.output,
                        ...(isRecord(failure.output) ? failure.output : {}),
                      },
                    }
                  : {}),
              },
              plan.target.displayPath,
            )
          }
          const optimisticRebase = plan.edits.some(
            (entry) => entry.optimisticRebase === true,
          )
          const { output } = written
          results.push({
            output,
            grant: editGrant(output, plan.aliases, {
              created: output.created,
              optimisticRebase,
            }),
            edits: plan.edits,
            content: written.content,
          })
        }

        const single = results[0]
        if (!parsed.batch && single !== undefined) {
          const details = single.edits[0]
          return {
            ok: true,
            output: {
              ...single.output,
              ...details,
              ...(single.output.created ? { action: "create" } : {}),
              fileObservation: single.grant,
            },
            content:
              details === undefined
                ? single.content
                : `Updated ${single.output.path} (replaced ${details.replacementCount} ${details.replacementCount === 1 ? "match" : "matches"}, ${details.matchMode}).`,
          }
        }
        return {
          ok: true,
          output: batchOutput(),
          content: results.map((result) => result.content).join("\n"),
        }
      })
    },
  }
}

async function resolveEditTargets(
  edits: readonly EditInput[],
  workspaceRoot: string,
): Promise<
  { ok: true; entries: { target: EditTarget; edit: EditInput }[] } | ToolFailure
> {
  const entries: { target: EditTarget; edit: EditInput }[] = []
  const newPaths = new Set<string>()
  for (const edit of edits) {
    const target = await resolveWritePath(workspaceRoot, edit.path, true)
    if (!target.ok) return editFailure(target.error.code, target.error.message)
    if (edit.oldString === "") {
      if (target.exists) return fileExistsFailure(target.displayPath)
      newPaths.add(target.absolutePath)
    } else if (!target.exists && !newPaths.has(target.absolutePath)) {
      const read = await resolveReadPath(workspaceRoot, edit.path)
      if (read.ok)
        return editFailure(
          "path_changed",
          `The target ${edit.path} changed before preflight.`,
        )
      return editFailure(read.error.code, read.error.message, {
        suggestion: "Read an existing workspace text file before editing it.",
      })
    }
    entries.push({ target, edit })
  }
  return { ok: true, entries }
}

type EditPlan = {
  target: EditTarget
  requestedPath: string
  content: string
  expectedSha256: string | null
  edits: JsonObject[]
  aliases: Set<string>
}

function parseEdits(
  input: unknown,
  maxBytes: number,
):
  | { ok: true; batch: boolean; edits: EditInput[] }
  | { ok: false; result: ToolFailure } {
  const batch = isRecord(input) && Object.hasOwn(input, "edits")
  let entries: unknown[] = [input]
  if (batch) {
    if (
      Object.keys(input).length !== 1 ||
      !Array.isArray(input.edits) ||
      input.edits.length === 0 ||
      input.edits.length > MAX_BATCH_EDITS
    ) {
      return editInputFailure(
        `Use either a single edit or an edits array of 1 to ${MAX_BATCH_EDITS} edits.`,
      )
    }
    entries = input.edits
  }
  const edits: EditInput[] = []
  for (const entry of entries) {
    const parsed = parseEditInput(entry, maxBytes)
    if (!parsed.ok) return parsed
    edits.push(parsed.edit)
  }
  return { ok: true, batch, edits }
}

function editGrant(
  output: TextFileWriteOutput,
  requestedPaths: ReadonlySet<string>,
  flags: Readonly<{ created?: boolean; optimisticRebase?: boolean }>,
): JsonObject {
  const aliases = [...requestedPaths].filter((path) => path !== output.path)
  return {
    path: output.path,
    ...(aliases.length === 0 ? {} : { aliases }),
    kind: "edit",
    complete: flags.created === true,
    sha256: output.sha256,
    ...(flags.created === true ? { created: true } : {}),
    ...(flags.optimisticRebase === true ? { optimisticRebase: true } : {}),
  }
}

function parseEditInput(
  input: unknown,
  maxBytes: number,
): { ok: true; edit: EditInput } | { ok: false; result: ToolFailure } {
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
  if (input.oldString.includes("\0") || input.newString.includes("\0")) {
    return editInputFailure("edit_file strings cannot contain NUL bytes.")
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
    edit: {
      path: input.path,
      oldString: input.oldString,
      newString: input.newString,
      replaceAll: input.replaceAll ?? false,
    },
  }
}

function editInputFailure(
  message: string,
  code = "invalid_tool_input",
): { readonly ok: false; readonly result: ToolFailure } {
  return { ok: false, result: editFailure(code, message) }
}

function fileExistsFailure(path: string): ToolFailure {
  return editFailure(
    "file_exists",
    `Cannot create ${path} because the file already exists.`,
    {
      suggestion: "Use a non-empty oldString to edit the existing file.",
    },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
