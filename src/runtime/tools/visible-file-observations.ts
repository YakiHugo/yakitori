import type {
  FileObservation,
  JsonValue,
  ModelMessage,
} from "../../kernel/index.ts"

export type FileObservationKind = FileObservation["kind"]
export type FileObservationGrant = FileObservation

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
  targetChanged(path: string, requestedPath: string): boolean
  requiresRefresh(path: string): boolean
  apply(grant: FileObservationGrant): void
}

export function createVisibleFileObservations(): VisibleFileObservations {
  const revisions = new Map<string, VisibleFileRevision>()
  const aliases = new Map<string, string>()
  return {
    latest(path) {
      return revisions.get(normalizePath(path))
    },
    targetChanged(path, requestedPath) {
      const previous = aliases.get(normalizePath(requestedPath))
      return (
        previous !== undefined &&
        previous !== normalizePath(path) &&
        revisions.has(previous)
      )
    },
    requiresRefresh(path) {
      return revisions.get(normalizePath(path))?.observation === "invalidate"
    },
    apply(grant) {
      applyGrant(revisions, grant)
      if (grant.kind === "delete" || grant.kind === "invalidate") return
      const path = normalizePath(grant.path)
      if (!revisions.has(path)) return
      aliases.set(path, path)
      for (const alias of grant.aliases ?? [])
        aliases.set(normalizePath(alias), path)
    },
  }
}

export function createVisibleFileObservationsFromMessages(
  messages: readonly ModelMessage[],
): VisibleFileObservations {
  const observations = createVisibleFileObservations()
  for (const message of messages) {
    if (message.role === "tool" && message.fileObservations !== undefined) {
      for (const grant of message.fileObservations) observations.apply(grant)
    }
  }
  return observations
}

export function grantsFromToolOutput(
  output: JsonValue,
): readonly FileObservationGrant[] {
  if (!isRecord(output)) return []
  if (Object.hasOwn(output, "fileObservation")) {
    const grant = parseExplicitGrant(output.fileObservation)
    return grant === undefined ? [] : [grant]
  }
  if (Array.isArray(output.fileObservations)) {
    return output.fileObservations.flatMap((value) => {
      const grant = parseExplicitGrant(value)
      return grant === undefined ? [] : [grant]
    })
  }
  return []
}

function applyGrant(
  revisions: Map<string, VisibleFileRevision>,
  grant: FileObservationGrant,
): void {
  const path = normalizePath(grant.path)
  const previous = revisions.get(path)

  if (grant.kind === "delete") {
    revisions.delete(path)
    return
  }
  if (grant.kind === "invalidate") {
    revisions.set(path, { complete: false, observation: "invalidate" })
    return
  }

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
    if (
      grant.sha256 === undefined &&
      (observedRange === undefined || previous?.observation === "invalidate")
    )
      return
    // Legacy pages have no revision. Keep a known revision conservatively
    // until a read supplies a newer one.
    const sameRevision =
      grant.sha256 === undefined || grant.sha256 === previous?.sha256
    if (previous?.complete === true && sameRevision) {
      revisions.set(path, {
        ...previous,
        ...(grant.ranges === undefined
          ? {}
          : { ranges: mergeRanges(previous.ranges, grant.ranges) }),
      })
      return
    }
    const sha256 = grant.sha256 ?? previous?.sha256
    const ranges = mergeRanges(
      sameRevision ? previous?.ranges : undefined,
      grant.ranges,
    )
    revisions.set(path, {
      complete: false,
      observation: "ranged_read",
      ...(sha256 === undefined ? {} : { sha256 }),
      ...(ranges.length === 0 ? {} : { ranges }),
    })
    return
  }

  if (grant.sha256 === undefined) return
  if (
    grant.kind === "write" ||
    grant.created === true ||
    grant.complete === true
  ) {
    revisions.set(path, {
      sha256: grant.sha256,
      complete: true,
      observation: grant.kind === "write" ? "write" : "edit",
    })
    return
  }
  revisions.set(path, {
    sha256: grant.sha256,
    complete: grant.optimisticRebase !== true && previous?.complete === true,
    observation: "edit",
  })
}

function parseExplicitGrant(value: unknown): FileObservationGrant | undefined {
  if (!isRecord(value)) return undefined
  const path = stringField(value, "path")
  const kind = value.kind
  if (
    path === undefined ||
    (kind !== "delete" &&
      kind !== "invalidate" &&
      kind !== "edit" &&
      kind !== "ranged_read" &&
      kind !== "whole_file_read" &&
      kind !== "write")
  ) {
    return undefined
  }
  const ranges = parseRanges(value.ranges)
  const sha256 = shaField(value)
  const aliases = Array.isArray(value.aliases)
    ? value.aliases.filter(
        (alias): alias is string => typeof alias === "string",
      )
    : []
  return {
    path,
    kind,
    ...(aliases.length === 0 ? {} : { aliases }),
    complete: value.complete === true,
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(ranges === undefined ? {} : { ranges }),
    ...(value.created === true ? { created: true } : {}),
    ...(value.optimisticRebase === true ? { optimisticRebase: true } : {}),
  }
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
): NonNullable<VisibleFileRevision["ranges"]> {
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
  return process.platform === "win32" ? path.replaceAll("\\", "/") : path
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
