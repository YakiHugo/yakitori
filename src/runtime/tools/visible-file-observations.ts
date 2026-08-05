import type { JsonValue, ToolProjection } from "../../kernel/index.ts"

export type FileObservationKind =
  | "edit"
  | "ranged_read"
  | "whole_file_read"
  | "write"

export type VisibleFileRevision = {
  readonly sha256?: string
  readonly complete: boolean
  readonly observation: FileObservationKind
  readonly ranges?: readonly {
    readonly startLine: number
    readonly endLine: number
  }[]
}

export type VisibleFileObservations = {
  latest(path: string): VisibleFileRevision | undefined
}

export function createVisibleFileObservations(
  tools: readonly ToolProjection[] = [],
): VisibleFileObservations {
  const revisions = new Map<string, VisibleFileRevision>()
  for (const tool of tools) {
    if (tool.state === "completed" && tool.output !== undefined) {
      applyVisibleResult(revisions, tool.name, tool.output)
    }
  }
  return {
    latest(path) {
      return revisions.get(normalizePath(path))
    },
  }
}

function applyVisibleResult(
  revisions: Map<string, VisibleFileRevision>,
  name: string,
  output: JsonValue,
): void {
  if (!isRecord(output)) return

  if (name === "read_file") {
    const path = stringField(output, "path")
    if (path === undefined) return
    const normalized = normalizePath(path)
    const sha256 = shaField(output)
    if (output.complete === true && sha256 !== undefined) {
      revisions.set(normalized, {
        sha256,
        complete: true,
        observation: "whole_file_read",
      })
      return
    }

    const range = isRecord(output.range) ? output.range : undefined
    const offset = numberField(range, "offset")
    const limit = numberField(range, "limit")
    if (offset === undefined || limit === undefined || limit < 1) return

    // TODO(read-observation-ranges): Preserve which individual characters were
    // shortened before ranges become a hard edit-authorization boundary. For
    // now the range records only that the model saw part of each listed line.
    const previous = revisions.get(normalized)
    const observedRange = {
      startLine: offset,
      endLine: offset + limit - 1,
    }
    revisions.set(normalized, {
      complete: false,
      observation: "ranged_read",
      ranges:
        previous === undefined || previous.complete
          ? [observedRange]
          : (mergeRanges(previous.ranges, [observedRange]) ?? [observedRange]),
    })
    return
  }

  if (name === "write_file" || name === "edit_file") {
    const path = stringField(output, "path")
    const sha256 = shaField(output)
    if (path === undefined || sha256 === undefined) return
    const normalized = normalizePath(path)
    const previous = revisions.get(normalized)
    if (name === "write_file" || output.created === true) {
      revisions.set(normalized, {
        sha256,
        complete: true,
        observation: name === "write_file" ? "write" : "edit",
      })
      return
    }
    if (previous === undefined) return
    revisions.set(normalized, {
      sha256,
      complete: output.optimisticRebase !== true && previous.complete,
      observation: "edit",
    })
  }
}

function mergeRanges(
  left: VisibleFileRevision["ranges"],
  right: VisibleFileRevision["ranges"],
): VisibleFileRevision["ranges"] {
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
  return merged
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
