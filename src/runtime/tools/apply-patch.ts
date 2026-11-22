import { lstat, rename } from "node:fs/promises"
import { basename, dirname, relative, resolve, sep } from "node:path"
import type {
  FileChange,
  JsonObject,
  JsonValue,
  ToolExecutionDescriptor,
} from "../../kernel/index.ts"
import { ToolLimitDefaults } from "../limits.ts"
import {
  APPLY_PATCH_GRAMMAR,
  applyChunks,
  parsePatch,
  type PatchAction,
  PatchContextError,
  PatchInputError,
  patchPaths,
} from "./apply-patch-text.ts"
import { fileChangeApprovalRequirement } from "./approval-requirements.ts"
import {
  conflictingFileTargets,
  fileWriteLockKey,
  isSameWriteTarget,
  resolveWorkspaceRoot,
  resolveWritePath,
} from "./path-policy.ts"
import {
  fileCommitFailureAtPath,
  type LockedTextFileChanges,
  type TextFileDeleteOutput,
  type TextFileWriteOutput,
  withTextFileWriteLocks,
} from "./text-file-write.ts"
import { readTextFileSnapshot } from "./text-file-snapshot.ts"
import { plainToolName } from "./tool-name.ts"
import type { RuntimeTool, ToolExecutionResult, ToolFailure } from "./types.ts"
import {
  type BoundedUnifiedDiff,
  createBoundedUnifiedDiff,
} from "./unified-diff.ts"

// Preflight retains bounded file snapshots and planned changes in memory.
const MAX_PATCH_PATHS = 32

type AppliedChange = Readonly<{
  path: string
  kind: "add" | "delete" | "update" | "move"
  diff?: PatchDiff
  sha256?: string
  created?: boolean
  unchanged?: boolean
  authored?: boolean
  aliases?: readonly string[]
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
    approvalRequirement(input) {
      const parsed = parseApplyPatchInput(input, maxBytes)
      return {
        ...fileChangeApprovalRequirement(input),
        ...(parsed.ok
          ? { subject: patchPaths(parsed.actions).join(", ") }
          : {}),
      }
    },
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
      const targets = await resolvePatchTargets(
        parsed.actions,
        context.workspaceRoot,
      )
      if (!targets.ok) return targets
      const paths = resolvedPatchPaths(targets.entries)
      const plannedCreates = new Set(
        targets.entries.flatMap(({ source, destination }) =>
          [source, destination].flatMap((target) =>
            target !== undefined && !target.exists ? [target.absolutePath] : [],
          ),
        ),
      )
      const lockPaths = targets.entries.flatMap(({ source, destination }) => [
        ...source.missingParents,
        ...(destination?.missingParents ?? []),
      ])
      return withTextFileWriteLocks(
        [...paths, ...lockPaths],
        async (locked) => {
          context.signal?.throwIfAborted()
          const current = await resolvePatchTargets(
            parsed.actions,
            context.workspaceRoot,
          )
          if (!current.ok) return current
          const resolved = resolvedPatchPaths(current.entries)
          if (resolved.length !== paths.length) {
            return patchFailure(
              "path_changed",
              "A patch path changed before preflight.",
            )
          }
          for (const [index, path] of resolved.entries()) {
            const plannedPath = paths[index]
            if (
              plannedPath === undefined ||
              !(await isSameWriteTarget(
                context.workspaceRoot,
                plannedPath,
                path,
                plannedCreates.has(plannedPath),
              ))
            ) {
              return patchFailure(
                "path_changed",
                "A patch path changed before preflight.",
              )
            }
          }
          const plans: PatchPlan[] = []
          for (const entry of current.entries) {
            const plan = await prepareAction(entry, maxBytes)
            if (!plan.ok) return plan
            plans.push(plan.plan)
          }
          context.signal?.throwIfAborted()
          const changes: AppliedChange[] = []
          for (const plan of plans) {
            if (context.signal?.aborted && changes.length > 0) {
              return failureWithChanges(
                fileCommitFailureAtPath(
                  patchFailure(
                    "batch_cancelled",
                    "The patch stopped before its next action.",
                  ),
                  plan.source.displayPath,
                ),
                changes,
              )
            }
            const result = await commitAction(
              plan,
              locked,
              context.workspaceRoot,
              maxBytes,
            )
            if (!result.ok) return failureWithChanges(result, changes)
            changes.push(...result.changes)
          }
          return {
            ok: true,
            output: patchOutput(changes),
            content: changes
              .map(
                (change) =>
                  `${change.unchanged ? "unchanged" : change.kind}: ${change.path}`,
              )
              .join("\n"),
          }
        },
      )
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
  if (patch.includes("\0"))
    return patchInputFailure("Patch text cannot contain NUL bytes.")
  if (Buffer.byteLength(patch, "utf8") > maxBytes) {
    return patchInputFailure(`apply_patch exceeds ${maxBytes} bytes.`)
  }
  try {
    const actions = parsePatch(patch)
    if (patchPaths(actions).length > MAX_PATCH_PATHS) {
      return patchInputFailure(
        `apply_patch supports at most ${MAX_PATCH_PATHS} paths per call.`,
      )
    }
    return { ok: true, actions }
  } catch (error) {
    if (!(error instanceof PatchInputError)) throw error
    return patchInputFailure(error.message)
  }
}

