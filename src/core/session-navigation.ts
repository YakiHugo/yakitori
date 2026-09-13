import { createYakitoriError, YakitoriErrorCode } from "../kernel/errors.ts"
import { isJsonObject } from "../kernel/events.ts"
import type { ThreadMetadata } from "./rollout.ts"

export type SessionHeads = Record<string, string>

// Execution threads remain independently addressable. Only edit/undo edges
// share a navigation entry; explicit forks and agent ancestry do not.
export function sessionEntries<T extends ThreadMetadata>(
  threads: readonly T[],
  heads: Readonly<SessionHeads>,
): Array<T & Readonly<{ navigationId: string }>> {
  const byId = new Map(threads.map((thread) => [thread.id, thread]))
  const groups = new Map<string, T[]>()
  for (const thread of threads) {
    const agent = thread.metadata?.agent
    if (isJsonObject(agent) && agent.kind === "subagent") continue
    let root = thread
    let navigationId = root.id
    const visited = new Set<string>()
    while (root.forkReason !== undefined && root.parentThreadId !== undefined) {
      if (visited.has(root.id)) throw new Error("Cyclic session edit history.")
      visited.add(root.id)
      navigationId = root.parentThreadId
      const parent = byId.get(navigationId)
      if (parent === undefined) break
      root = parent
    }
    const group = groups.get(navigationId) ?? []
    group.push(thread)
    groups.set(navigationId, group)
  }
  return [...groups].flatMap(([navigationId, group]) => {
    const committed = heads[navigationId]
    // Existing histories predate explicit publication. Creation order recovers
    // their last edit without letting later writes to an old branch win.
    const head =
      committed === undefined
        ? group
            .filter(
              (candidate) =>
                !group.some(
                  (other) =>
                    other.forkReason !== undefined &&
                    other.parentThreadId === candidate.id,
                ),
            )
            .sort(
              (a, b) =>
                b.createdAt.localeCompare(a.createdAt) ||
                b.id.localeCompare(a.id),
            )[0]
        : group.find((thread) => thread.id === committed)
    return head === undefined ? [] : [{ ...head, navigationId }]
  })
}

export function advanceSessionHead(
  threads: readonly ThreadMetadata[],
  heads: Readonly<SessionHeads>,
  sourceThreadId: string,
  targetThreadId: string,
): SessionHeads {
  const source = sessionEntries(threads, heads).find(
    (thread) => thread.id === sourceThreadId,
  )
  if (source?.navigationId === undefined) {
    throw createYakitoriError({
      message: "This conversation changed. Reopen it before editing.",
      code: YakitoriErrorCode.InvalidState,
    })
  }
  if (targetThreadId !== sourceThreadId) {
    const target = threads.find((thread) => thread.id === targetThreadId)
    if (
      target?.parentThreadId !== sourceThreadId ||
      target.forkReason === undefined
    ) {
      throw new Error("Session head must be an edit of the current thread.")
    }
  }
  return { ...heads, [source.navigationId]: targetThreadId }
}
