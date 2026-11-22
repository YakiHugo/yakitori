import type { JsonObject } from "../../kernel/index.ts"
import {
  closestEditCandidates,
  editFailure,
  editMismatchEvidence,
  matchedEditLocations,
} from "./edit-file-diagnostics.ts"
import { locateEditMatches } from "./edit-file-match.ts"
import {
  preserveCurlyQuoteStyle,
  preserveReplacementLineEndings,
} from "./text-file-format.ts"
import type { ToolFailure } from "./types.ts"
import type { VisibleFileRevision } from "./visible-file-observations.ts"

export type EditReplacement = Readonly<{
  oldString: string
  newString: string
  replaceAll: boolean
}>

export function prepareEdit(
  rawContent: string,
  edit: EditReplacement,
  path: string,
  currentSha256: string | null,
  observed: VisibleFileRevision | undefined,
  maxBytes: number,
): { ok: true; content: string; details: JsonObject } | ToolFailure {
  const observedSha256 = currentSha256 === null ? undefined : observed?.sha256
  const optimisticRebase =
    observedSha256 !== undefined && currentSha256 !== observedSha256
  if (optimisticRebase && edit.replaceAll) {
    return staleEditFailure(
      true,
      "The file changed since it was observed; replaceAll requires the observed revision.",
    )
  }
  const bom = rawContent.startsWith("\uFEFF") ? "\uFEFF" : ""
  const content = rawContent.slice(bom.length)
  const allowFormattingEquivalence =
    observed?.complete === true &&
    observedSha256 === currentSha256 &&
    !optimisticRebase
  const located = locateEditMatches(
    content,
    edit.oldString,
    allowFormattingEquivalence,
    edit.replaceAll,
  )
  if (optimisticRebase && located.matches.length !== 1) {
    return staleEditFailure(
      true,
      "The file changed since it was observed and the edit anchor no longer has a unique match.",
    )
  }
  if (located.matches.length === 0) {
    const evidence = editMismatchEvidence(
      content,
      edit.oldString,
      edit.newString,
    )
    const nearMatches = closestEditCandidates(content, edit.oldString)
    return editFailure(
      "old_string_not_found",
      `oldString was not found in ${path}.`,
      { ...evidence, ...(nearMatches.length === 0 ? {} : { nearMatches }) },
    )
  }
  if (!edit.replaceAll && located.matches.length > 1) {
    return editFailure(
      "old_string_ambiguous",
      `oldString matched ${located.matches.length} locations in ${path}.`,
      {
        matchMode: located.mode,
        matchCount: located.matches.length,
        locations: matchedEditLocations(content, located.matches),
      },
    )
  }

  const matches = located.matches
  const changedRanges = matchedEditLocations(content, matches)
  const editWithinObservedRanges =
    (observed?.complete === true && !optimisticRebase) ||
    (matches.length === changedRanges.length &&
      changedRanges.every((changed) =>
        observed?.ranges?.some(
          (range) =>
            range.startLine <= changed.startLine &&
            range.endLine >= changed.endLine,
        ),
      ))
  const needsLineEndings = /[\r\n]/u.test(edit.newString)
  const endings = /\r\n|\r|\n/g
  let nextEnding = needsLineEndings ? endings.exec(content) : null
  let previousEnding = "\n"
  const parts = [bom]
  let cursor = 0
  let outputBytes = Buffer.byteLength(bom, "utf8")
  for (const match of matches) {
    const unchanged = content.slice(cursor, match.start)
    const matched = content.slice(match.start, match.end)
    // Use the next terminator for a single-line anchor, or the preceding one at EOF.
    while (nextEnding !== null && nextEnding.index < match.end) {
      previousEnding = nextEnding[0]
      nextEnding = endings.exec(content)
    }
    const ending = nextEnding?.[0] ?? previousEnding
    const replacement = needsLineEndings
      ? preserveReplacementLineEndings(
          edit.newString,
          matched,
          ending === "\r\n" || ending === "\r" || ending === "\n"
            ? ending
            : "\n",
        )
      : edit.newString
    const styled = located.mode.startsWith("curly_quotes")
      ? preserveCurlyQuoteStyle(matched, replacement)
      : replacement
    outputBytes +=
      Buffer.byteLength(unchanged, "utf8") + Buffer.byteLength(styled, "utf8")
    if (outputBytes > maxBytes) break
    parts.push(unchanged, styled)
    cursor = match.end
  }
  const tail = content.slice(cursor)
  if (outputBytes + Buffer.byteLength(tail, "utf8") > maxBytes) {
    return editFailure(
      "content_too_large",
      `The edited file would exceed ${maxBytes} bytes.`,
    )
  }
  parts.push(tail)
  const updated = parts.join("")
  if (updated === rawContent) {
    return editFailure(
      "no_change",
      "The requested replacement does not change the file.",
    )
  }
  return {
    ok: true,
    content: updated,
    details: {
      replacementCount: matches.length,
      matchMode: located.mode,
      optimisticRebase,
      observedRevisionKnown: observedSha256 !== undefined,
      ...(observedSha256 === undefined ? {} : { observedSha256 }),
      changedRanges,
      ...(observed === undefined
        ? {}
        : {
            observation: {
              kind: observed.observation,
              complete: observed.complete,
              editWithinObservedRanges,
            },
          }),
    },
  }
}

export function staleEditFailure(
  observed: boolean,
  message: string,
): ToolFailure {
  return editFailure(
    observed ? "file_changed_since_observation" : "file_changed_during_edit",
    message,
    {
      suggestion:
        "Read the file again and rebuild the edit from its latest contents.",
    },
  )
}
