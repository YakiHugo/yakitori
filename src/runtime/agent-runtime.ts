import type { AgentGraphStore } from "../core/agent-graph-store.ts"
import { ThreadSpawnEdgeStatus } from "../core/agent-graph-store.ts"
import type { AgentStatus } from "../core/session-io.ts"
import type { StoredThread, ThreadMetadata } from "../core/rollout.ts"
import type { AgentThread } from "../core/agent-thread.ts"
import { agentStatusFromStoredThread } from "../core/session.ts"
import type { ThreadManager } from "../core/thread-manager.ts"
import type { ModelSelection } from "../kernel/events.ts"
import { createSessionId } from "../kernel/ids.ts"
import {
  type AgentControl,
  type AgentControlAdapter,
  type AgentRegistration,
  createAgentControl,
  type AgentType,
  type ForkTurns,
} from "./agent-control.ts"

export type AgentRuntime = Readonly<{
  registerThread(stored: StoredThread): AgentControl
  discardThread(threadId: string): Promise<void>
  close(): Promise<void>
}>

export function createAgentRuntime(input: {
  readonly graphStore: AgentGraphStore
  readonly getThreadManager: () => ThreadManager
  readonly maxDepth?: number
  readonly maxConcurrentAgents?: number
}): AgentRuntime {
  const controls = new Map<string, AgentControl>()
  const threadRoots = new Map<string, string>()
  const provisionalThreads = new Set<string>()
  const pendingDeletions = new Map<
    string,
    { readonly rootThreadId: string; readonly path: string }
  >()

  const adapter: AgentControlAdapter = {
    async createChild(request) {
      const manager = input.getThreadManager()
      const parent = await requireThread(manager, request.parentSessionId)
      const parentMetadata = parent.snapshot().metadata
      const childId = createSessionId()
      provisionalThreads.add(childId)
      try {
        const thread = await manager.createThread({
          threadId: childId,
          conversationId: request.rootSessionId,
          parentThreadId: request.parentSessionId,
          title: request.taskName,
          ...(parentMetadata.workingDirectory === undefined
            ? {}
            : { workingDirectory: parentMetadata.workingDirectory }),
          ...(parentMetadata.mateId === undefined
            ? {}
            : { mateId: parentMetadata.mateId }),
          ...(parentMetadata.mateRevisionId === undefined
            ? {}
            : { mateRevisionId: parentMetadata.mateRevisionId }),
          metadata: {
            agent: {
              version: 1,
              kind: "subagent",
              rootThreadId: request.rootSessionId,
              parentThreadId: request.parentSessionId,
              taskName: request.taskName,
              path: request.path,
              agentType: request.agentType,
              depth: request.depth,
            },
          },
          ...(request.forkedContext === undefined
            ? {}
            : {
                initialContext: {
                  sourceThreadId: request.forkedContext.sourceSessionId,
                  messages: request.forkedContext.messages,
                  ...(request.forkedContext.worldState === undefined
                    ? {}
                    : {
                        worldStateBaseline: request.forkedContext.worldState,
                      }),
                },
              }),
        })
        await input.graphStore.upsertThreadSpawnEdge({
          parentThreadId: request.parentSessionId,
          childThreadId: thread.id,
          status: ThreadSpawnEdgeStatus.Open,
        })
        return thread.id
      } catch (error) {
        threadRoots.delete(childId)
        await manager.discardThread(childId)
        throw error
      } finally {
        provisionalThreads.delete(childId)
      }
    },

    async runChild(request) {
      const thread = await requireThread(
        input.getThreadManager(),
        request.sessionId,
      )
      const submission = await thread.startIfIdle({
        content: { kind: "text", text: request.message },
        modelSelection: toModelSelection(request.target),
      })
      if (submission.type !== "started" && submission.type !== "replayed") {
        const reason =
          submission.type === "not_submitted"
            ? submission.reason
            : "unexpected_steering"
        throw new Error(
          `Agent ${request.sessionId} could not start its queued task: ${reason}.`,
        )
      }
      return outcomeFromStatus(await waitForFinalStatus(thread))
    },

    async ensureLoaded(sessionId) {
      await requireThread(input.getThreadManager(), sessionId)
    },

    async getStatus(sessionId) {
      const manager = input.getThreadManager()
      const live = manager.getThread(sessionId)
      if (live !== undefined) return live.agentStatus
      const stored = await manager.readStoredThread(sessionId)
      return stored === undefined
        ? "not_found"
        : agentStatusFromStoredThread(stored)
    },

    async failChild(sessionId, message) {
      const thread = await requireThread(input.getThreadManager(), sessionId)
      return thread.failAgent(message)
    },

    async completionDeliveryId(sessionId) {
      const stored = await input.getThreadManager().readStoredThread(sessionId)
      if (stored === undefined) {
        throw new Error(`Agent Thread ${sessionId} was not found.`)
      }
      return terminalDeliveryId(stored)
    },

    async interruptChild(sessionId) {
      const thread = input.getThreadManager().getThread(sessionId)
      await thread?.interrupt("interrupted by parent agent")
    },

    async deliverMessage(request) {
      const thread = await requireThread(
        input.getThreadManager(),
        request.sessionId,
      )
      await thread.deliverAgentMessage(request.messageId, request.text)
    },

    async rollbackChild(sessionId) {
      const manager = input.getThreadManager()
      const rootThreadId = threadRoots.get(sessionId)
      controls.get(rootThreadId ?? "")?.unregisterAgent(sessionId)
      await manager.discardThread(sessionId)
      await input.graphStore.deleteThreadEdges(sessionId)
      threadRoots.delete(sessionId)
    },

    captureForkContext(request) {
      return captureForkContext(
        input.getThreadManager().getThread(request.parentSessionId),
        request.parentSessionId,
        request.forkTurns,
      )
    },
  }

  function controlForRoot(rootThreadId: string): AgentControl {
    const existing = controls.get(rootThreadId)
    if (existing !== undefined) return existing
    const created = createAgentControl({
      rootSessionId: rootThreadId,
      adapter,
      restoreAgents: async () => {
        const manager = input.getThreadManager()
        const descendantIds = await input.graphStore.listThreadSpawnDescendants(
          rootThreadId,
          ThreadSpawnEdgeStatus.Open,
        )
        const registrations: AgentRegistration[] = []
        const reconciled = new Set<string>()
        for (const threadId of descendantIds) {
          if (reconciled.has(threadId)) continue
          const stored = await manager.readStoredThread(threadId)
          if (stored === undefined) {
            const removed = await discardStoredSubtree(threadId)
            removed.forEach((removedThreadId) => {
              reconciled.add(removedThreadId)
            })
            continue
          }
          const registration = readAgentRegistration(stored.metadata)
          if (
            registration === undefined ||
            registration.rootSessionId !== rootThreadId
          ) {
            throw new Error(
              `Thread ${threadId} has invalid restored agent identity.`,
            )
          }
          threadRoots.set(threadId, rootThreadId)
          const pendingCompletion = restoredCompletion(stored)
          registrations.push({
            ...registration,
            ...(pendingCompletion === undefined ? {} : { pendingCompletion }),
          })
        }
        return registrations
      },
      ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
      ...(input.maxConcurrentAgents === undefined
        ? {}
        : { maxConcurrentAgents: input.maxConcurrentAgents }),
    })
    controls.set(rootThreadId, created)
    return created
  }

  return {
    registerThread(stored) {
      const registration = readAgentRegistration(stored.metadata)
      const rootThreadId = registration?.rootSessionId ?? stored.metadata.id
      const knownRoot = threadRoots.get(stored.metadata.id)
      if (knownRoot !== undefined && knownRoot !== rootThreadId) {
        throw new Error(
          `Thread ${stored.metadata.id} has conflicting agent roots.`,
        )
      }
      threadRoots.set(stored.metadata.id, rootThreadId)
      const control = controlForRoot(rootThreadId)
      if (
        registration !== undefined &&
        !provisionalThreads.has(stored.metadata.id)
      ) {
        control.registerAgent(registration)
      }
      return control
    },

    async discardThread(threadId) {
      const manager = input.getThreadManager()
      const stored = await manager.readStoredThread(threadId)
      if (stored === undefined) {
        await discardStoredSubtree(threadId)
        return
      }
      const registration = readAgentRegistration(stored.metadata)
      const rootThreadId = registration?.rootSessionId ?? threadId
      const control = controlForRoot(rootThreadId)
      if (registration !== undefined) control.registerAgent(registration)
      pendingDeletions.set(threadId, {
        rootThreadId,
        path: registration?.path ?? "/root",
      })
      await control.closeAgent(threadId)
      const descendants =
        await input.graphStore.listThreadSpawnDescendants(threadId)
      for (const discardedThreadId of [...descendants].reverse()) {
        await manager.discardThread(discardedThreadId)
        await input.graphStore.deleteThreadEdges(discardedThreadId)
        finalizeDeletion(discardedThreadId)
        threadRoots.delete(discardedThreadId)
      }
      await manager.discardThread(threadId)
      await input.graphStore.deleteThreadEdges(threadId)
      finalizeDeletion(threadId)
      threadRoots.delete(threadId)
    },

    async close() {
      await Promise.all(
        Array.from(controls.values(), (control) => control.close()),
      )
      controls.clear()
      threadRoots.clear()
    },
  }

  async function discardStoredSubtree(threadId: string): Promise<string[]> {
    const manager = input.getThreadManager()
    const descendants =
      await input.graphStore.listThreadSpawnDescendants(threadId)
    const removed = [...descendants].reverse()
    removed.push(threadId)
    for (const removedThreadId of removed) {
      await manager.discardThread(removedThreadId)
      await input.graphStore.deleteThreadEdges(removedThreadId)
      finalizeDeletion(removedThreadId)
      threadRoots.delete(removedThreadId)
    }
    return removed
  }

  function finalizeDeletion(threadId: string): void {
    const pending = pendingDeletions.get(threadId)
    if (pending === undefined) return
    if (threadId === pending.rootThreadId) {
      controls.delete(pending.rootThreadId)
    } else {
      controls.get(pending.rootThreadId)?.releaseClosedPath(pending.path)
    }
    pendingDeletions.delete(threadId)
  }
}

