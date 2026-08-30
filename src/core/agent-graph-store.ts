export const ThreadSpawnEdgeStatus = {
  Open: "open",
  Closed: "closed",
} as const

export type ThreadSpawnEdgeStatus =
  (typeof ThreadSpawnEdgeStatus)[keyof typeof ThreadSpawnEdgeStatus]

export type ThreadSpawnEdge = Readonly<{
  parentThreadId: string
  childThreadId: string
  status: ThreadSpawnEdgeStatus
}>

// Purpose-specific durable topology. Live Session state remains owned by
// ThreadManager and must not be projected into this store.
export type AgentGraphStore = Readonly<{
  upsertThreadSpawnEdge(edge: ThreadSpawnEdge): Promise<void>
  setThreadSpawnEdgeStatus(
    childThreadId: string,
    status: ThreadSpawnEdgeStatus,
  ): Promise<boolean>
  // Thread-subtree deletion removes storage deepest-first, then deletes each
  // edge. An edge to missing storage is a recoverable cleanup tombstone and
  // must be reconciled on retry/resume.
  deleteThreadEdges(threadId: string): Promise<void>
  listThreadSpawnChildren(
    parentThreadId: string,
    status?: ThreadSpawnEdgeStatus,
  ): Promise<readonly string[]>
  // Ancestors precede descendants; peers at one depth are ordered by id.
  listThreadSpawnDescendants(
    rootThreadId: string,
    status?: ThreadSpawnEdgeStatus,
  ): Promise<readonly string[]>
}>
