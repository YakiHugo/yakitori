import type { ForkedModelContext } from "./model-context.ts"
import type { AgentStatus } from "../core/session-io.ts"

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

export type { AgentStatus } from "../core/session-io.ts"

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
  runChild(input: {
    readonly sessionId: string
    readonly message: string
    readonly target: AgentModelTarget
  }): Promise<AgentRunOutcome>
  ensureLoaded(sessionId: string): Promise<void>
  getStatus(sessionId: string): Promise<AgentStatus>
  failChild(sessionId: string, message: string): Promise<AgentStatus>
  completionDeliveryId(sessionId: string): Promise<string>
  interruptChild(sessionId: string): Promise<void>
  deliverMessage(input: {
    readonly sessionId: string
    readonly messageId: string
    readonly text: string
  }): Promise<void>
  rollbackChild(sessionId: string): Promise<void>
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
    readonly messageId?: string
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
  list(pathPrefix?: string): Promise<readonly AgentSummary[]>
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
  registerAgent(input: AgentRegistration): void
  unregisterAgent(agentId: string): void
  runtimeContext(sessionId: string): AgentRuntimeContext
  closeAgent(agentId: string): Promise<readonly string[]>
  releaseClosedPath(path: string): void
  close(): Promise<void>
}>

export type AgentRegistration = Readonly<{
  agentId: string
  rootSessionId: string
  parentSessionId: string
  taskName: string
  path: string
  agentType: AgentType
  depth: number
  pendingCompletion?: Readonly<{
    messageId: string
    outcome: AgentRunOutcome
  }>
}>

type AgentRecord = {
  readonly agentId: string
  readonly rootSessionId: string
  readonly parentSessionId?: string
  readonly taskName: string
  readonly path: string
  readonly agentType: AgentType
  readonly depth: number
}

type AgentTask = {
  message: string
  target: AgentModelTarget
  deliveryId?: string
  outcome?: AgentRunOutcome
}

type InFlightSpawn = Readonly<{
  path: string
  completion: Promise<void>
}>

const ROOT_TASK_NAME = "root"

