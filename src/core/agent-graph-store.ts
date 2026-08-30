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
  // Delete graph edges before deleting Thread storage. A crash may then leave
  // an unreferenced Thread, but never a restorable edge to a missing Thread.
  deleteThreadEdges(threadId: string): Promise<void>
  listThreadSpawnChildren(
    parentThreadId: string,
    status?: ThreadSpawnEdgeStatus,
  ): Promise<readonly string[]>
  listThreadSpawnDescendants(
    rootThreadId: string,
    status?: ThreadSpawnEdgeStatus,
  ): Promise<readonly string[]>
}>
