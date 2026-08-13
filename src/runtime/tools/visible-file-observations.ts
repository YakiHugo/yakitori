import type { JsonValue, ToolProjection } from "../../kernel/index.ts"

export type FileObservationKind =
  | "edit"
  | "ranged_read"
  | "whole_file_read"
  | "write"

export type FileObservationGrant = {
  readonly path: string
  readonly kind: FileObservationKind
  readonly complete: boolean
  readonly sha256?: string
  readonly ranges?: readonly {
    readonly startLine: number
    readonly endLine: number
  }[]
  readonly created?: boolean
  readonly optimisticRebase?: boolean
}

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
  apply(grant: FileObservationGrant): void
}

export function createVisibleFileObservations(
  tools: readonly ToolProjection[] = [],
): VisibleFileObservations {
  const revisions = new Map<string, VisibleFileRevision>()
  for (const tool of tools) {
    if (tool.state === "completed" && tool.output !== undefined) {
      const grant = grantFromToolOutput(tool.name, tool.output)
      if (grant !== undefined) applyGrant(revisions, grant)
    }
  }
  return {
    latest(path) {
      return revisions.get(normalizePath(path))
    },
    apply(grant) {
      applyGrant(revisions, grant)
    },
  }
}

export function grantFromToolOutput(
  name: string,
  output: JsonValue,
): FileObservationGrant | undefined {
  if (!isRecord(output)) return undefined
  if (Object.hasOwn(output, "fileObservation")) {
    return parseExplicitGrant(output.fileObservation)
  }
  return inferLegacyGrant(name, output)
}

function applyGrant(
  revisions: Map<string, VisibleFileRevision>,
  grant: FileObservationGrant,
): void {
  const path = normalizePath(grant.path)
  const previous = revisions.get(path)

  if (grant.kind === "whole_file_read") {
    if (!grant.complete || grant.sha256 === undefined) return
    revisions.set(path, {
      sha256: grant.sha256,
      complete: true,
      observation: "whole_file_read",
    })
    return
  }

  if (grant.kind === "ranged_read") {
    const observedRange = grant.ranges?.[0]
    if (observedRange === undefined) return
    if (previous?.complete === true) {
      const ranges = mergeRanges(previous.ranges, grant.ranges)
      revisions.set(path, {
        complete: true,
        observation: previous.observation,
        ...(previous.sha256 === undefined ? {} : { sha256: previous.sha256 }),
        ...(ranges === undefined ? {} : { ranges }),
      })
      return
    }
    revisions.set(path, {
      complete: false,
      observation: "ranged_read",
      ranges: mergeRanges(previous?.ranges, grant.ranges) ??
        grant.ranges ?? [observedRange],
    })
    return
  }

  if (grant.sha256 === undefined) return
  if (grant.kind === "write" || grant.created === true) {
    revisions.set(path, {
      sha256: grant.sha256,
      complete: true,
      observation: grant.kind === "write" ? "write" : "edit",
    })
    return
  }
  if (previous === undefined) return
  revisions.set(path, {
    sha256: grant.sha256,
    complete: grant.optimisticRebase !== true && previous.complete,
    observation: "edit",
  })
}

function parseExplicitGrant(value: unknown): FileObservationGrant | undefined {
  if (!isRecord(value)) return undefined
  const path = stringField(value, "path")
  const kind = value.kind
  if (
    path === undefined ||
    (kind !== "edit" &&
      kind !== "ranged_read" &&
      kind !== "whole_file_read" &&
      kind !== "write")
  ) {
    return undefined
  }
  const ranges = parseRanges(value.ranges)
  const sha256 = shaField(value)
  return {
    path,
    kind,
    complete: value.complete === true,
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(ranges === undefined ? {} : { ranges }),
    ...(value.created === true ? { created: true } : {}),
    ...(value.optimisticRebase === true ? { optimisticRebase: true } : {}),
  }
}

function inferLegacyGrant(
  name: string,
  output: Record<string, unknown>,
): FileObservationGrant | undefined {
  if (name === "read_file") {
    const path = stringField(output, "path")
    if (path === undefined) return undefined
    const sha256 = shaField(output)
    if (output.complete === true && sha256 !== undefined) {
      return {
        path,
        kind: "whole_file_read",
        complete: true,
        sha256,
      }
    }
    const range = isRecord(output.range) ? output.range : undefined
    const offset = numberField(range, "offset")
    const limit = numberField(range, "limit")
    if (offset === undefined || limit === undefined || limit < 1)
      return undefined
    return {
      path,
      kind: "ranged_read",
      complete: false,
      ranges: [{ startLine: offset, endLine: offset + limit - 1 }],
    }
  }

  if (name === "write_file" || name === "edit_file") {
    const path = stringField(output, "path")
    const sha256 = shaField(output)
    if (path === undefined || sha256 === undefined) return undefined
    return {
      path,
      kind: name === "write_file" ? "write" : "edit",
      complete: name === "write_file" || output.created === true,
      sha256,
      ...(output.created === true ? { created: true } : {}),
      ...(output.optimisticRebase === true ? { optimisticRebase: true } : {}),
    }
  }

  return undefined
}

function parseRanges(
  value: unknown,
): FileObservationGrant["ranges"] | undefined {
  if (!Array.isArray(value)) return undefined
  const ranges: { startLine: number; endLine: number }[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const startLine = numberField(entry, "startLine")
    const endLine = numberField(entry, "endLine")
    if (startLine === undefined || endLine === undefined) continue
    ranges.push({ startLine, endLine })
  }
  return ranges.length === 0 ? undefined : ranges
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