async function requireThread(
  manager: ThreadManager,
  threadId: string,
): Promise<AgentThread> {
  const thread =
    manager.getThread(threadId) ?? (await manager.resumeThread(threadId))
  if (thread === undefined)
    throw new Error(`Agent Thread ${threadId} was not found.`)
  return thread
}

function captureForkContext(
  thread: AgentThread | undefined,
  sourceSessionId: string,
  forkTurns: ForkTurns,
) {
  if (thread === undefined || forkTurns === "none") return undefined
  const snapshot = thread.snapshot().context
  const messages = snapshot.history.map((entry) => entry.item)
  if (forkTurns === "all") {
    return {
      sourceSessionId,
      messages,
      ...(snapshot.worldStateBaseline === undefined
        ? {}
        : { worldState: snapshot.worldStateBaseline }),
    }
  }
  const starts = snapshot.history.flatMap((entry, index) =>
    entry.item.role === "user" && entry.item.context === undefined
      ? [index]
      : [],
  )
  const start = starts.at(-forkTurns) ?? starts[0]
  return {
    sourceSessionId,
    messages: start === undefined ? [] : messages.slice(start),
  }
}

function restoredCompletion(
  stored: StoredThread,
): AgentRegistration["pendingCompletion"] {
  const status = agentStatusFromStoredThread(stored)
  const outcome = outcomeFromTerminalStatus(status)
  if (outcome === undefined) return undefined
  const terminal = [...stored.rollout]
    .reverse()
    .find(
      (record) =>
        record.item.type === "turn_completed" ||
        record.item.type === "agent_status",
    )
  if (terminal === undefined) return undefined
  return {
    messageId: terminalDeliveryId(stored),
    outcome,
  }
}

