import { createHash, randomBytes } from "node:crypto"
import { link, mkdir, open, rename, rm, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { ToolLimitDefaults } from "../limits.ts"
import {
  fileWriteLockKey,
  isSameWriteTarget,
  type ResolvedFileTarget,
  type ResolvedWriteTarget,
  resolveWritePath,
} from "./path-policy.ts"
import {
  readRegularFileSnapshot,
  regularFileReadFlags,
} from "./text-file-snapshot.ts"
import type { ToolFailure } from "./types.ts"
import {
  type BoundedUnifiedDiff,
  createBoundedUnifiedDiff,
} from "./unified-diff.ts"

export type CompareAndWriteTextFileInput = Readonly<{
  workspaceRoot: string
  path: string
  content: string
  expectedSha256: string | null
  createParentDirectories?: boolean
  maxBytes?: number
  preflightDiff?: BoundedUnifiedDiff
  // GUI writes enforce a narrower path boundary than agent file tools.
  validateTarget?: (absolutePath: string) => Promise<void>
}>

export type TextFileWriteOutput = Readonly<{
  path: string
  previousSha256: string | null
  sha256: string
  byteCount: number
  created: boolean
  diff: BoundedUnifiedDiff
}>

export type TextFileDeleteOutput = Readonly<{
  path: string
  previousSha256: string | null
  deleted: true
  diff: BoundedUnifiedDiff
}>

export function fileCommitFailureAtPath(
  failure: ToolFailure,
  path: string,
): ToolFailure {
  const output = failure.output
  const details =
    typeof output === "object" && output !== null && !Array.isArray(output)
      ? output
      : {}
  return {
    ...failure,
    message: `${path}: ${failure.message}`,
    content: `File: ${path}\n${failure.content}`,
    output: { ...details, failedPath: path },
  }
}

type TextFileResult<Output> =
  | ToolFailure
  | Readonly<{ ok: true; output: Output; content: string }>

export async function compareAndWriteTextFile(
  input: CompareAndWriteTextFileInput,
): Promise<TextFileResult<TextFileWriteOutput>> {
  return writeTextFile(input)
}

async function writeTextFile(
  input: CompareAndWriteTextFileInput,
  lockedPath?: string,
): Promise<TextFileResult<TextFileWriteOutput>> {
  const resolved = await resolveWritePath(
    input.workspaceRoot,
    input.path,
    input.createParentDirectories,
  )
  if (!resolved.ok) return pathError(resolved)
  await input.validateTarget?.(resolved.absolutePath)

  try {
    return await withWriteLock(
      input.workspaceRoot,
      resolved,
      lockedPath,
      input.expectedSha256 === null,
      async () => {
        const target = await resolveWritePath(
          input.workspaceRoot,
          input.path,
          input.createParentDirectories,
        )
        if (!target.ok) return pathError(target)
        if (
          !(await isSameWriteTarget(
            input.workspaceRoot,
            resolved.absolutePath,
            target.absolutePath,
            !resolved.exists,
          ))
        ) {
          return writeFailure(
            "path_changed",
            "File path changed before the write.",
          )
        }
        await input.validateTarget?.(target.absolutePath)

        const checked = await checkPrecondition(
          target,
          input.expectedSha256,
          input.maxBytes,
        )
        if (!checked.ok) return checked.result

        const written = Buffer.from(input.content, "utf8")
        const output = {
          path: target.displayPath,
          previousSha256: checked.currentSha256,
          sha256: sha256(written),
          byteCount: written.byteLength,
          created: !target.exists,
          diff:
            input.preflightDiff ??
            createBoundedUnifiedDiff({
              path: target.displayPath,
              before: checked.currentContent?.toString("utf8") ?? null,
              after: input.content,
              maxBytes: ToolLimitDefaults.toolDiffBytes,
            }),
        }
        if (checked.currentContent?.equals(written)) {
          return {
            ok: true,
            output,
            content: `Already up to date: ${output.path}.`,
          }
        }

        if (!target.exists && input.createParentDirectories === true) {
          await mkdir(dirname(target.absolutePath), { recursive: true })
          const pending = await resolveWritePath(
            input.workspaceRoot,
            input.path,
          )
          if (!pending.ok) return pathError(pending)
          if (pending.absolutePath !== target.absolutePath) {
            return writeFailure(
              "path_changed",
              "File path changed while creating its parent directories.",
            )
          }
          await input.validateTarget?.(pending.absolutePath)
        }

        const tempPath = join(
          dirname(target.absolutePath),
          `.yakitori-write-${randomBytes(8).toString("hex")}.tmp`,
        )
        let mode: number | undefined
        if (target.exists) {
          const handle = await open(target.absolutePath, regularFileReadFlags)
          try {
            const stat = await handle.stat()
            if (!stat.isFile())
              return writeFailure(
                "path_changed",
                "The write target is no longer a regular file.",
              )
            mode = stat.mode
          } finally {
            await handle.close()
          }
        }

        const handle = await open(tempPath, "wx", mode)
        let committed = false
        try {
          try {
            await handle.writeFile(input.content, "utf8")
            await handle.sync()
          } finally {
            await handle.close()
          }

          const latest = await resolveWritePath(input.workspaceRoot, input.path)
          if (!latest.ok) return pathError(latest)
          if (latest.absolutePath !== target.absolutePath) {
            return writeFailure(
              "path_changed",
              "File path changed while the write was being prepared.",
              { suggestion: "Resolve the path again and retry the write." },
            )
          }
          await input.validateTarget?.(latest.absolutePath)

          const rechecked = await checkPrecondition(
            latest,
            input.expectedSha256,
            input.maxBytes,
          )
          if (!rechecked.ok) return rechecked.result
          await input.validateTarget?.(latest.absolutePath)

          if (target.exists) {
            await rename(tempPath, target.absolutePath)
          } else {
            try {
              await link(tempPath, target.absolutePath)
            } catch (error) {
              if (isAlreadyExists(error)) {
                return writeFailure(
                  "file_exists",
                  "File was created concurrently; refusing to overwrite it.",
                  {
                    suggestion:
                      "Read the new file before deciding whether to edit it.",
                  },
                )
              }
              throw error
            }
          }

          committed = true
        } finally {
          if (!committed) await rm(tempPath, { force: true })
        }
        let cleanupFailed = false
        if (!target.exists) {
          try {
            await rm(tempPath, { force: true })
          } catch (error) {
            if (!(error instanceof Error && "code" in error)) throw error
            cleanupFailed = true
          }
        }
        return {
          ok: true,
          output,
          content: `${output.created ? "Created" : "Updated"} ${output.path} (${output.byteCount} bytes).${cleanupFailed ? " A temporary file could not be removed." : ""}`,
        }
      },
    )
  } catch (error) {
    if (!(error instanceof Error && "code" in error)) throw error
    return writeFailure(
      "write_failed",
      `Could not write ${resolved.displayPath} safely.`,
      { suggestion: "Inspect the file and retry with its latest revision." },
    )
  }
}

type DeleteTextFileInput = Readonly<{
  workspaceRoot: string
  path: string
  expectedSha256: string
  maxBytes: number
  preflightDiff?: BoundedUnifiedDiff
}>

async function deleteTextFile(
  input: DeleteTextFileInput,
  lockedPath: string,
): Promise<TextFileResult<TextFileDeleteOutput>> {
  const resolved = await resolveWritePath(input.workspaceRoot, input.path)
  if (!resolved.ok) return pathError(resolved)
  if (!resolved.exists) {
    return writeFailure("file_missing", "The file no longer exists.")
  }

  try {
    return await withWriteLock(
      input.workspaceRoot,
      resolved,
      lockedPath,
      false,
      async () => {
        const target = await resolveWritePath(input.workspaceRoot, input.path)
        if (!target.ok) return pathError(target)
        if (!target.exists || target.absolutePath !== resolved.absolutePath) {
          return writeFailure(
            "path_changed",
            "File path changed while the deletion was being prepared.",
          )
        }
        const checked = await checkPrecondition(
          target,
          input.expectedSha256,
          input.maxBytes,
        )
        if (!checked.ok) return checked.result
        await unlink(target.absolutePath)
        return {
          ok: true,
          output: {
            path: target.displayPath,
            previousSha256: checked.currentSha256,
            deleted: true,
            diff:
              input.preflightDiff ??
              createBoundedUnifiedDiff({
                path: target.displayPath,
                before: checked.currentContent?.toString("utf8") ?? "",
                after: null,
                maxBytes: ToolLimitDefaults.toolDiffBytes,
              }),
          },
          content: `Deleted ${target.displayPath}.`,
        }
      },
    )
  } catch (error) {
    if (!(error instanceof Error && "code" in error)) throw error
    return writeFailure(
      "delete_failed",
      `Could not delete ${resolved.displayPath} safely.`,
      { suggestion: "Inspect the path and retry from its latest revision." },
    )
  }
}

export type LockedTextFileChanges = Readonly<{
  write(
    path: string,
    input: CompareAndWriteTextFileInput,
  ): Promise<TextFileResult<TextFileWriteOutput>>
  delete(
    path: string,
    input: DeleteTextFileInput,
  ): Promise<TextFileResult<TextFileDeleteOutput>>
}>

export async function withTextFileWriteLocks<T>(
  paths: readonly string[],
  run: (changes: LockedTextFileChanges) => Promise<T>,
): Promise<T> {
  const ordered = [...new Set(paths.map(fileWriteLockKey))].sort()
  const heldPaths = new Set(ordered)
  const requireHeldPath = (path: string) => {
    if (!heldPaths.has(fileWriteLockKey(path)))
      throw new Error(`Cannot mutate an unlocked batch path: ${path}`)
    return path
  }
  const acquire = (index: number): Promise<T> => {
    const path = ordered[index]
    return path === undefined
      ? run({
          write: (path, input) => writeTextFile(input, requireHeldPath(path)),
          delete: (path, input) => deleteTextFile(input, requireHeldPath(path)),
        })
      : withPathWriteLock(path, () => acquire(index + 1))
  }
  return acquire(0)
}

async function withWriteLock<T extends TextFileResult<unknown>>(
  workspaceRoot: string,
  target: ResolvedWriteTarget,
  lockedPath: string | undefined,
  allowCreatedParentSpelling: boolean,
  run: () => Promise<T>,
): Promise<T | ToolFailure> {
  if (lockedPath === undefined) {
    return withTextFileWriteLocks(
      [target.absolutePath, ...target.missingParents],
      run,
    )
  }
  if (
    await isSameWriteTarget(
      workspaceRoot,
      lockedPath,
      target.absolutePath,
      allowCreatedParentSpelling,
    )
  )
    return run()
  return writeFailure(
    "path_changed",
    "The resolved path changed before the batch could commit.",
  )
}

const writeQueues = new Map<string, Promise<void>>()

async function withPathWriteLock<T>(
  path: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = writeQueues.get(path) ?? Promise.resolve()
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const current = previous.then(() => gate)
  writeQueues.set(path, current)
  await previous
  try {
    return await run()
  } finally {
    release()
    if (writeQueues.get(path) === current) writeQueues.delete(path)
  }
}

async function checkPrecondition(
  target: Extract<ResolvedFileTarget, { readonly ok: true }>,
  expectedSha256: string | null,
  maxBytes = ToolLimitDefaults.fileWriteBytes,
): Promise<
  | {
      readonly ok: true
      readonly currentSha256: string | null
      readonly currentContent: Buffer | null
    }
  | { readonly ok: false; readonly result: ToolFailure }
> {
  if (!target.exists) {
    if (expectedSha256 === null) {
      return { ok: true, currentSha256: null, currentContent: null }
    }
    return {
      ok: false,
      result: writeFailure(
        "file_missing",
        "The observed file no longer exists.",
        {
          suggestion:
            "Inspect the path before deciding whether to recreate it.",
        },
      ),
    }
  }

  if (expectedSha256 === null) {
    return {
      ok: false,
      result: writeFailure(
        "file_exists",
        "File was created before this new-file write could commit.",
        {
          suggestion:
            "Inspect the new file before deciding whether to replace it.",
        },
      ),
    }
  }

  const snapshot = await readRegularFileSnapshot(
    target.absolutePath,
    target.displayPath,
    maxBytes,
  )
  if (!snapshot.ok) return { ok: false, result: snapshot }
  const { bytes: currentContent, sha256: currentSha256 } = snapshot
  if (currentSha256 === expectedSha256) {
    return { ok: true, currentSha256, currentContent }
  }
  return {
    ok: false,
    result: writeFailure(
      "stale_sha256",
      "The file changed since it was observed.",
      {
        currentSha256,
        suggestion: "Read the file again before retrying the write.",
      },
    ),
  }
}

function pathError(
  target: Extract<ResolvedFileTarget, { readonly ok: false }>,
): ToolFailure {
  return writeFailure(target.error.code, target.error.message)
}

function writeFailure(
  code: string,
  message: string,
  details?: {
    readonly currentSha256?: string
    readonly suggestion?: string
  },
): ToolFailure {
  return {
    ok: false,
    code,
    message,
    content: [
      `${code}: ${message}`,
      ...(details?.suggestion === undefined
        ? []
        : [`Suggestion: ${details.suggestion}`]),
    ].join("\n"),
    ...(details === undefined ? {} : { output: details }),
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "EEXIST"
  )
}
