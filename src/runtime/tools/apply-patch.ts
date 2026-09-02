import { createHash } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, resolve } from "node:path"
import type {
  FileChange,
  JsonObject,
  JsonValue,
  ToolExecutionDescriptor,
} from "../../kernel/index.ts"
import { ToolLimitDefaults } from "../limits.ts"
import { fileChangeApprovalRequirement } from "./approval-requirements.ts"
import { resolveReadPath, resolveWorkspaceRoot } from "./path-policy.ts"
import {
  compareAndDeleteTextFile,
  compareAndWriteTextFile,
} from "./text-file-write.ts"
import { plainToolName } from "./tool-name.ts"
import type { RuntimeTool, ToolExecutionResult, ToolFailure } from "./types.ts"

const APPLY_PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF`

type PatchChunk = Readonly<{
  context?: string
  lines: readonly string[]
  endOfFile: boolean
}>

type PatchAction =
  | Readonly<{ kind: "add"; path: string; content: string }>
  | Readonly<{ kind: "delete"; path: string }>
  | Readonly<{
      kind: "update"
      path: string
      movePath?: string
      chunks: readonly PatchChunk[]
    }>

type AppliedChange = Readonly<{
  path: string
  kind: "add" | "delete" | "update" | "move"
  diff?: PatchDiff
  sha256?: string
  created?: boolean
}>

type PatchDiff = Readonly<{
  format: "unified"
  text: string
  truncated: boolean
}>

export function createApplyPatchTool(
  maxBytes = ToolLimitDefaults.fileWriteBytes,
): RuntimeTool {
  return {
    toolName: plainToolName("apply_patch"),
    description:
      "Apply a Codex patch to one or more text files. This is a freeform tool on providers that support custom grammar tools; other providers pass the same patch as a {patch} string.",
    customInputFormat: {
      type: "grammar",
      syntax: "lark",
      definition: APPLY_PATCH_GRAMMAR,
    },
    customInputFallbackKey: "patch",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        patch: {
          type: "string",
          description: "Patch text from *** Begin Patch through *** End Patch.",
        },
      },
      required: ["patch"],
    },
    approvalRequirement: fileChangeApprovalRequirement,
    effect: "mutate",
    describeExecution(input) {
      const parsed = parseApplyPatchInput(input, maxBytes)
      return {
        type: "file_change",
        request: {
          operation: "apply_patch",
          paths: parsed.ok ? patchPaths(parsed.actions) : [],
        },
        changes: [],
      }
    },
    completeExecution(started, output) {
      if (started.type !== "file_change") return started
      const changes = outputChanges(output)
      if (changes.length === 0) return started
      return {
        ...started,
        changes,
        exact: !isRecord(output) || output.deltaExact !== false,
      }
    },
    async execute(input, context) {
      const parsed = parseApplyPatchInput(input, maxBytes)
      if (!parsed.ok) return parsed.result
      const pathValidation = await validateDistinctPatchPaths(
        parsed.actions,
        context.workspaceRoot,
      )
      if (!pathValidation.ok) return pathValidation
      const changes: AppliedChange[] = []
      for (const action of parsed.actions) {
        const result = await applyAction(
          action,
          context.workspaceRoot,
          maxBytes,
        )
        if (!result.ok) {
          return failureWithChanges(result, changes)
        }
        changes.push(...result.changes)
      }
      return {
        ok: true,
        output: patchOutput(changes),
        content: changes
          .map((change) => `${change.kind}: ${change.path}`)
          .join("\n"),
      }
    },
  }
}

function parseApplyPatchInput(
  input: unknown,
  maxBytes: number,
):
  | { readonly ok: true; readonly actions: readonly PatchAction[] }
  | { readonly ok: false; readonly result: ToolExecutionResult } {
  const patch =
    typeof input === "string"
      ? input
      : isRecord(input) &&
          Object.keys(input).length === 1 &&
          typeof input.patch === "string"
        ? input.patch
        : undefined
  if (patch === undefined) {
    return patchInputFailure(
      "apply_patch input must be freeform patch text or {patch: string}.",
    )
  }
  if (Buffer.byteLength(patch, "utf8") > maxBytes) {
    return patchInputFailure(`apply_patch exceeds ${maxBytes} bytes.`)
  }
  try {
    return { ok: true, actions: parsePatch(patch) }
  } catch (error) {
    return patchInputFailure(
      error instanceof Error ? error.message : "Invalid apply_patch input.",
    )
  }
}

function parsePatch(patch: string): readonly PatchAction[] {
  const normalized = patch.replace(/\r\n|\r/gu, "\n").trim()
  const lines = normalized.split("\n")
  if (lines.shift()?.trim() !== "*** Begin Patch") {
    throw new Error("apply_patch must start with *** Begin Patch.")
  }
  if (lines.pop()?.trim() !== "*** End Patch") {
    throw new Error("apply_patch must end with *** End Patch.")
  }
  const actions: PatchAction[] = []
  for (let index = 0; index < lines.length; ) {
    const header = lines[index]?.trim()
    if (header?.startsWith("*** Add File: ")) {
      const path = patchPath(header.slice("*** Add File: ".length))
      index += 1
      const content: string[] = []
      while (index < lines.length && !isHunkHeader(lines[index])) {
        const line = lines[index]
        if (line?.startsWith("+") !== true) {
          throw new Error(`Add File lines must start with + (${path}).`)
        }
        content.push(line.slice(1))
        index += 1
      }
      if (content.length === 0) {
        throw new Error(`Add File requires at least one + line (${path}).`)
      }
      actions.push({ kind: "add", path, content: `${content.join("\n")}\n` })
      continue
    }
    if (header?.startsWith("*** Delete File: ")) {
      actions.push({
        kind: "delete",
        path: patchPath(header.slice("*** Delete File: ".length)),
      })
      index += 1
      continue
    }
    if (header?.startsWith("*** Update File: ")) {
      const path = patchPath(header.slice("*** Update File: ".length))
      index += 1
      let movePath: string | undefined
      const possibleMove = lines[index]?.trim()
      if (possibleMove?.startsWith("*** Move to: ")) {
        movePath = patchPath(
          possibleMove.slice("*** Move to: ".length),
        )
        index += 1
      }
      const chunks: PatchChunk[] = []
      let context: string | undefined
      let changeLines: string[] = []
      let endOfFile = false
      const pushChunk = () => {
        if (changeLines.length === 0 && context === undefined) return
        chunks.push({
          ...(context === undefined ? {} : { context }),
          lines: changeLines,
          endOfFile,
        })
        context = undefined
        changeLines = []
        endOfFile = false
      }
      while (index < lines.length && !isHunkHeader(lines[index])) {
        const line = lines[index] as string
        const marker = line.trim()
        if (marker === "@@" || marker.startsWith("@@ ")) {
          pushChunk()
          context = marker === "@@" ? undefined : marker.slice(3)
        } else if (marker === "*** End of File") {
          endOfFile = true
        } else if (line.length === 0) {
          changeLines.push(" ")
        } else if (/^[ +-]/u.test(line)) {
          changeLines.push(line)
        } else {
          throw new Error(`Invalid Update File line (${path}): ${line}`)
        }
        index += 1
      }
      pushChunk()
      if (movePath === undefined && chunks.length === 0) {
        throw new Error(`Update File has no changes (${path}).`)
      }
      actions.push({
        kind: "update",
        path,
        chunks,
        ...(movePath === undefined ? {} : { movePath }),
      })
      continue
    }
    throw new Error(`Unknown apply_patch hunk: ${header ?? "<missing>"}`)
  }
  if (actions.length === 0) throw new Error("apply_patch has no hunks.")
  return actions
}

async function applyAction(
  action: PatchAction,
  workspaceRoot: string,
  maxBytes: number,
): Promise<
  | { readonly ok: true; readonly changes: readonly AppliedChange[] }
  | ToolFailure
> {
  if (action.kind === "add") {
    const existing = await readOptionalPatchFile(
      workspaceRoot,
      action.path,
      maxBytes,
    )
    if (!existing.ok) return existing
    const result = await compareAndWriteTextFile({
      workspaceRoot,
      path: action.path,
      content: action.content,
      expectedSha256: existing.sha256,
      createParentDirectories: true,
    })
    return result.ok
      ? { ok: true, changes: [changeFromResult("add", result.output)] }
      : result
  }

  const source = await resolveReadPath(workspaceRoot, action.path)
  if (!source.ok) return patchFailure(source.error.code, source.error.message)
  if (source.kind !== "file") {
    return patchFailure("unsupported_file_type", "Patch paths must be files.")
  }
  let bytes: Buffer
  try {
    bytes = await readFile(source.absolutePath)
  } catch {
    return patchFailure("read_failed", `Could not read ${source.displayPath}.`)
  }
  if (bytes.byteLength > maxBytes) {
    return patchFailure(
      "content_too_large",
      `${source.displayPath} exceeds ${maxBytes} bytes.`,
    )
  }
  const content = bytes.toString("utf8")
  if (
    Buffer.from(content, "utf8").compare(bytes) !== 0 ||
    content.includes("\0")
  ) {
    return patchFailure(
      "unsupported_text_encoding",
      `${source.displayPath} is not supported UTF-8 text.`,
    )
  }
  const expectedSha256 = sha256(bytes)
  if (action.kind === "delete") {
    const result = await compareAndDeleteTextFile({
      workspaceRoot,
      path: action.path,
      expectedSha256,
    })
    return result.ok
      ? { ok: true, changes: [changeFromResult("delete", result.output)] }
      : result
  }

  let updated: string
  try {
    updated = applyChunks(content, action.chunks)
  } catch (error) {
    return patchFailure(
      "patch_context_mismatch",
      error instanceof Error ? error.message : "Patch context did not match.",
    )
  }
  if (Buffer.byteLength(updated, "utf8") > maxBytes) {
    return patchFailure(
      "content_too_large",
      `Updated ${source.displayPath} would exceed ${maxBytes} bytes.`,
    )
  }
  if (updated === content && action.movePath === undefined) {
    return patchFailure(
      "no_change",
      `Patch does not change ${source.displayPath}.`,
    )
  }
  if (action.movePath === undefined) {
    const result = await compareAndWriteTextFile({
      workspaceRoot,
      path: action.path,
      content: updated,
      expectedSha256,
    })
    return result.ok
      ? { ok: true, changes: [changeFromResult("update", result.output)] }
      : result
  }
  const destinationBefore = await readOptionalPatchFile(
    workspaceRoot,
    action.movePath,
    maxBytes,
  )
  if (!destinationBefore.ok) return destinationBefore
  const written = await compareAndWriteTextFile({
    workspaceRoot,
    path: action.movePath,
    content: updated,
    expectedSha256: destinationBefore.sha256,
    createParentDirectories: true,
  })
  if (!written.ok) return written
  const deleted = await compareAndDeleteTextFile({
    workspaceRoot,
    path: action.path,
    expectedSha256,
  })
  if (!deleted.ok) {
    const destinationSha256 = outputSha256(written.output)
    if (destinationSha256 === undefined) {
      return patchFailure(
        "partial_move",
        `Wrote ${action.movePath} but could not delete ${source.displayPath}; inspect both paths.`,
      )
    }
    const rollback =
      destinationBefore.content === undefined
        ? await compareAndDeleteTextFile({
            workspaceRoot,
            path: action.movePath,
            expectedSha256: destinationSha256,
          })
        : await compareAndWriteTextFile({
            workspaceRoot,
            path: action.movePath,
            content: destinationBefore.content,
            expectedSha256: destinationSha256,
          })
    return rollback.ok
      ? deleted
      : patchFailureWithChanges(
          "partial_move",
          `Could not delete ${source.displayPath} or roll back ${action.movePath}; inspect both paths.`,
          [changeFromResult("move", written.output)],
          false,
        )
  }
  return {
    ok: true,
    changes: [
      changeFromResult("move", written.output),
      changeFromResult("delete", deleted.output),
    ],
  }
}

type SourceLine = { text: string; ending: "\r\n" | "\n" | "\r" | "" }

function applyChunks(content: string, chunks: readonly PatchChunk[]): string {
  const lines = parseSourceLines(content)
  const preferredEnding =
    lines.find((line) => line.ending !== "")?.ending ?? "\n"
  let cursor = 0
  for (const chunk of chunks) {
    if (chunk.context !== undefined) {
      const contextIndex = findSequence(
        lines,
        [chunk.context],
        cursor,
        false,
      )
      if (contextIndex < 0) {
        throw new Error(`Could not find @@ context: ${chunk.context}`)
      }
      cursor = contextIndex + 1
    }
    const oldLines = chunk.lines
      .filter((line) => line[0] !== "+")
      .map((line) => line.slice(1))
    const index =
      oldLines.length === 0
        ? lines.length
        : findSequence(lines, oldLines, cursor, chunk.endOfFile)
    if (index < 0) {
      throw new Error(
        `Could not find patch context: ${oldLines.slice(0, 3).join(" | ")}`,
      )
    }
    const replaced = lines.slice(index, index + oldLines.length)
    let oldOffset = 0
    const replacement: SourceLine[] = []
    for (const patchLine of chunk.lines) {
      const marker = patchLine[0]
      const text = patchLine.slice(1)
      if (marker === "-") {
        oldOffset += 1
        continue
      }
      if (marker === " ") {
        replacement.push(
          replaced[oldOffset] ?? { text, ending: preferredEnding },
        )
        oldOffset += 1
        continue
      }
      replacement.push({ text, ending: preferredEnding })
    }
    if (oldLines.length === 0) {
      const previous = lines.at(-1)
      if (previous !== undefined && previous.ending === "") {
        previous.ending = preferredEnding
      }
    } else if (
      index + oldLines.length === lines.length &&
      replacement.length > 0 &&
      chunk.lines.at(-1)?.startsWith("+") === true
    ) {
      const lastReplacement = replacement.at(-1)
      if (lastReplacement !== undefined) {
        lastReplacement.ending = replaced.at(-1)?.ending ?? preferredEnding
      }
    }
    lines.splice(index, oldLines.length, ...replacement)
    cursor = index + replacement.length
  }
  return lines.map((line) => `${line.text}${line.ending}`).join("")
}

function findSequence(
  lines: readonly SourceLine[],
  expected: readonly string[],
  from: number,
  endOfFile: boolean,
): number {
  for (const normalize of [identity, trimEnd, trim] as const) {
    const last = lines.length - expected.length
    for (let index = from; index <= last; index += 1) {
      if (endOfFile && index + expected.length !== lines.length) continue
      if (
        expected.every(
          (line, offset) =>
            normalize(lines[index + offset]?.text ?? "") === normalize(line),
        )
      ) {
        return index
      }
    }
  }
  return -1
}

function parseSourceLines(content: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    if (character !== "\r" && character !== "\n") continue
    const ending: SourceLine["ending"] =
      character === "\r" && content[index + 1] === "\n"
        ? "\r\n"
        : character
    lines.push({ text: content.slice(start, index), ending })
    if (ending === "\r\n") index += 1
    start = index + 1
  }
  if (start < content.length) {
    lines.push({ text: content.slice(start), ending: "" })
  }
  return lines
}

function patchPaths(actions: readonly PatchAction[]): string[] {
  return actions.flatMap((action) => [
    action.path,
    ...(action.kind === "update" && action.movePath !== undefined
      ? [action.movePath]
      : []),
  ])
}

async function validateDistinctPatchPaths(
  actions: readonly PatchAction[],
  workspaceRoot: string,
): Promise<{ readonly ok: true } | ToolFailure> {
  const root = await resolveWorkspaceRoot(workspaceRoot)
  const identities = new Set<string>()
  for (const path of patchPaths(actions)) {
    const resolved = await resolveReadPath(workspaceRoot, path)
    const identity = resolved.ok
      ? resolved.absolutePath
      : await resolveThroughNearestExistingAncestor(
          resolve(isAbsolute(path) ? path : resolve(root, path)),
        )
    if (identities.has(identity)) {
      return patchFailure(
        "duplicate_patch_path",
        `apply_patch cannot modify the same resolved path twice: ${path}`,
      )
    }
    identities.add(identity)
  }
  return { ok: true }
}

async function resolveThroughNearestExistingAncestor(
  candidate: string,
): Promise<string> {
  const suffix: string[] = []
  let ancestor = candidate
  for (;;) {
    try {
      return resolve(await realpath(ancestor), ...suffix.reverse())
    } catch {
      const parent = dirname(ancestor)
      if (parent === ancestor) return candidate
      suffix.push(basename(ancestor))
      ancestor = parent
    }
  }
}

async function readOptionalPatchFile(
  workspaceRoot: string,
  path: string,
  maxBytes: number,
): Promise<
  | {
      readonly ok: true
      readonly sha256: string | null
      readonly content?: string
    }
  | ToolFailure
> {
  const resolved = await resolveReadPath(workspaceRoot, path)
  if (!resolved.ok) {
    return resolved.error.code === "path_not_found"
      ? { ok: true, sha256: null }
      : patchFailure(resolved.error.code, resolved.error.message)
  }
  if (resolved.kind !== "file") {
    return patchFailure("unsupported_file_type", "Patch paths must be files.")
  }
  let bytes: Buffer
  try {
    bytes = await readFile(resolved.absolutePath)
  } catch {
    return patchFailure("read_failed", `Could not read ${resolved.displayPath}.`)
  }
  if (bytes.byteLength > maxBytes) {
    return patchFailure(
      "content_too_large",
      `${resolved.displayPath} exceeds ${maxBytes} bytes.`,
    )
  }
  const content = bytes.toString("utf8")
  if (Buffer.from(content, "utf8").compare(bytes) !== 0 || content.includes("\0")) {
    return patchFailure(
      "unsupported_text_encoding",
      `${resolved.displayPath} is not supported UTF-8 text.`,
    )
  }
  return { ok: true, sha256: sha256(bytes), content }
}

function patchOutput(
  changes: readonly AppliedChange[],
  exact = true,
): JsonObject {
  return {
    changes: [...changes],
    fileObservations: changes.flatMap((change) => {
      if (!exact) {
        return [{ path: change.path, kind: "invalidate", complete: true }]
      }
      if (change.kind === "delete") {
        return [{ path: change.path, kind: "delete", complete: true }]
      }
      return change.sha256 === undefined
        ? []
        : [
            {
              path: change.path,
              kind: change.kind === "add" ? "write" : "edit",
              complete: true,
              sha256: change.sha256,
              ...(change.created === true ? { created: true } : {}),
            },
          ]
    }),
  }
}

function failureWithChanges(
  failure: ToolFailure,
  changes: readonly AppliedChange[],
): ToolFailure {
  if (changes.length === 0) return failure
  const details = isRecord(failure.output) ? failure.output : {}
  const ownChanges = appliedChangesFromOutput(failure.output)
  const allChanges = [...changes, ...ownChanges]
  const deltaExact = details.deltaExact !== false
  const priorObservations = patchOutput(changes).fileObservations
  const ownObservations = Array.isArray(details.fileObservations)
    ? details.fileObservations
    : patchOutput(ownChanges, deltaExact).fileObservations
  return {
    ...failure,
    output: {
      ...details,
      changes: allChanges,
      fileObservations: [
        ...(Array.isArray(priorObservations) ? priorObservations : []),
        ...(Array.isArray(ownObservations) ? ownObservations : []),
      ],
      deltaExact,
    },
    content: `${failure.content}\nApplied before failure:\n${changes
      .map((change) => `${change.kind}: ${change.path}`)
      .join("\n")}`,
  }
}

function patchFailureWithChanges(
  code: string,
  message: string,
  changes: readonly AppliedChange[],
  deltaExact: boolean,
): ToolFailure {
  return {
    ...patchFailure(code, message),
    output: { ...patchOutput(changes, deltaExact), deltaExact },
  }
}

function appliedChangesFromOutput(output: JsonValue | undefined): AppliedChange[] {
  if (!isRecord(output) || !Array.isArray(output.changes)) return []
  return output.changes.flatMap((value) => {
    if (
      !isRecord(value) ||
      typeof value.path !== "string" ||
      (value.kind !== "add" &&
        value.kind !== "delete" &&
        value.kind !== "update" &&
        value.kind !== "move")
    ) {
      return []
    }
    const diff = patchDiff(value.diff)
    return [
      {
        path: value.path,
        kind: value.kind,
        ...(diff === undefined ? {} : { diff }),
        ...(typeof value.sha256 === "string" ? { sha256: value.sha256 } : {}),
        ...(value.created === true ? { created: true } : {}),
      },
    ]
  })
}

function patchPath(value: string): string {
  if (value.length === 0 || value.includes("\0")) {
    throw new Error("Patch paths must be non-empty and contain no NUL bytes.")
  }
  return value
}

function isHunkHeader(line: string | undefined): boolean {
  const marker = line?.trim()
  return (
    marker?.startsWith("*** Add File: ") === true ||
    marker?.startsWith("*** Delete File: ") === true ||
    marker?.startsWith("*** Update File: ") === true
  )
}

function changeFromResult(
  kind: AppliedChange["kind"],
  output: JsonValue,
): AppliedChange {
  const fields = isRecord(output) ? output : {}
  const diff = patchDiff(fields.diff)
  return {
    path: typeof fields.path === "string" ? fields.path : "",
    kind,
    ...(diff === undefined ? {} : { diff }),
    ...(typeof fields.sha256 === "string" ? { sha256: fields.sha256 } : {}),
    ...(fields.created === true ? { created: true } : {}),
  }
}

function outputChanges(
  output: JsonValue,
): Extract<
  ToolExecutionDescriptor,
  { readonly type: "file_change" }
>["changes"] {
  if (!isRecord(output) || !Array.isArray(output.changes)) return []
  const changes: FileChange[] = []
  for (const change of output.changes) {
    if (!isRecord(change) || typeof change.path !== "string") continue
    const diff = patchDiff(change.diff)
    if (change.kind === "add" || change.kind === "delete") {
      changes.push({
        path: change.path,
        kind: change.kind,
        ...(diff ? { diff } : {}),
      })
      continue
    }
    changes.push({
      path: change.path,
      kind: "update",
      ...(diff ? { diff } : {}),
    })
  }
  return changes
}

function patchDiff(value: unknown): PatchDiff | undefined {
  return isRecord(value) &&
    value.format === "unified" &&
    typeof value.text === "string" &&
    typeof value.truncated === "boolean"
    ? { format: "unified", text: value.text, truncated: value.truncated }
    : undefined
}

function outputSha256(value: JsonValue): string | undefined {
  return isRecord(value) && typeof value.sha256 === "string"
    ? value.sha256
    : undefined
}

function patchInputFailure(message: string): {
  readonly ok: false
  readonly result: ToolExecutionResult
} {
  return { ok: false, result: patchFailure("invalid_tool_input", message) }
}

function patchFailure(code: string, message: string): ToolFailure {
  return { ok: false, code, message, content: `${code}: ${message}` }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function identity(value: string): string {
  return value
}

function trimEnd(value: string): string {
  return value.trimEnd()
}

function trim(value: string): string {
  return value.trim()
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