function terminalDeliveryId(stored: StoredThread): string {
  const terminal = [...stored.rollout]
    .reverse()
    .find(
      (record) =>
        record.item.type === "turn_completed" ||
        record.item.type === "agent_status",
    )
  if (terminal === undefined) {
    throw new Error(`Agent Thread ${stored.metadata.id} has no terminal item.`)
  }
  return `agent_completion_${stored.metadata.id}_${terminal.rolloutId}_${String(terminal.seq)}`
}

function outcomeFromTerminalStatus(
  status: AgentStatus,
): import("./agent-control.ts").AgentRunOutcome | undefined {
  if (typeof status === "object") {
    return "completed" in status
      ? { type: "completed", text: status.completed ?? "" }
      : { type: "errored", error: status.errored }
  }
  return status === "interrupted" ? { type: "interrupted" } : undefined
}

function readAgentRegistration(
  metadata: ThreadMetadata,
): AgentRegistration | undefined {
  const value = metadata.metadata?.agent
  if (!isRecord(value) || value.kind !== "subagent") return undefined
  if (
    value.version !== 1 ||
    typeof value.rootThreadId !== "string" ||
    typeof value.parentThreadId !== "string" ||
    typeof value.taskName !== "string" ||
    typeof value.path !== "string" ||
    !isAgentType(value.agentType) ||
    !Number.isInteger(value.depth) ||
    (value.depth as number) <= 0 ||
    metadata.parentThreadId !== value.parentThreadId
  ) {
    throw new Error(`Thread ${metadata.id} has invalid subagent metadata.`)
  }
  return {
    agentId: metadata.id,
    rootSessionId: value.rootThreadId,
    parentSessionId: value.parentThreadId,
    taskName: value.taskName,
    path: value.path,
    agentType: value.agentType,
    depth: value.depth as number,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAgentType(value: unknown): value is AgentType {
  return value === "general" || value === "explore"
}

function toModelSelection(target: {
  readonly provider: string
  readonly model: string
  readonly effort?: string
  readonly speed?: string
}): ModelSelection {
  return {
    provider: target.provider,
    model: target.model,
    ...(target.effort === undefined ? {} : { effort: target.effort }),
    ...(target.speed === undefined ? {} : { speed: target.speed }),
  }
}

function waitForFinalStatus(thread: AgentThread): Promise<AgentStatus> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (status: AgentStatus) => {
      if (settled || !isFinalStatus(status)) return
      settled = true
      unsubscribe()
      resolve(status)
    }
    const unsubscribe = thread.subscribeAgentStatus((status) => {
      finish(status)
    })
    finish(thread.agentStatus)
  })
}

function isFinalStatus(status: AgentStatus): boolean {
  return status !== "pending_init" && status !== "running"
}

function outcomeFromStatus(status: AgentStatus) {
  if (typeof status === "object") {
    if ("completed" in status) {
      return { type: "completed" as const, text: status.completed ?? "" }
    }
    return { type: "errored" as const, error: status.errored }
  }
  if (status === "interrupted") return { type: "interrupted" as const }
  return {
    type: "errored" as const,
    error: `Agent entered terminal status ${status}.`,
  }
}
