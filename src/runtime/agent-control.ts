import type { ModelMessage } from "./model.ts"
import type { ForkedModelContext } from "./model-context.ts"

export type AgentType = "general" | "explore"
export type ForkTurns = "none" | "all" | number
export type AgentModelTarget = Readonly<{
  provider: string
  model: string
  effort?: string
  speed?: string
}>

export type AgentRunOutcome =
  | { readonly type: "completed"; readonly text: string }
  | { readonly type: "errored"; readonly error: string }
  | { readonly type: "interrupted"; readonly reason?: string }

export type AgentStatus =
  | "pending_init"
  | "running"
  | "interrupted"
  | { readonly completed: string | null }
  | { readonly errored: string }

export type AgentRuntimeContext = Readonly<{
  rootSessionId: string
  path: string
  parentPath?: string
  taskName: string
  agentType: AgentType
  depth: number
  maxDepth: number
  maxConcurrentAgents: number
}>

export type AgentControlAdapter = Readonly<{
  createChild(input: {
    readonly parentSessionId: string
    readonly rootSessionId: string
    readonly taskName: string
    readonly path: string
    readonly agentType: AgentType
    readonly depth: number
    readonly message: string
    readonly target: AgentModelTarget
    readonly forkedContext?: ForkedModelContext
  }): Promise<string>
  runChild(sessionId: string): Promise<AgentRunOutcome>
  submitFollowup(input: {
    readonly sessionId: string
    readonly message: string
    readonly target: AgentModelTarget
  }): Promise<void>
  interruptChild(sessionId: string): Promise<void>
  captureForkContext(input: {
    readonly parentSessionId: string
    readonly forkTurns: ForkTurns
  }): ForkedModelContext | undefined
}>

export type BoundAgentControl = Readonly<{
  spawn(input: {
    readonly taskName: string
    readonly message: string
    readonly agentType: AgentType
    readonly forkTurns: ForkTurns
    readonly model?: string
    readonly reasoningEffort?: string
  }): Promise<{
    readonly agentId: string
    readonly taskName: string
    readonly path: string
  }>
  sendMessage(input: {
    readonly target: string
    readonly message: string
  }): Promise<{ readonly agentId: string; readonly path: string }>
  followup(input: {
    readonly target: string
    readonly message: string
  }): Promise<{ readonly agentId: string; readonly path: string }>
  wait(timeoutMs?: number): Promise<readonly AgentUpdate[]>
  interrupt(target: string): Promise<{
    readonly agentId: string
    readonly path: string
    readonly previousStatus: AgentStatus
  }>
  list(pathPrefix?: string): readonly AgentSummary[]
}>

export type AgentSummary = Readonly<{
  agentId: string
  taskName: string
  path: string
  parentPath?: string
  status: AgentStatus
}>

export type AgentUpdate = Readonly<{
  agentId: string
  path: string
  status: AgentStatus
}>

export type AgentControl = Readonly<{
  bind(sessionId: string, target: AgentModelTarget): BoundAgentControl
  runtimeContext(sessionId: string): AgentRuntimeContext
  takeMessages(sessionId: string): readonly ModelMessage[]
  close(): Promise<void>
}>

type AgentRecord = {
  readonly agentId: string
  readonly rootSessionId: string
  readonly parentSessionId?: string
  readonly taskName: string
  readonly path: string
  readonly agentType: AgentType
  readonly depth: number
  status: AgentStatus
}

const ROOT_TASK_NAME = "root"