type PatchTarget = Extract<
  Awaited<ReturnType<typeof resolveWritePath>>,
  { ok: true }
>
type PatchEntry = {
  action: PatchAction
  source: PatchTarget
  destination?: PatchTarget
  caseRename?: { absolutePath: string; displayPath: string }
}
type PatchPlan = PatchEntry & {
  before: FileSnapshot | null
  after: string | null
  destinationBefore: FileSnapshot | null
  writeDiff?: BoundedUnifiedDiff
  deleteDiff?: BoundedUnifiedDiff
  caseMoveDiff?: BoundedUnifiedDiff
}

type FileSnapshot = Readonly<{ content: string; sha256: string }>

function resolvedPatchPaths(entries: readonly PatchEntry[]): string[] {
  return entries.flatMap(({ source, destination, caseRename }) => [
    source.absolutePath,
    ...(destination === undefined ? [] : [destination.absolutePath]),
    ...(caseRename === undefined ? [] : [caseRename.absolutePath]),
  ])
}

async function resolvePatchTargets(
  actions: readonly PatchAction[],
  workspaceRoot: string,
): Promise<{ ok: true; entries: PatchEntry[] } | ToolFailure> {
  const root = await resolveWorkspaceRoot(workspaceRoot)
  const identities = new Map<string, PatchTarget>()
  const entries: PatchEntry[] = []
  for (const action of actions) {
    const source = await resolveWritePath(workspaceRoot, action.path, true)
    if (!source.ok) return patchFailure(source.error.code, source.error.message)
    let destination: PatchTarget | undefined
    let caseRename: PatchEntry["caseRename"]
    if (action.kind === "update" && action.movePath !== undefined) {
      const target = await resolveWritePath(
        workspaceRoot,
        action.movePath,
        true,
      )
      if (!target.ok)
        return patchFailure(target.error.code, target.error.message)
      destination = target
      if (source.absolutePath === target.absolutePath) {
        const requested = resolve(root, action.movePath)
        const name = basename(requested)
        const current = basename(source.absolutePath)
        if (
          name !== current &&
          fileWriteLockKey(name) === fileWriteLockKey(current) &&
          !(await lstat(requested)).isSymbolicLink()
        ) {
          const absolutePath = resolve(dirname(source.absolutePath), name)
          const relativePath = relative(root, absolutePath)
          const inside =
            relativePath !== ".." &&
            !relativePath.startsWith(`..${sep}`) &&
            resolve(root, relativePath) === absolutePath
          caseRename = {
            absolutePath,
            displayPath: inside
              ? relativePath.split(sep).join("/")
              : absolutePath,
          }
        }
      }
    }

    for (const target of destination === undefined || caseRename !== undefined
      ? [source]
      : [source, destination]) {
      if (identities.has(target.absolutePath)) {
        return patchFailure(
          "duplicate_patch_path",
          `apply_patch cannot modify the same resolved path twice: ${target.displayPath}`,
        )
      }
      identities.set(target.absolutePath, target)
    }
    entries.push({
      action,
      source,
      ...(destination === undefined ? {} : { destination }),
      ...(caseRename === undefined ? {} : { caseRename }),
    })
  }
  const conflict = await conflictingFileTargets([...identities.values()])
  if (conflict !== undefined) {
    return patchFailure(
      "conflicting_patch_paths",
      conflict.kind === "parent"
        ? `A patch file cannot also be a parent directory: ${conflict.path}`
        : `Multiple patch targets resolve to the same filename: ${conflict.path}`,
    )
  }
  for (const { source, action } of entries) {
    if (!source.exists && action.kind !== "add") {
      return patchFailure(
        "path_not_found",
        `Path does not exist: ${action.path}.`,
      )
    }
  }
  return { ok: true, entries }
}

