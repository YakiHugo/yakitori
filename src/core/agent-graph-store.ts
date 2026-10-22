export type ThreadSpawnEdge = Readonly<{
  parentThreadId: string
  childThreadId: string
}>

// Purpose-specific durable topology. Live Session state remains owned by
// ThreadManager and must not be projected into this store.
export type AgentGraphStore = Readonly<{
  upsertThreadSpawnEdge(edge: ThreadSpawnEdge): Promise<void>
  // Thread-subtree deletion removes storage deepest-first, then deletes each
  // edge. An edge to missing storage is a recoverable cleanup tombstone and
  // must be reconciled on retry/resume.
  deleteThreadEdges(threadId: string): Promise<void>
  listThreadSpawnChildren(parentThreadId: string): Promise<readonly string[]>
  // Ancestors precede descendants; peers at one depth are ordered by id.
  listThreadSpawnDescendants(rootThreadId: string): Promise<readonly string[]>
}>