export function createAgentControl(input: {
  readonly adapter: AgentControlAdapter
  readonly maxDepth?: number
  readonly maxConcurrentAgents?: number
}): AgentControl {
  const maxDepth = requirePositiveInteger(input.maxDepth ?? 2, "maxDepth")
  const maxConcurrentAgents = requirePositiveInteger(
    input.maxConcurrentAgents ?? 4,
    "maxConcurrentAgents",
  )
  const agents = new Map<string, AgentRecord>()
  const paths = new Map<string, string>()
  const reservedPaths = new Set<string>()
  const reservedSlots = new Map<string, number>()
  const messages = new Map<string, ModelMessage[]>()
  const updates = new Map<string, AgentUpdate[]>()
  const waiters = new Map<string, Set<() => void>>()
  const runs = new Map<string, Promise<void>>()

  function requireAgent(sessionId: string): AgentRecord {
    const existing = agents.get(sessionId)
    if (existing !== undefined) return existing
    const root: AgentRecord = {
      agentId: sessionId,
      rootSessionId: sessionId,
      taskName: ROOT_TASK_NAME,
      path: "/root",
      agentType: "general",
      depth: 0,
      status: "running",
    }
    agents.set(sessionId, root)
    paths.set(pathKey(sessionId, root.path), sessionId)
    return root
  }

  function bind(
    sessionId: string,
    target: AgentModelTarget,
  ): BoundAgentControl {
    const actor = requireAgent(sessionId)
    return {
      async spawn(request) {
        if (actor.depth >= maxDepth) {
          throw new AgentControlError(
            "agent_depth_limit_reached",
            `Agent ${actor.path} is at the maximum delegation depth of ${String(maxDepth)}. Complete the task without spawning another agent.`,
          )
        }
        const taskName = requireTaskName(request.taskName)
        const path = `${actor.path}/${taskName}`
        const key = pathKey(actor.rootSessionId, path)
        if (paths.has(key) || reservedPaths.has(key)) {
          throw new AgentControlError(
            "agent_name_conflict",
            `Agent task name ${taskName} already exists under ${actor.path}.`,
          )
        }
        const runningChildren = Array.from(agents.values()).filter(
          (candidate) =>
            candidate.rootSessionId === actor.rootSessionId &&
            isRunning(candidate.status) &&
            candidate.agentId !== actor.rootSessionId,
        ).length
        const reserved = reservedSlots.get(actor.rootSessionId) ?? 0
        if (runningChildren + reserved >= maxConcurrentAgents - 1) {
          throw new AgentControlError(
            "agent_concurrency_limit_reached",
            `Agent tree ${actor.rootSessionId} already has ${String(runningChildren)} running subagents; the configured limit is ${String(maxConcurrentAgents - 1)}.`,
          )
        }

        reservedPaths.add(key)
        reservedSlots.set(actor.rootSessionId, reserved + 1)
        try {
          const forkedContext = input.adapter.captureForkContext({
            parentSessionId: sessionId,
            forkTurns: request.forkTurns,
          })
          const childTarget: AgentModelTarget = {
            ...target,
            ...(request.model === undefined ? {} : { model: request.model }),
            ...(request.reasoningEffort === undefined
              ? {}
              : { effort: request.reasoningEffort }),
          }
          const childId = await input.adapter.createChild({
            parentSessionId: sessionId,
            rootSessionId: actor.rootSessionId,
            taskName,
            path,
            agentType: request.agentType,
            depth: actor.depth + 1,
            message: request.message,
            target: childTarget,
            ...(forkedContext === undefined ? {} : { forkedContext }),
          })
          const child: AgentRecord = {
            agentId: childId,
            rootSessionId: actor.rootSessionId,
            parentSessionId: sessionId,
            taskName,
            path,
            agentType: request.agentType,
            depth: actor.depth + 1,
            status: "pending_init",
          }
          agents.set(childId, child)
          paths.set(key, childId)
          start(child, input.adapter.runChild(childId))
          return { agentId: childId, taskName, path }
        } finally {
          reservedPaths.delete(key)
          const remaining = (reservedSlots.get(actor.rootSessionId) ?? 1) - 1
          if (remaining === 0) reservedSlots.delete(actor.rootSessionId)
          else reservedSlots.set(actor.rootSessionId, remaining)
        }
      },
      async sendMessage(request) {
        const targetAgent = resolveTarget(actor, request.target)
        enqueueMessage(
          targetAgent.agentId,
          `<inter_agent_message from="${actor.path}">\n${request.message}\n</inter_agent_message>`,
        )
        return { agentId: targetAgent.agentId, path: targetAgent.path }
      },
      async followup(request) {
        const targetAgent = resolveTarget(actor, request.target)
        if (targetAgent.depth === 0) {
          throw new AgentControlError(
            "invalid_agent_target",
            "The root agent cannot receive a follow-up task.",
          )
        }
        await input.adapter.submitFollowup({
          sessionId: targetAgent.agentId,
          message: request.message,
          target,
        })
        if (!isRunning(targetAgent.status)) {
          targetAgent.status = "running"
          start(targetAgent, input.adapter.runChild(targetAgent.agentId))
        }
        return { agentId: targetAgent.agentId, path: targetAgent.path }
      },
      async wait(timeoutMs = 30_000) {
        const pending = drainUpdates(sessionId)
        if (pending.length > 0 || timeoutMs <= 0) return pending
        await new Promise<void>((resolve) => {
          const listeners = waiters.get(sessionId) ?? new Set<() => void>()
          let timer: ReturnType<typeof setTimeout> | undefined
          const wake = () => {
            if (timer !== undefined) clearTimeout(timer)
            listeners.delete(wake)
            resolve()
          }
          listeners.add(wake)
          waiters.set(sessionId, listeners)
          timer = setTimeout(wake, timeoutMs)
        })
        return drainUpdates(sessionId)
      },
      async interrupt(targetName) {
        const targetAgent = resolveTarget(actor, targetName)
        const previous = targetAgent.status
        if (isRunning(previous)) {
          await input.adapter.interruptChild(targetAgent.agentId)
          if (isRunning(targetAgent.status)) {
            targetAgent.status = "interrupted"
          }
        }
        return {
          agentId: targetAgent.agentId,
          path: targetAgent.path,
          previousStatus: previous,
        }
      },
      list(pathPrefix) {
        const prefix = pathPrefix?.trim()
        return Array.from(agents.values())
          .filter(
            (candidate) =>
              candidate.rootSessionId === actor.rootSessionId &&
              candidate.agentId !== actor.rootSessionId &&
              (prefix === undefined || candidate.path.startsWith(prefix)),
          )
          .sort((left, right) => left.path.localeCompare(right.path))
          .map(toSummary)
      },
    }
  }

  function start(agent: AgentRecord, run: Promise<AgentRunOutcome>): void {
    agent.status = "running"
    const worker = run
      .then((outcome) => {
        agent.status = outcomeStatus(outcome)
        if (agent.parentSessionId !== undefined) {
          enqueueMessage(
            agent.parentSessionId,
            completionMessage(agent, outcome),
          )
          pushUpdatesToAncestors(agent)
        }
      })
      .catch((error: unknown) => {
        agent.status = {
          errored: error instanceof Error ? error.message : String(error),
        }
        if (agent.parentSessionId !== undefined) {
          enqueueMessage(
            agent.parentSessionId,
            completionMessage(agent, {
              type: "errored",
              error: error instanceof Error ? error.message : String(error),
            }),
          )
          pushUpdatesToAncestors(agent)
        }
      })
      .finally(() => runs.delete(agent.agentId))
    runs.set(agent.agentId, worker)
  }

  function resolveTarget(actor: AgentRecord, target: string): AgentRecord {
    const byId = agents.get(target)
    if (byId?.rootSessionId === actor.rootSessionId) return byId
    const path = target.startsWith("/") ? target : `${actor.path}/${target}`
    const id = paths.get(pathKey(actor.rootSessionId, path))
    const resolved = id === undefined ? undefined : agents.get(id)
    if (resolved !== undefined) return resolved
    throw new AgentControlError(
      "agent_not_found",
      `Agent target ${target} was not found in ${actor.path}'s tree.`,
    )
  }

  function enqueueMessage(sessionId: string, text: string): void {
    const queued = messages.get(sessionId) ?? []
    queued.push({ role: "user", content: [{ type: "text", text }] })
    messages.set(sessionId, queued)
    waiters.get(sessionId)?.forEach((wake) => {
      wake()
    })
  }

  function pushUpdate(sessionId: string, agent: AgentRecord): void {
    const queued = updates.get(sessionId) ?? []
    queued.push({
      agentId: agent.agentId,
      path: agent.path,
      status: agent.status,
    })
    updates.set(sessionId, queued)
    waiters.get(sessionId)?.forEach((wake) => {
      wake()
    })
  }

  function pushUpdatesToAncestors(agent: AgentRecord): void {
    let parentSessionId = agent.parentSessionId
    while (parentSessionId !== undefined) {
      pushUpdate(parentSessionId, agent)
      parentSessionId = agents.get(parentSessionId)?.parentSessionId
    }
  }

  function drainUpdates(sessionId: string): readonly AgentUpdate[] {
    const pending = updates.get(sessionId) ?? []
    updates.delete(sessionId)
    return pending
  }

  return {
    bind,
    runtimeContext(sessionId) {
      const agent = requireAgent(sessionId)
      const parent =
        agent.parentSessionId === undefined
          ? undefined
          : agents.get(agent.parentSessionId)
      return {
        rootSessionId: agent.rootSessionId,
        path: agent.path,
        ...(parent === undefined ? {} : { parentPath: parent.path }),
        taskName: agent.taskName,
        agentType: agent.agentType,
        depth: agent.depth,
        maxDepth,
        maxConcurrentAgents,
      }
    },
    takeMessages(sessionId) {
      const pending = messages.get(sessionId) ?? []
      messages.delete(sessionId)
      return pending
    },
    async close() {
      const active = Array.from(agents.values()).filter(
        (agent) => agent.depth > 0 && isRunning(agent.status),
      )
      await Promise.all(
        active.map((agent) => input.adapter.interruptChild(agent.agentId)),
      )
      await Promise.all(runs.values())
    },
  }
}