async function prepareAction(
  entry: PatchEntry,
  maxBytes: number,
): Promise<{ ok: true; plan: PatchPlan } | ToolFailure> {
  const { action, source, destination, caseRename } = entry
  let before: FileSnapshot | null = null
  if (source.exists) {
    const snapshot = await readTextFileSnapshot(
      source.absolutePath,
      source.displayPath,
      maxBytes,
    )
    if (!snapshot.ok) return snapshot
    before = snapshot
  }
  let after: string | null = null
  if (action.kind === "add") {
    after = action.content
  } else if (action.kind === "update" && before !== null) {
    const bom = before.content.startsWith("\uFEFF") ? "\uFEFF" : ""
    try {
      after = bom + applyChunks(before.content.slice(bom.length), action.chunks)
    } catch (error) {
      if (!(error instanceof PatchContextError)) throw error
      return patchFailure(
        "patch_context_mismatch",
        `${source.displayPath}: ${error.message}`,
      )
    }
    if (after === before.content && destination === undefined) {
      return patchFailure(
        "no_change",
        `Patch does not change ${source.displayPath}.`,
      )
    }
  }
  if (after !== null && Buffer.byteLength(after, "utf8") > maxBytes) {
    return patchFailure(
      "content_too_large",
      `Updated ${source.displayPath} would exceed ${maxBytes} bytes.`,
    )
  }
  let destinationBefore: FileSnapshot | null = null
  if (destination?.exists === true && caseRename === undefined) {
    const snapshot = await readTextFileSnapshot(
      destination.absolutePath,
      destination.displayPath,
      maxBytes,
    )
    if (!snapshot.ok) return snapshot
    destinationBefore = snapshot
  }
  const move = destination !== undefined
  const writeDiff =
    after === null
      ? undefined
      : createBoundedUnifiedDiff({
          path:
            caseRename === undefined
              ? (destination?.displayPath ?? source.displayPath)
              : source.displayPath,
          before:
            (move && caseRename === undefined ? destinationBefore : before)
              ?.content ?? null,
          after,
          maxBytes: ToolLimitDefaults.toolDiffBytes,
        })
  const caseMoveDiff =
    caseRename !== undefined && after !== null && before !== null
      ? createBoundedUnifiedDiff({
          path: caseRename.displayPath,
          before: before.content,
          after,
          maxBytes: ToolLimitDefaults.toolDiffBytes,
        })
      : undefined
  const deleteDiff =
    before !== null && (after === null || move)
      ? createBoundedUnifiedDiff({
          path: source.displayPath,
          before: before.content,
          after: null,
          maxBytes: ToolLimitDefaults.toolDiffBytes,
        })
      : undefined
  return {
    ok: true,
    plan: {
      ...entry,
      before,
      after,
      destinationBefore,
      ...(writeDiff === undefined ? {} : { writeDiff }),
      ...(deleteDiff === undefined ? {} : { deleteDiff }),
      ...(caseMoveDiff === undefined ? {} : { caseMoveDiff }),
    },
  }
}