export function createAgentControl(input: {
  readonly rootSessionId: string
  readonly adapter: AgentControlAdapter
  readonly maxDepth?: number
  readonly maxConcurrentAgents?: number
  readonly restoreAgents?: () => Promise<readonly AgentRegistration[]>
  readonly onBackgroundError?: (
    error: unknown,
    agentId: string,
    operation: string,
  ) => void
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
  const updates = new Map<string, AgentUpdate[]>()
  const waiters = new Map<string, Set<() => void>>()
  const runs = new Map<string, Promise<void>>()
  const tasks = new Map<string, AgentTask[]>()
  const knownDeliveryIds = new Set<string>()
  const closingPaths = new Set<string>()
  const inFlightSpawns = new Set<InFlightSpawn>()
  let restorePromise: Promise<void> | undefined

  const root: AgentRecord = {
    agentId: input.rootSessionId,
    rootSessionId: input.rootSessionId,
    taskName: ROOT_TASK_NAME,
    path: "/root",
    agentType: "general",
    depth: 0,
  }
  agents.set(root.agentId, root)
  paths.set(pathKey(root.rootSessionId, root.path), root.agentId)

  function requireAgent(sessionId: string): AgentRecord {
    const existing = agents.get(sessionId)
    if (existing !== undefined) return existing
    throw new AgentControlError(
      "agent_not_found",
      `Agent ${sessionId} is not registered in tree ${input.rootSessionId}.`,
    )
  }

  function registerAgent(registration: AgentRegistration): void {
    if (registration.rootSessionId !== input.rootSessionId) {
      throw new Error(
        `Agent ${registration.agentId} belongs to root ${registration.rootSessionId}, not ${input.rootSessionId}.`,
      )
    }
    const { pendingCompletion, ...record } = registration
    const existing = agents.get(record.agentId)
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error(`Agent ${record.agentId} has conflicting metadata.`)
      }
      if (pendingCompletion !== undefined) {
        enqueueRestoredCompletion(existing, pendingCompletion)
      }
      return
    }
    const key = pathKey(record.rootSessionId, record.path)
    const pathOwner = paths.get(key)
    if (pathOwner !== undefined && pathOwner !== record.agentId) {
      throw new Error(`Agent path ${record.path} is already registered.`)
    }
    agents.set(record.agentId, record)
    paths.set(key, record.agentId)
    if (pendingCompletion !== undefined) {
      enqueueRestoredCompletion(record, pendingCompletion)
    }
  }

  function enqueueRestoredCompletion(
    agent: AgentRecord,
    completion: NonNullable<AgentRegistration["pendingCompletion"]>,
  ): void {
    if (knownDeliveryIds.has(completion.messageId)) return
    knownDeliveryIds.add(completion.messageId)
    const queued = tasks.get(agent.agentId) ?? []
    queued.push({
      message: "",
      target: { provider: "restored", model: "restored" },
      deliveryId: completion.messageId,
      outcome: completion.outcome,
    })
    tasks.set(agent.agentId, queued)
    startWorkerIfNeeded(agent)
  }

  function unregisterAgent(agentId: string): void {
    const agent = agents.get(agentId)
    if (agent === undefined || agent.depth === 0) return
    if (
      Array.from(agents.values()).some(
        (candidate) => candidate.parentSessionId === agentId,
      ) ||
      runs.has(agentId)
    ) {
      throw new Error(`Agent ${agentId} cannot be unregistered while active.`)
    }
    agents.delete(agentId)
    paths.delete(pathKey(agent.rootSessionId, agent.path))
    updates.delete(agentId)
    tasks.delete(agentId)
  }

  function ensureReady(): Promise<void> {
    if (input.restoreAgents === undefined) return Promise.resolve()
    if (restorePromise === undefined) {
      const restoring = input
        .restoreAgents()
        .then((registrations) => registrations.forEach(registerAgent))
      const retryable = restoring.catch((error) => {
        if (restorePromise === retryable) restorePromise = undefined
        throw error
      })
      restorePromise = retryable
    }
    return restorePromise
  }

  function bind(
    sessionId: string,
    target: AgentModelTarget,
  ): BoundAgentControl {
    const actor = requireAgent(sessionId)
    return {
      async spawn(request) {
        await ensureReady()
        requireOpenPath(actor.path)
        if (actor.depth >= maxDepth) {
          throw new AgentControlError(
            "agent_depth_limit_reached",
            `Agent ${actor.path} is at the maximum delegation depth of ${String(maxDepth)}. Complete the task without spawning another agent.`,
          )
        }
        const taskName = requireTaskName(request.taskName)
        const path = `${actor.path}/${taskName}`
        requireOpenPath(path)
        const key = pathKey(actor.rootSessionId, path)
        if (paths.has(key) || reservedPaths.has(key)) {
          throw new AgentControlError(
            "agent_name_conflict",
            `Agent task name ${taskName} already exists under ${actor.path}.`,
          )
        }
        const reserved = reservedSlots.get(actor.rootSessionId) ?? 0
        reservedPaths.add(key)
        reservedSlots.set(actor.rootSessionId, reserved + 1)
        const operation = (async () => {
          const childStatuses = await Promise.all(
            Array.from(agents.values())
              .filter((candidate) => candidate.depth > 0)
              .map((candidate) => input.adapter.getStatus(candidate.agentId)),
          )
          const runningChildren = childStatuses.filter(isRunning).length
          if (runningChildren + reserved >= maxConcurrentAgents - 1) {
            throw new AgentControlError(
              "agent_concurrency_limit_reached",
              `Agent tree ${actor.rootSessionId} already has ${String(runningChildren)} running subagents; the configured limit is ${String(maxConcurrentAgents - 1)}.`,
            )
          }
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
          try {
            if (isClosingPath(path)) {
              throw new AgentControlError(
                "agent_closed",
                `Agent ${path} was closed while it was being created.`,
              )
            }
            const child: AgentRegistration = {
              agentId: childId,
              rootSessionId: actor.rootSessionId,
              parentSessionId: sessionId,
              taskName,
              path,
              agentType: request.agentType,
              depth: actor.depth + 1,
            }
            registerAgent(child)
            start(child, request.message, childTarget)
            return { agentId: childId, taskName, path }
          } catch (error) {
            try {
              await input.adapter.rollbackChild(childId)
            } catch (cleanupError) {
              throw new AgentCleanupError(childId, cleanupError)
            }
            throw error
          }
        })()
        const spawn: InFlightSpawn = {
          path,
          completion: operation.then(
            () => undefined,
            (error) => {
              if (error instanceof AgentCleanupError) throw error
            },
          ),
        }
        inFlightSpawns.add(spawn)
        try {
          return await operation
        } finally {
          inFlightSpawns.delete(spawn)
          reservedPaths.delete(key)
          const remaining = (reservedSlots.get(actor.rootSessionId) ?? 1) - 1
          if (remaining === 0) reservedSlots.delete(actor.rootSessionId)
          else reservedSlots.set(actor.rootSessionId, remaining)
        }
      },
      async sendMessage(request) {
        await ensureReady()
        const targetAgent = resolveTarget(actor, request.target)
        await input.adapter.ensureLoaded(targetAgent.agentId)
        await input.adapter.deliverMessage({
          sessionId: targetAgent.agentId,
          messageId:
            request.messageId === undefined
              ? createAgentMessageId()
              : `agent_message:${actor.agentId}:${request.messageId}`,
          text: `<inter_agent_message from="${actor.path}">\n${request.message}\n</inter_agent_message>`,
        })
        wakeWaiters(targetAgent.agentId)
        return { agentId: targetAgent.agentId, path: targetAgent.path }
      },
      async followup(request) {
        await ensureReady()
        const targetAgent = resolveTarget(actor, request.target)
        if (targetAgent.depth === 0) {
          throw new AgentControlError(
            "invalid_agent_target",
            "The root agent cannot receive a follow-up task.",
          )
        }
        await input.adapter.ensureLoaded(targetAgent.agentId)
        start(targetAgent, request.message, target)
        return { agentId: targetAgent.agentId, path: targetAgent.path }
      },
      async wait(timeoutMs = 30_000) {
        await ensureReady()
        retryPendingDeliveries()
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
        await ensureReady()
        const targetAgent = resolveTarget(actor, targetName)
        await input.adapter.ensureLoaded(targetAgent.agentId)
        const previous = await input.adapter.getStatus(targetAgent.agentId)
        if (isRunning(previous)) {
          await input.adapter.interruptChild(targetAgent.agentId)
        }
        return {
          agentId: targetAgent.agentId,
          path: targetAgent.path,
          previousStatus: previous,
        }
      },
      async list(pathPrefix) {
        await ensureReady()
        retryPendingDeliveries()
        const prefix = pathPrefix?.trim()
        const selected = Array.from(agents.values())
          .filter(
            (candidate) =>
              candidate.rootSessionId === actor.rootSessionId &&
              candidate.agentId !== actor.rootSessionId &&
              (prefix === undefined || candidate.path.startsWith(prefix)),
          )
          .sort((left, right) => left.path.localeCompare(right.path))
        return Promise.all(
          selected.map(async (agent) =>
            toSummary(agent, await input.adapter.getStatus(agent.agentId)),
          ),
        )
      },
    }
  }

  function start(
    agent: AgentRecord,
    message: string,
    target: AgentModelTarget,
  ): void {
    requireOpenPath(agent.path)
    const queued = tasks.get(agent.agentId) ?? []
    queued.push({
      message,
      target,
    })
    tasks.set(agent.agentId, queued)
    startWorkerIfNeeded(agent)
  }

  function startWorkerIfNeeded(agent: AgentRecord): void {
    if (
      isClosingPath(agent.path) ||
      runs.has(agent.agentId) ||
      (tasks.get(agent.agentId)?.length ?? 0) === 0
    ) {
      return
    }
    const worker = runTasks(agent)
    runs.set(agent.agentId, worker)
    const settle = (retry: boolean) => {
      if (runs.get(agent.agentId) !== worker) return
      runs.delete(agent.agentId)
      if (retry) startWorkerIfNeeded(agent)
      else wakeWaiters(agent.parentSessionId ?? agent.agentId)
    }
    void worker.then(
      () => settle(true),
      (error: unknown) => {
        settle(false)
        try {
          input.onBackgroundError?.(error, agent.agentId, "task-worker")
        } catch {
          // Observability callbacks cannot break AgentControl lifecycle.
        }
      },
    )
  }

  async function runTasks(agent: AgentRecord): Promise<void> {
    for (;;) {
      const task = tasks.get(agent.agentId)?.[0]
      if (task === undefined) {
        tasks.delete(agent.agentId)
        return
      }
      if (task.outcome === undefined) {
        try {
          task.outcome = await input.adapter.runChild({
            sessionId: agent.agentId,
            message: task.message,
            target: task.target,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const status = await input.adapter.failChild(agent.agentId, message)
          const failedOutcome = outcomeFromAgentStatus(status)
          if (failedOutcome === undefined) {
            throw new Error(
              `Agent ${agent.agentId} launch failed without a Session-owned terminal status.`,
              { cause: error },
            )
          }
          task.outcome = failedOutcome
        }
      }
      if (task.deliveryId === undefined) {
        task.deliveryId = await input.adapter.completionDeliveryId(
          agent.agentId,
        )
        knownDeliveryIds.add(task.deliveryId)
      }
      if (isClosingPath(agent.path)) {
        tasks.get(agent.agentId)?.shift()
        continue
      }
      if (agent.parentSessionId === undefined) {
        throw new Error(`Agent ${agent.agentId} has no parent.`)
      }
      await input.adapter.deliverMessage({
        sessionId: agent.parentSessionId,
        messageId: task.deliveryId,
        text: completionMessage(agent, task.outcome),
      })
      tasks.get(agent.agentId)?.shift()
      wakeWaiters(agent.parentSessionId)
      pushUpdatesToAncestors(agent, outcomeStatus(task.outcome))
    }
  }

  function retryPendingDeliveries(): void {
    for (const agent of agents.values()) {
      if ((tasks.get(agent.agentId)?.length ?? 0) > 0) {
        startWorkerIfNeeded(agent)
      }
    }
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

  function wakeWaiters(sessionId: string): void {
    waiters.get(sessionId)?.forEach((wake) => {
      wake()
    })
  }

  function isClosingPath(path: string): boolean {
    return Array.from(closingPaths).some(
      (closingPath) =>
        path === closingPath || path.startsWith(`${closingPath}/`),
    )
  }

  function requireOpenPath(path: string): void {
    if (!isClosingPath(path)) return
    throw new AgentControlError(
      "agent_closed",
      `Agent ${path} is being closed.`,
    )
  }

  function pushUpdate(
    sessionId: string,
    agent: AgentRecord,
    status: AgentStatus,
  ): void {
    const queued = updates.get(sessionId) ?? []
    queued.push({
      agentId: agent.agentId,
      path: agent.path,
      status,
    })
    updates.set(sessionId, queued)
    waiters.get(sessionId)?.forEach((wake) => {
      wake()
    })
  }

  function pushUpdatesToAncestors(
    agent: AgentRecord,
    status: AgentStatus,
  ): void {
    let parentSessionId = agent.parentSessionId
    while (parentSessionId !== undefined) {
      pushUpdate(parentSessionId, agent, status)
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
    registerAgent,
    unregisterAgent,
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
    async closeAgent(agentId) {
      await ensureReady()
      const target = requireAgent(agentId)
      closingPaths.add(target.path)
      for (;;) {
        const pending = Array.from(inFlightSpawns)
          .filter(
            (spawn) =>
              spawn.path === target.path ||
              spawn.path.startsWith(`${target.path}/`),
          )
          .map((spawn) => spawn.completion)
        if (pending.length === 0) break
        await Promise.all(pending)
      }
      const subtree = Array.from(agents.values())
        .filter(
          (agent) =>
            agent.agentId === target.agentId ||
            agent.path.startsWith(`${target.path}/`),
        )
        .sort((left, right) => right.depth - left.depth)
      for (const agent of subtree) {
        tasks.get(agent.agentId)?.splice(0)
      }
      const active = subtree.filter((agent) => runs.has(agent.agentId))
      await Promise.all(
        active.map((agent) => input.adapter.interruptChild(agent.agentId)),
      )
      await Promise.allSettled(
        active.flatMap((agent) => {
          const run = runs.get(agent.agentId)
          return run === undefined ? [] : [run]
        }),
      )
      for (const agent of subtree) {
        if (agent.depth > 0) unregisterAgent(agent.agentId)
      }
      return subtree.map((agent) => agent.agentId)
    },
    releaseClosedPath(path) {
      closingPaths.delete(path)
    },
    async close() {
      await this.closeAgent(input.rootSessionId)
    },
  }
}

function outcomeFromAgentStatus(
  status: AgentStatus,
): AgentRunOutcome | undefined {
  if (typeof status === "object") {
    return "completed" in status
      ? { type: "completed", text: status.completed ?? "" }
      : { type: "errored", error: status.errored }
  }
  return status === "interrupted" ? { type: "interrupted" } : undefined
}

export class AgentControlError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "AgentControlError"
    this.code = code
  }
}

class AgentCleanupError extends Error {
  constructor(agentId: string, cause: unknown) {
    super(`Failed to roll back late agent ${agentId}.`, { cause })
    this.name = "AgentCleanupError"
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

function toSummary(agent: AgentRecord, status: AgentStatus): AgentSummary {
  return {
    agentId: agent.agentId,
    taskName: agent.taskName,
    path: agent.path,
    ...(agent.parentSessionId === undefined
      ? {}
      : { parentPath: agent.path.slice(0, agent.path.lastIndexOf("/")) }),
    status,
  }
}

function pathKey(rootSessionId: string, path: string): string {
  return `${rootSessionId}\0${path}`
}

function createAgentMessageId(): string {
  return `agent_message_${globalThis.crypto.randomUUID()}`
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
