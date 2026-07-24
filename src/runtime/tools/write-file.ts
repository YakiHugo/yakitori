import { createHash, randomBytes } from "node:crypto"
import { link, open, readFile, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { RuntimeLimits } from "../limits.ts"
import { resolveWritePath, type ResolvedWorkspacePath } from "./path-policy.ts"
import type { RuntimeTool, ToolExecutionResult } from "./types.ts"

export function createWriteFileTool(
  maxBytes = RuntimeLimits.fileWriteBytes,
): RuntimeTool {
  return {
    name: "write_file",
    description:
      "Write a UTF-8 text file in the session workspace using compare-and-write. Existing files require expectedSha256 from read_file; new files require expectedSha256 null.",
    autoAllow: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        expectedSha256: { type: ["string", "null"] },
      },
      required: ["path", "content", "expectedSha256"],
    },
    async execute(input, context): Promise<ToolExecutionResult> {
      const parsed = parseWriteInput(input, maxBytes)
      if (!parsed.ok) return parsed.result

      const resolved = await resolveWritePath(
        context.workspaceRoot,
        parsed.path,
      )
      if (!resolved.ok) {
        return {
          ok: false,
          code: resolved.error.code,
          message: resolved.error.message,
          content: resolved.error.message,
        }
      }

      return withPathWriteLock(resolved.absolutePath, async () => {
        const target = await resolveWritePath(
          context.workspaceRoot,
          parsed.path,
        )
        if (!target.ok) return pathError(target)

        const rejected = await checkPrecondition(target, parsed.expectedSha256)
        if (rejected) return rejected

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
            await handle.writeFile(parsed.content, "utf8")
            await handle.sync()
          } finally {
            await handle.close()
          }

          const latest = await resolveWritePath(
            context.workspaceRoot,
            parsed.path,
          )
          if (!latest.ok) return pathError(latest)
          if (latest.absolutePath !== target.absolutePath) {
            return writeError(
              "path_changed",
              "File path changed while the write was being prepared.",
            )
          }
          const changed = await checkPrecondition(latest, parsed.expectedSha256)
          if (changed) return changed

          if (target.exists) {
            await rename(tempPath, target.absolutePath)
          } else {
            try {
              await link(tempPath, target.absolutePath)
            } catch (error) {
              if (isAlreadyExists(error)) {
                return writeError(
                  "file_exists",
                  "File was created concurrently; refusing to overwrite it.",
                )
              }
              throw error
            }
          }

          const written = Buffer.from(parsed.content, "utf8")
          const output = {
            path: target.relativePath,
            sha256: createHash("sha256").update(written).digest("hex"),
            byteCount: written.byteLength,
            created: !target.exists,
          }
          return {
            ok: true,
            output,
            content: JSON.stringify(output),
          }
        } finally {
          await rm(tempPath, { force: true })
        }
      })
    },
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
  target: Extract<ResolvedWorkspacePath, { readonly ok: true }>,
  expectedSha256: string | null,
): Promise<ToolExecutionResult | undefined> {
  if (!target.exists) {
    if (expectedSha256 === null) return undefined
    return writeError(
      "file_missing",
      "File does not exist; use expectedSha256 null to create it.",
    )
  }
  if (expectedSha256 === null) {
    return writeError(
      "file_exists",
      "File already exists; provide expectedSha256 to overwrite.",
    )
  }

  const currentHash = createHash("sha256")
    .update(await readFile(target.absolutePath))
    .digest("hex")
  if (currentHash === expectedSha256) return undefined
  return {
    ...writeError(
      "stale_sha256",
      "expectedSha256 does not match the current file contents.",
    ),
    output: { currentSha256: currentHash },
  }
}

function pathError(
  target: Extract<ResolvedWorkspacePath, { readonly ok: false }>,
): ToolExecutionResult {
  return writeError(target.error.code, target.error.message)
}

function writeError(code: string, message: string): ToolExecutionResult {
  return { ok: false, code, message, content: message }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "EEXIST"
  )
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
      result: {
        ok: false,
        code: "invalid_tool_input",
        message: "write_file input must be an object.",
        content: "write_file input must be an object.",
      },
    }
  }
  const record = input as Record<string, unknown>
  if (typeof record.path !== "string") {
    return {
      ok: false,
      result: {
        ok: false,
        code: "invalid_tool_input",
        message: "write_file path must be a string.",
        content: "write_file path must be a string.",
      },
    }
  }
  if (typeof record.content !== "string") {
    return {
      ok: false,
      result: {
        ok: false,
        code: "invalid_tool_input",
        message: "write_file content must be a string.",
        content: "write_file content must be a string.",
      },
    }
  }
  if (Buffer.byteLength(record.content, "utf8") > maxBytes) {
    return {
      ok: false,
      result: {
        ok: false,
        code: "content_too_large",
        message: `write_file content exceeds ${maxBytes} bytes.`,
        content: `write_file content exceeds ${maxBytes} bytes.`,
      },
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
      result: {
        ok: false,
        code: "invalid_tool_input",
        message: "write_file expectedSha256 must be a string or null.",
        content: "write_file expectedSha256 must be a string or null.",
      },
    }
  }
  return {
    ok: true,
    path: record.path,
    content: record.content,
    expectedSha256: record.expectedSha256,
  }
}