async function commitAction(
  plan: PatchPlan,
  locked: LockedTextFileChanges,
  workspaceRoot: string,
  maxBytes: number,
): Promise<{ ok: true; changes: readonly AppliedChange[] } | ToolFailure> {
  const {
    action,
    source,
    before,
    after,
    destination,
    destinationBefore,
    caseRename,
    writeDiff,
    deleteDiff,
    caseMoveDiff,
  } = plan
  if (after === null) {
    if (before === null) throw new Error("Missing patch source snapshot")
    const result = await locked.delete(source.absolutePath, {
      workspaceRoot,
      path: action.path,
      expectedSha256: before.sha256,
      maxBytes,
      ...(deleteDiff === undefined ? {} : { preflightDiff: deleteDiff }),
    })
    return result.ok
      ? { ok: true, changes: [changeFromResult("delete", result.output)] }
      : fileCommitFailureAtPath(result, source.displayPath)
  }

  const destinationPath = action.kind === "update" ? action.movePath : undefined
  const writeTarget =
    caseRename === undefined ? (destination ?? source) : source
  const written = await locked.write(writeTarget.absolutePath, {
    workspaceRoot,
    path:
      caseRename === undefined ? (destinationPath ?? action.path) : action.path,
    content: after,
    maxBytes,
    ...(writeDiff === undefined ? {} : { preflightDiff: writeDiff }),
    expectedSha256:
      (caseRename === undefined && destination !== undefined
        ? destinationBefore
        : before
      )?.sha256 ?? null,
    createParentDirectories: action.kind === "add" || destination !== undefined,
  })
  if (!written.ok)
    return fileCommitFailureAtPath(written, writeTarget.displayPath)
  if (destination === undefined) {
    return {
      ok: true,
      changes: [
        {
          ...changeFromResult(
            written.output.created ? "add" : "update",
            written.output,
            source.requestedDisplayPath,
          ),
          ...(action.kind === "add" ? { authored: true } : {}),
        },
      ],
    }
  }
  if (before === null || destinationPath === undefined)
    throw new Error("Missing patch move source or destination")

  if (caseRename !== undefined) {
    const target = await resolveWritePath(workspaceRoot, destinationPath)
    const latest = await readTextFileSnapshot(
      source.absolutePath,
      source.displayPath,
      maxBytes,
    )
    if (
      target.ok &&
      target.absolutePath === source.absolutePath &&
      latest.ok &&
      latest.sha256 === written.output.sha256
    ) {
      try {
        if (!(await lstat(caseRename.absolutePath)).isSymbolicLink()) {
          await rename(source.absolutePath, caseRename.absolutePath)
          return {
            ok: true,
            changes: [
              {
                ...changeFromResult("move", written.output),
                path: caseRename.displayPath,
                ...(caseMoveDiff === undefined ? {} : { diff: caseMoveDiff }),
                ...(destination.requestedDisplayPath === caseRename.displayPath
                  ? {}
                  : { aliases: [destination.requestedDisplayPath] }),
              },
              {
                path: source.displayPath,
                kind: "delete",
                ...(deleteDiff === undefined ? {} : { diff: deleteDiff }),
              },
            ],
          }
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error)) throw error
      }
    }
    const message = `Could not rename ${source.displayPath} to ${destinationPath}; inspect both paths.`
    return after === before.content
      ? fileCommitFailureAtPath(
          patchFailure("move_failed", message),
          source.displayPath,
        )
      : patchFailureWithChanges(
          "partial_move",
          message,
          [changeFromResult("update", written.output)],
          [source.displayPath, caseRename.displayPath],
        )
  }

  const deleted = await locked.delete(source.absolutePath, {
    workspaceRoot,
    path: action.path,
    expectedSha256: before.sha256,
    maxBytes,
    ...(deleteDiff === undefined ? {} : { preflightDiff: deleteDiff }),
  })
  if (!deleted.ok) {
    const rollback =
      destinationBefore === null
        ? await locked.delete(destination.absolutePath, {
            workspaceRoot,
            path: destinationPath,
            expectedSha256: written.output.sha256,
            maxBytes,
          })
        : await locked.write(destination.absolutePath, {
            workspaceRoot,
            path: destinationPath,
            content: destinationBefore.content,
            expectedSha256: written.output.sha256,
            maxBytes,
          })
    return rollback.ok
      ? fileCommitFailureAtPath(deleted, source.displayPath)
      : patchFailureWithChanges(
          "partial_move",
          `Could not delete ${source.displayPath} or roll back ${destinationPath}; inspect both paths.`,
          [changeFromResult("move", written.output)],
          [source.displayPath, written.output.path],
        )
  }
  return {
    ok: true,
    changes: [
      changeFromResult(
        "move",
        written.output,
        destination.requestedDisplayPath,
      ),
      changeFromResult("delete", deleted.output),
    ],
  }
}