export class AgentControlError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "AgentControlError"
    this.code = code
  }
}

function isRunning(status: AgentStatus): boolean {
  return status === "pending_init" || status === "running"
}

function outcomeStatus(outcome: AgentRunOutcome): AgentStatus {
  if (outcome.type === "completed") return { completed: outcome.text }
  if (outcome.type === "errored") return { errored: outcome.error }
  return "interrupted"
}

function completionMessage(
  agent: AgentRecord,
  outcome: AgentRunOutcome,
): string {
  if (outcome.type === "completed") {
    return `<subagent_notification path="${agent.path}" status="completed">\n${outcome.text}\n</subagent_notification>`
  }
  if (outcome.type === "errored") {
    return `<subagent_notification path="${agent.path}" status="errored">\n${outcome.error}\n</subagent_notification>`
  }
  return `<subagent_notification path="${agent.path}" status="interrupted">\n${outcome.reason ?? "The agent was interrupted."}\n</subagent_notification>`
}

function toSummary(agent: AgentRecord): AgentSummary {
  return {
    agentId: agent.agentId,
    taskName: agent.taskName,
    path: agent.path,
    ...(agent.parentSessionId === undefined
      ? {}
      : { parentPath: agent.path.slice(0, agent.path.lastIndexOf("/")) }),
    status: agent.status,
  }
}

function pathKey(rootSessionId: string, path: string): string {
  return `${rootSessionId}\0${path}`
}

function requireTaskName(value: string): string {
  const normalized = value.trim()
  if (!/^[a-z0-9_]+$/.test(normalized)) {
    throw new AgentControlError(
      "invalid_agent_task_name",
      "Agent task_name must contain only lowercase letters, digits, and underscores.",
    )
  }
  return normalized
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return value
}
