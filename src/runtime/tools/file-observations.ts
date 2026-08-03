import { createHash } from "node:crypto"
import type { JsonValue, ToolProjection } from "../../kernel/index.ts"

export type FileObservationKind =
  | "edit"
  | "grep_snippet"
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
  hasRead(input: {
    readonly path: string
    readonly sha256: string
    readonly offset: number
    readonly limit: number
  }): boolean
  checkpoint(): string
  checkpointAfterSuccess(
    name: string,
    input: unknown,
    output: JsonValue,
  ): string
  recordSuccess(name: string, input: unknown, output: JsonValue): void
}

export function createFileObservationStore(
  tools: readonly ToolProjection[] = [],
): FileObservationStore {
  const revisions = new Map<string, FileRevision>()
  const reads = new Set<string>()
  const continuations = new Map<string, Map<number, string>>()

  const store: FileObservationStore = {
    latest(path) {
      return revisions.get(normalizePath(path))
    },
    continuationSha(path, offset) {
      return continuations.get(normalizePath(path))?.get(offset)
    },
    hasRead(input) {
      return reads.has(readKey(input))
    },
    checkpoint() {
      return checkpoint(revisions, reads, continuations)
    },
    checkpointAfterSuccess(name, input, output) {
      const projectedRevisions = new Map(revisions)
      const projectedReads = new Set(reads)
      const projectedContinuations = new Map(
        [...continuations].map(([path, offsets]) => [path, new Map(offsets)]),
      )
      applySuccessfulResult(
        projectedRevisions,
        projectedReads,
        projectedContinuations,
        name,
        input,
        output,
      )
      return checkpoint(
        projectedRevisions,
        projectedReads,
        projectedContinuations,
      )
    },
    recordSuccess(name, input, output) {
      applySuccessfulResult(
        revisions,
        reads,
        continuations,
        name,
        input,
        output,
      )
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
  reads: Set<string>,
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
    const limit = numberField(range, "requestedLimit")
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
    if (output.unchanged !== true) {
      if (output.truncated === false) {
        revisions.set(normalized, {
          sha256,
          complete: true,
          observation: "whole_file_read",
        })
      } else if (!(previous?.sha256 === sha256 && previous.complete)) {
        revisions.set(normalized, {
          sha256,
          complete: false,
          observation: "ranged_read",
        })
      }
    }
    if (offset !== undefined && limit !== undefined) {
      reads.add(readKey({ path, sha256, offset, limit }))
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
      complete: name === "write_file" || previous?.complete === true,
      observation: name === "write_file" ? "write" : "edit",
    })
    return
  }

  if (name !== "grep" || !Array.isArray(output.observations)) return
  for (const observation of output.observations) {
    if (!isRecord(observation)) continue
    const path = stringField(observation, "path")
    const sha256 = shaField(observation)
    if (path !== undefined && sha256 !== undefined) {
      const normalized = normalizePath(path)
      const previous = revisions.get(normalized)
      if (previous !== undefined && previous.sha256 !== sha256) {
        continuations.delete(normalized)
      }
      if (
        previous?.sha256 === sha256 &&
        previous.observation !== "grep_snippet"
      ) {
        continue
      }
      const observedRanges = rangesField(observation)
      const ranges =
        previous?.sha256 === sha256 && previous.observation === "grep_snippet"
          ? mergeRanges(previous.ranges, observedRanges)
          : observedRanges
      revisions.set(normalized, {
        sha256,
        complete: false,
        observation: "grep_snippet",
        ...(ranges === undefined ? {} : { ranges }),
      })
    }
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

function checkpoint(
  revisions: ReadonlyMap<string, FileRevision>,
  reads: ReadonlySet<string>,
  continuations: ReadonlyMap<string, ReadonlyMap<number, string>>,
): string {
  const state = {
    revisions: [...revisions]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, revision]) => ({ path, ...revision })),
    reads: [...reads].sort(),
    continuations: [...continuations]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, offsets]) => ({
        path,
        offsets: [...offsets].sort(([left], [right]) => left - right),
      })),
  }
  return createHash("sha256").update(JSON.stringify(state)).digest("hex")
}

function rangesField(value: Record<string, unknown>) {
  if (!Array.isArray(value.ranges)) return undefined
  const ranges = value.ranges.flatMap((range) => {
    if (!isRecord(range)) return []
    const startLine = numberField(range, "startLine")
    const endLine = numberField(range, "endLine")
    if (
      startLine === undefined ||
      endLine === undefined ||
      !Number.isInteger(startLine) ||
      !Number.isInteger(endLine) ||
      startLine < 1 ||
      endLine < startLine
    )
      return []
    return [{ startLine, endLine }]
  })
  return ranges.length === 0 ? undefined : ranges
}

function readKey(input: {
  readonly path: string
  readonly sha256: string
  readonly offset: number
  readonly limit: number
}): string {
  return `${normalizePath(input.path)}\0${input.sha256}\0${input.offset}\0${input.limit}`
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
