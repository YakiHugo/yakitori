import { isJsonObject } from "../kernel/events.ts"
import type { ThreadMetadata } from "./rollout.ts"

// Each user Session keeps its own stable identity, including explicit forks.
export function sessionEntries<T extends ThreadMetadata>(
  threads: readonly T[],
): T[] {
  return threads.filter((thread) => {
    const agent = thread.metadata?.agent
    return !isJsonObject(agent) || agent.kind !== "subagent"
  })
}
