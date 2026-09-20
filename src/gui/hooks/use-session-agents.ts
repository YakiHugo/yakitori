import { useEffect, useState } from "react"
import type { AgentSummary } from "../../runtime/agent-control.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { useAppStore } from "../store/app-store.ts"

const emptyAgents: readonly AgentSummary[] = []

export function useSessionAgents(
  apiBase: string,
  sessionId: string | undefined,
  enabled: boolean,
) {
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<{
    owner: string
    agents: readonly AgentSummary[]
    loading: boolean
    error?: string
  }>()
  const owner = `${apiBase}:${sessionId}`
  const collaborationCount = useAppStore((state) =>
    state.selection.sessionId === sessionId
      ? state.execution.entries.filter(
          (entry) =>
            entry.kind === "tool" &&
            entry.execution.type === "collaboration_tool_call" &&
            entry.state !== "requested",
        ).length
      : 0,
  )
  // Tool completion also refreshes the graph: a spawn can register its child
  // after the initial running-session notification has already been emitted.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and collaborationCount invalidate the server snapshot.
  useEffect(() => {
    if (!sessionId || !enabled) return
    const client = getAppRpcClient(apiBase)
    let disposed = false
    let generation = 0
    const refresh = () => {
      const request = ++generation
      setResult((previous) => ({
        owner,
        agents: previous?.owner === owner ? previous.agents : emptyAgents,
        loading: true,
      }))
      void client.request("agent/list", { sessionId }).then(
        ({ agents }) => {
          if (!disposed && request === generation)
            setResult({ owner, agents, loading: false })
        },
        (error: unknown) => {
          if (!disposed && request === generation)
            setResult((previous) => ({
              owner,
              agents: previous?.owner === owner ? previous.agents : emptyAgents,
              loading: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Could not load subagents.",
            }))
        },
      )
    }
    refresh()
    const stopActivity = client.subscribeToSessionActivity(refresh)
    const stopSidebar = client.subscribeToSidebarChanges(refresh)
    window.addEventListener("focus", refresh)
    return () => {
      disposed = true
      stopActivity()
      stopSidebar()
      window.removeEventListener("focus", refresh)
    }
  }, [apiBase, sessionId, owner, enabled, revision, collaborationCount])
  const current = result?.owner === owner ? result : undefined
  return {
    agents: current?.agents ?? emptyAgents,
    loading: current?.loading ?? (enabled && sessionId !== undefined),
    error: current?.error,
    refresh: () => setRevision((value) => value + 1),
  }
}

export function agentStatusLabel(status: AgentSummary["status"]): string {
  if (typeof status === "object")
    return "completed" in status ? "Completed" : "Failed"
  switch (status) {
    case "pending_init":
      return "Starting"
    case "running":
      return "Working"
    case "interrupted":
      return "Interrupted"
    case "shutdown":
      return "Closed"
    case "not_found":
      return "Unavailable"
  }
}
