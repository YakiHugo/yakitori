import type { JsonValue, ToolProjection } from "../../kernel/index.ts"

export type FileObservationKind =
  | "edit"
  | "ranged_read"
  | "whole_file_read"
  | "write"

export type FileRevision = {
  readonly sha256: string
  readonly complete: boolean
  readonly observation: FileObservationKind
  readonly ranges?: readonly {
    readonly startLine: number
    readonly endLine: number
  }[]
}

export type FileObservationStore = {
  latest(path: string): FileRevision | undefined
  continuationSha(path: string, offset: number): string | undefined
  recordSuccess(name: string, input: unknown, output: JsonValue): void
}

export function createFileObservationStore(
  tools: readonly ToolProjection[] = [],
): FileObservationStore {
  const revisions = new Map<string, FileRevision>()
  const continuations = new Map<string, Map<number, string>>()

  const store: FileObservationStore = {
    latest(path) {
      return revisions.get(normalizePath(path))
    },
    continuationSha(path, offset) {
      return continuations.get(normalizePath(path))?.get(offset)
    },
    recordSuccess(name, input, output) {
      applySuccessfulResult(revisions, continuations, name, input, output)
    },
  }

  for (const tool of tools) {
    if (tool.state === "completed" && tool.output !== undefined) {
      store.recordSuccess(tool.name, tool.input, tool.output)
    }
  }
  return store
}

function applySuccessfulResult(
  revisions: Map<string, FileRevision>,
  continuations: Map<string, Map<number, string>>,
  name: string,
  _input: unknown,
  output: JsonValue,
): void {
  if (!isRecord(output)) return

  if (name === "read_file") {
    const path = stringField(output, "path")
    const sha256 = shaField(output)
    const range = isRecord(output.range) ? output.range : undefined
    const offset = numberField(range, "offset")
    const limit = numberField(range, "limit")
    if (path === undefined || sha256 === undefined) return
    const normalized = normalizePath(path)
    const previous = revisions.get(normalized)
    if (
      (previous !== undefined && previous.sha256 !== sha256) ||
      offset === 1
    ) {
      continuations.delete(normalized)
    } else if (offset !== undefined) {
      const offsets = continuations.get(normalized)
      offsets?.delete(offset)
      if (offsets?.size === 0) continuations.delete(normalized)
    }
    if (output.truncated === false && offset === 1) {
      revisions.set(normalized, {
        sha256,
        complete: true,
        observation: "whole_file_read",
      })
    } else if (!(previous?.sha256 === sha256 && previous.complete)) {
      const observedRanges =
        offset === undefined || limit === undefined || limit < 1
          ? undefined
          : [{ startLine: offset, endLine: offset + limit - 1 }]
      const ranges =
        previous?.sha256 === sha256
          ? mergeRanges(previous.ranges, observedRanges)
          : observedRanges
      revisions.set(normalized, {
        sha256,
        complete: false,
        observation: "ranged_read",
        ...(ranges === undefined ? {} : { ranges }),
      })
    }
    const continuation = isRecord(output.continuation)
      ? output.continuation
      : undefined
    const nextOffset = numberField(continuation, "nextOffset")
    if (nextOffset !== undefined && Number.isInteger(nextOffset)) {
      const offsets = continuations.get(normalized) ?? new Map<number, string>()
      offsets.set(nextOffset, sha256)
      continuations.set(normalized, offsets)
    }
    return
  }

  if (name === "write_file" || name === "edit_file") {
    const path = stringField(output, "path")
    const sha256 = shaField(output)
    if (path === undefined || sha256 === undefined) return
    const normalized = normalizePath(path)
    const previous = revisions.get(normalized)
    if (previous !== undefined && previous.sha256 !== sha256) {
      continuations.delete(normalized)
    }
    revisions.set(normalized, {
      sha256,
      complete:
        name === "write_file" ||
        (output.optimisticRebase !== true && previous?.complete === true),
      observation: name === "write_file" ? "write" : "edit",
    })
    return
  }
}

function mergeRanges(
  left: FileRevision["ranges"],
  right: FileRevision["ranges"],
): FileRevision["ranges"] {
  const ranges = [...(left ?? []), ...(right ?? [])].sort(
    (first, second) => first.startLine - second.startLine,
  )
  const merged: { startLine: number; endLine: number }[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous !== undefined && range.startLine <= previous.endLine + 1) {
      previous.endLine = Math.max(previous.endLine, range.endLine)
    } else {
      merged.push({ ...range })
    }
  }
  return merged.length === 0 ? undefined : merged
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/")
}

function shaField(value: Record<string, unknown>): string | undefined {
  const field = stringField(value, "sha256")
  return field !== undefined && /^[a-f0-9]{64}$/iu.test(field)
    ? field.toLowerCase()
    : undefined
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined
}

function numberField(
  value: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  return typeof value?.[key] === "number" ? value[key] : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
