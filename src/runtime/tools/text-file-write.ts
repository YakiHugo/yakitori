import { createHash, randomBytes } from "node:crypto"
import { link, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { ToolLimitDefaults } from "../limits.ts"
import {
  type ResolvedFileTarget,
  resolveWorkspaceRoot,
  resolveWritePath,
} from "./path-policy.ts"
import type { ToolExecutionResult } from "./types.ts"
import { createBoundedUnifiedDiff } from "./unified-diff.ts"

export type CompareAndWriteTextFileInput = {
  readonly workspaceRoot: string
  readonly path: string
  readonly content: string
  readonly expectedSha256: string | null
  readonly createParentDirectories?: boolean
}

export async function compareAndWriteTextFile(
  input: CompareAndWriteTextFileInput,
): Promise<ToolExecutionResult> {
  if (input.createParentDirectories === true) {
    if (input.path.length === 0 || input.path.includes("\0")) {
      return writeFailure("path_denied", "Path must be a non-empty string.")
    }
    try {
      const root = await resolveWorkspaceRoot(input.workspaceRoot)
      const candidate = resolve(
        isAbsolute(input.path) ? input.path : resolve(root, input.path),
      )
      await mkdir(dirname(candidate), { recursive: true })
    } catch {
      return writeFailure(
        "write_failed",
        "The destination parent directory could not be created.",
      )
    }
  }
  const resolved = await resolveWritePath(input.workspaceRoot, input.path)
  if (!resolved.ok) return pathError(resolved)

  try {
    return await withPathWriteLock(resolved.absolutePath, async () => {
      const target = await resolveWritePath(input.workspaceRoot, input.path)
      if (!target.ok) return pathError(target)

      const checked = await checkPrecondition(target, input.expectedSha256)
      if (!checked.ok) return checked.result

      const tempPath = join(
        dirname(target.absolutePath),
        `.yakitori-write-${randomBytes(8).toString("hex")}.tmp`,
      )
      let mode: number | undefined
      if (target.exists) {
        const handle = await open(target.absolutePath, "r")
        try {
          mode = (await handle.stat()).mode
        } finally {
          await handle.close()
        }
      }

      try {
        const handle = await open(tempPath, "wx", mode)
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

        const rechecked = await checkPrecondition(latest, input.expectedSha256)
        if (!rechecked.ok) return rechecked.result

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

        const written = Buffer.from(input.content, "utf8")
        const output = {
          path: target.displayPath,
          previousSha256: checked.currentSha256,
          sha256: sha256(written),
          byteCount: written.byteLength,
          created: !target.exists,
          diff: createBoundedUnifiedDiff({
            path: target.displayPath,
            before:
              checked.currentContent === null
                ? null
                : checked.currentContent.toString("utf8"),
            after: input.content,
            maxBytes: ToolLimitDefaults.toolDiffBytes,
          }),
        }
        return {
          ok: true,
          output,
          content: `${output.created ? "Created" : "Updated"} ${output.path} (${output.byteCount} bytes, sha256 ${output.sha256}).`,
        }
      } finally {
        await rm(tempPath, { force: true })
      }
    })
  } catch {
    return writeFailure(
      "write_failed",
      "The file could not be written safely.",
      { suggestion: "Inspect the file and retry with its latest revision." },
    )
  }
}

export async function compareAndDeleteTextFile(input: {
  readonly workspaceRoot: string
  readonly path: string
  readonly expectedSha256: string
}): Promise<ToolExecutionResult> {
  const resolved = await resolveWritePath(input.workspaceRoot, input.path)
  if (!resolved.ok) return pathError(resolved)
  if (!resolved.exists) {
    return writeFailure("file_missing", "The file no longer exists.")
  }

  try {
    return await withPathWriteLock(resolved.absolutePath, async () => {
      const target = await resolveWritePath(input.workspaceRoot, input.path)
      if (!target.ok) return pathError(target)
      if (!target.exists || target.absolutePath !== resolved.absolutePath) {
        return writeFailure(
          "path_changed",
          "File path changed while the deletion was being prepared.",
        )
      }
      const checked = await checkPrecondition(target, input.expectedSha256)
      if (!checked.ok) return checked.result
      await unlink(target.absolutePath)
      return {
        ok: true,
        output: {
          path: target.displayPath,
          previousSha256: checked.currentSha256,
          deleted: true,
          diff: createBoundedUnifiedDiff({
            path: target.displayPath,
            before: checked.currentContent?.toString("utf8") ?? "",
            after: null,
            maxBytes: ToolLimitDefaults.toolDiffBytes,
          }),
        },
        content: `Deleted ${target.displayPath}.`,
      }
    })
  } catch {
    return writeFailure(
      "delete_failed",
      "The file could not be deleted safely.",
      { suggestion: "Inspect the path and retry from its latest revision." },
    )
  }
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
): Promise<
  | {
      readonly ok: true
      readonly currentSha256: string | null
      readonly currentContent: Buffer | null
    }
  | { readonly ok: false; readonly result: ToolExecutionResult }
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
            "Read the complete file before deciding whether to replace it.",
        },
      ),
    }
  }

  const currentContent = await readFile(target.absolutePath)
  const currentSha256 = sha256(currentContent)
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
): ToolExecutionResult {
  return writeFailure(target.error.code, target.error.message)
}

function writeFailure(
  code: string,
  message: string,
  details?: {
    readonly currentSha256?: string
    readonly suggestion?: string
  },
): ToolExecutionResult {
  return {
    ok: false,
    code,
    message,
    content: [
      `${code}: ${message}`,
      ...(details?.currentSha256 === undefined
        ? []
        : [`Current sha256: ${details.currentSha256}`]),
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