function patchOutput(
  changes: readonly AppliedChange[],
  uncertainPaths: readonly string[] = [],
): JsonObject {
  return {
    changes: changes.filter((change) => change.unchanged !== true),
    fileObservations: [
      ...changes.flatMap((change) => {
        if (uncertainPaths.includes(change.path)) return []
        if (change.kind === "delete") {
          return [{ path: change.path, kind: "delete", complete: true }]
        }
        return change.sha256 === undefined
          ? []
          : [
              {
                path: change.path,
                kind:
                  change.authored === true || change.kind === "add"
                    ? "write"
                    : "edit",
                complete:
                  change.authored === true ||
                  change.kind === "add" ||
                  change.created === true,
                sha256: change.sha256,
                ...(change.aliases === undefined
                  ? {}
                  : { aliases: change.aliases }),
                ...(change.created === true ? { created: true } : {}),
              },
            ]
      }),
      ...uncertainPaths.map((path) => ({
        path,
        kind: "invalidate",
        complete: false,
      })),
    ],
  }
}

function failureWithChanges(
  failure: ToolFailure,
  changes: readonly AppliedChange[],
): ToolFailure {
  if (changes.length === 0) return failure
  const details = isRecord(failure.output) ? failure.output : {}
  const ownChanges = appliedChangesFromOutput(failure.output)
  const allChanges = [
    ...changes.filter((change) => change.unchanged !== true),
    ...ownChanges,
  ]
  const deltaExact = details.deltaExact !== false
  const priorObservations = patchOutput(changes).fileObservations
  const ownObservations = Array.isArray(details.fileObservations)
    ? details.fileObservations
    : patchOutput(ownChanges).fileObservations
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
    content: `${failure.content}\nProcessed before failure:\n${changes
      .map(
        (change) =>
          `${change.unchanged ? "unchanged" : change.kind}: ${change.path}`,
      )
      .join("\n")}`,
  }
}

function patchFailureWithChanges(
  code: string,
  message: string,
  changes: readonly AppliedChange[],
  uncertainPaths: readonly string[],
): ToolFailure {
  return {
    ...patchFailure(code, message),
    output: {
      ...patchOutput(changes, uncertainPaths),
      deltaExact: false,
      failedPath: uncertainPaths[0] ?? "",
    },
  }
}

function appliedChangesFromOutput(
  output: JsonValue | undefined,
): AppliedChange[] {
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

function changeFromResult(
  kind: AppliedChange["kind"],
  output: TextFileWriteOutput | TextFileDeleteOutput,
  requestedPath?: string,
): AppliedChange {
  return {
    path: output.path,
    kind,
    ...(requestedPath === undefined || requestedPath === output.path
      ? {}
      : { aliases: [requestedPath] }),
    diff: output.diff,
    ...("sha256" in output ? { sha256: output.sha256 } : {}),
    ...("created" in output && output.created ? { created: true } : {}),
    ...(kind === "update" &&
    "sha256" in output &&
    output.previousSha256 === output.sha256
      ? { unchanged: true }
      : {}),
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

function patchInputFailure(message: string): {
  readonly ok: false
  readonly result: ToolExecutionResult
} {
  return { ok: false, result: patchFailure("invalid_tool_input", message) }
}

function patchFailure(code: string, message: string): ToolFailure {
  return { ok: false, code, message, content: `${code}: ${message}` }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
