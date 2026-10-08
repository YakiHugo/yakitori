import type { AgentThread } from "../core/agent-thread.ts"
import { createGoalId, GoalStatus, type ThreadGoal } from "../core/goal.ts"
import type { ThreadMetadata } from "../core/rollout.ts"
import type { TurnProcessor } from "../core/session.ts"
import type { SessionIdleCause } from "../core/session-io.ts"
import type { SqliteGoalStore } from "../core/sqlite-goal-store.ts"
import { createUserInput } from "../core/user-input.ts"
import {
  createRequestId,
  type JsonObject,
  type TokenUsage,
} from "../kernel/index.ts"
import { ModelFailureError } from "./errors.ts"
import { GoalToolError, type GoalToolService } from "./tools/goal.ts"

type GoalTarget = { threadId: string; goalId: string }
type RunningGoalTurn = {
  turnId: string
  threadId: string
  rootThreadId?: string
  targets: GoalTarget[]
  tokens: number
  receipt: number
  startedAt: number
  goalId?: string
  goalObjective: string | undefined
  automatic: boolean
  output: boolean
  tool: boolean
  successfulTool: boolean
  failedExecution: boolean
  failed?: "blocked" | "usage_limited"
}

export type SetGoalInput = {
  objective?: string
  status?: GoalStatus
  tokenBudget?: number | null
  inputId?: string | null
}

type InstalledThread = {
  thread: AgentThread
  eligible: () => Promise<boolean>
  unsubscribe: () => void
}

// Goal owns persistence, accounting and idle continuation. Session still owns
// admission and execution, and the main model owns the completion decision.
export class GoalRuntime implements GoalToolService {
  readonly #store: SqliteGoalStore
  readonly #notify: (threadId: string, goal: ThreadGoal | undefined) => void
  readonly #report: (error: unknown, threadId: string) => void
  readonly #installed = new Map<string, InstalledThread>()
  readonly #running = new Map<string, RunningGoalTurn>()
  readonly #continuing = new Map<string, Promise<void>>()
  readonly #pendingWake = new Set<string>()
  readonly #emptyTurns = new Map<string, number>()
  readonly #executionFailures = new Map<string, number>()
  readonly #timeRemainders = new Map<string, number>()
  #stopping = false

  constructor(options: {
    store: SqliteGoalStore
    notify: (threadId: string, goal: ThreadGoal | undefined) => void
    report: (error: unknown, threadId: string) => void
  }) {
    this.#store = options.store
    this.#notify = options.notify
    this.#report = options.report
  }

  read(threadId: string): ThreadGoal | undefined {
    this.#flushTime(threadId)
    return this.#store.read(threadId)
  }

  async get(threadId: string): Promise<ThreadGoal | undefined> {
    return this.read(threadId)
  }

  set(threadId: string, input: SetGoalInput): ThreadGoal {
    const previous = this.read(threadId)
    const replacement =
      previous === undefined ||
      ((previous.status === "complete" ||
        previous.status === "budget_limited") &&
        input.objective !== undefined &&
        input.status === "active")
    if (replacement && input.objective === undefined)
      throw new GoalToolError(
        "goal_missing",
        "Provide an objective to create a goal.",
      )
    if (
      !replacement &&
      input.status === "active" &&
      (previous?.status === "complete" || previous?.status === "budget_limited")
    )
      throw new GoalToolError(
        "goal_finished",
        "Set a new objective to start a new goal.",
      )
    const now = new Date().toISOString()
    let base = previous
    if (replacement && input.objective !== undefined)
      base = {
        id: createGoalId(),
        threadId,
        objective: input.objective,
        status: GoalStatus.Active,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: now,
        updatedAt: now,
      }
    if (base === undefined)
      throw new Error("Goal creation requires an objective.")
    const { tokenBudget: oldBudget, inputId: oldInput, ...rest } = base
    const budget =
      input.tokenBudget === undefined ? oldBudget : input.tokenBudget
    const inputId = input.inputId === undefined ? oldInput : input.inputId
    let status = input.status ?? base.status
    if (status !== "complete" && budget != null && base.tokensUsed >= budget)
      status = GoalStatus.BudgetLimited
    const goal: ThreadGoal = {
      ...rest,
      objective: input.objective ?? base.objective,
      status,
      ...(budget == null ? {} : { tokenBudget: budget }),
      ...(inputId == null ? {} : { inputId }),
      updatedAt: now,
    }
    if (replacement && previous !== undefined)
      this.#timeRemainders.delete(previous.id)
    this.#store.save(goal)
    this.#store.setContinuationDeferred(threadId, false)
    this.#emptyTurns.delete(threadId)
    this.#executionFailures.delete(threadId)
    this.#attachGoal(goal)
    this.#notify(threadId, goal)
    if (goal.status === "active") {
      const thread = this.#installed.get(threadId)?.thread
      const activeTurnId = thread?.snapshot().activeTurnId
      if (
        !replacement &&
        previous?.objective !== goal.objective &&
        activeTurnId !== undefined &&
        thread !== undefined
      ) {
        void thread
          .steer(
            {
              submissionId: createRequestId(),
              goalId: goal.id,
              content: createUserInput(
                `The user updated the active goal objective: ${goal.objective}\nContinue toward this updated objective and verify its requirements before marking the goal complete.`,
              ),
            },
            activeTurnId,
          )
          .catch((error: unknown) => this.#report(error, threadId))
      }
      this.wake(threadId)
    }
    return goal
  }

  async create(
    threadId: string,
    input: { objective: string; tokenBudget?: number },
    turnId?: string,
  ): Promise<ThreadGoal> {
    this.#requireCurrentTurn(threadId, turnId)
    const goal = this.read(threadId)
    if (goal !== undefined && goal.status !== "complete")
      throw new GoalToolError(
        "goal_exists",
        "This thread already has an unfinished goal.",
      )
    const created = this.set(threadId, { ...input, status: GoalStatus.Active })
    const running = this.#running.get(threadId)
    // The model that explicitly starts a fresh goal in this turn may finish it.
    // User replacement through set() intentionally retains the old identity.
    if (running !== undefined) {
      running.goalId = created.id
      running.goalObjective = created.objective
    }
    return created
  }

  async update(
    threadId: string,
    status: "complete" | "blocked" | "paused",
    turnId?: string,
  ): Promise<ThreadGoal> {
    this.#requireCurrentTurn(threadId, turnId)
    const goal = this.read(threadId)
    if (goal === undefined)
      throw new GoalToolError("goal_missing", "This thread has no goal.")
    const running = this.#running.get(threadId)
    if (
      turnId !== undefined &&
      (running?.goalId !== goal.id || running.goalObjective !== goal.objective)
    )
      throw new GoalToolError(
        "goal_changed",
        "The goal changed after this turn started. Read the current goal before further work.",
      )
    // Budget exhaustion takes precedence over pause/block, but the finishing
    // turn may still establish that the objective was completed.
    if (goal.status === "budget_limited" && status !== "complete") return goal
    return this.#changeStatus(goal, status)
  }

  clear(threadId: string): void {
    const previous = this.#store.read(threadId)
    if (previous !== undefined) this.#timeRemainders.delete(previous.id)
    for (const turn of this.#running.values())
      turn.targets = turn.targets.filter(
        (target) => target.threadId !== threadId,
      )
    this.#store.delete(threadId)
    this.#emptyTurns.delete(threadId)
    this.#executionFailures.delete(threadId)
    this.#notify(threadId, undefined)
  }

  deferContinuation(threadId: string, deferred: boolean): boolean {
    const previous = this.#store.isContinuationDeferred(threadId)
    this.#store.setContinuationDeferred(threadId, deferred)
    if (!deferred) this.wake(threadId)
    return previous
  }

  fork(source: string, target: string): void {
    this.#flushTime(source)
    const goal = this.#store.fork(source, target, new Date().toISOString())
    if (goal !== undefined) this.#notify(target, goal)
  }

  pauseForInterrupt(threadId: string, expectedTurnId: string): void {
    if (
      this.#installed.get(threadId)?.thread.snapshot().activeTurnId !==
      expectedTurnId
    )
      return
    const goal = this.read(threadId)
    if (goal?.status === "active") this.#changeStatus(goal, "paused")
  }

  install(thread: AgentThread, eligible: () => Promise<boolean>): void {
    if (this.#installed.get(thread.id)?.thread === thread) return
    this.#installed.get(thread.id)?.unsubscribe()
    const unsubscribe = thread.subscribeStatus((status, cause) => {
      if (status === "idle") this.#idle(thread.id, cause)
      if (status === "shutdown") {
        this.#flushTime(thread.id)
        this.#running.delete(thread.id)
        this.#pendingWake.delete(thread.id)
        this.#emptyTurns.delete(thread.id)
        this.#executionFailures.delete(thread.id)
        this.#installed.delete(thread.id)
        unsubscribe()
      }
    })
    this.#installed.set(thread.id, { thread, eligible, unsubscribe })
    this.wake(thread.id)
  }

  wake(threadId: string): void {
    if (this.#stopping) return
    if (this.#continuing.has(threadId)) {
      this.#pendingWake.add(threadId)
      return
    }
    const work = this.#continue(threadId)
      .catch((error: unknown) => {
        this.#report(error, threadId)
      })
      .finally(() => {
        this.#continuing.delete(threadId)
        // An immediate turn can finish before startIfIdle resolves. Remember
        // that idle notification without retrying a rejected/busy admission.
        if (this.#pendingWake.delete(threadId)) this.wake(threadId)
      })
    this.#continuing.set(threadId, work)
  }

  wrapProcessor(
    metadata: ThreadMetadata,
    processor: TurnProcessor,
  ): TurnProcessor {
    const threadId = metadata.id
    const agent = metadata.metadata?.agent
    const rootThreadId =
      typeof agent === "object" &&
      agent !== null &&
      !Array.isArray(agent) &&
      "rootThreadId" in agent &&
      typeof agent.rootThreadId === "string"
        ? agent.rootThreadId
        : undefined
    return {
      ...processor,
      start: (runtime, input, context, control) => {
        if (input.goalId === undefined)
          this.#store.setContinuationDeferred(threadId, false)
        const ownGoal = this.#store.read(threadId)
        const targets = [
          threadId,
          ...(rootThreadId === undefined || rootThreadId === threadId
            ? []
            : [rootThreadId]),
        ].flatMap((id) => {
          const goal = this.#store.read(id)
          return goal?.status === "active"
            ? [{ threadId: id, goalId: goal.id }]
            : []
        })
        const turn: RunningGoalTurn = {
          threadId,
          turnId: context.turnId,
          ...(rootThreadId === undefined ? {} : { rootThreadId }),
          targets,
          tokens: 0,
          receipt: 0,
          startedAt: Date.now(),
          ...(ownGoal === undefined ? {} : { goalId: ownGoal.id }),
          goalObjective: goalObjective(
            runtime.snapshot().context.worldStateBaseline,
          ),
          automatic: input.goalId !== undefined,
          output: false,
          tool: false,
          successfulTool: false,
          failedExecution: false,
        }
        this.#running.set(threadId, turn)
        const task = processor.start(
          {
            ...runtime,
            recordWorldStateUpdate: async (items, update) => {
              await runtime.recordWorldStateUpdate(items, update)
              // Only accept the objective actually supplied to model context.
              // A user edit must not let an already-running response complete it.
              turn.goalObjective = goalObjective(update.snapshot)
            },
            recordUsage: async (usage) => {
              await runtime.recordUsage(usage)
              this.#accountUsage(turn, usage)
            },
            recordToolStarted: (item) => {
              turn.tool = true
              return runtime.recordToolStarted(item)
            },
            recordToolResult: (response, completion) => {
              if (completion.error === undefined) turn.successfulTool = true
              // A command's nonzero exit is a completed execution. Only a
              // failure to execute counts toward the infrastructure stop.
              if (
                completion.name === "exec_command" &&
                completion.error?.code === "exec_command_failed"
              )
                turn.failedExecution = true
              return runtime.recordToolResult(response, completion)
            },
            recordConversationItems: (items) => {
              if (
                items.some(
                  (item) =>
                    item.item.role === "assistant" &&
                    item.item.content.some(
                      (part) =>
                        part.type === "text" && part.text.trim().length > 0,
                    ),
                )
              )
                turn.output = true
              return runtime.recordConversationItems(items)
            },
          },
          input,
          context,
          control,
        )
        return {
          ...task,
          completion: task.completion
            .then((completion) => {
              // A new goal turn must not reset the processor's recovery stop.
              if (
                !control.signal.aborted &&
                (completion?.reason === "refused" ||
                  completion?.reason === "truncated")
              )
                turn.failed = "blocked"
              return completion
            })
            .catch((error: unknown) => {
              if (!control.signal.aborted)
                turn.failed =
                  error instanceof ModelFailureError &&
                  error.failure.kind === "rate_limited"
                    ? "usage_limited"
                    : "blocked"
              throw error
            }),
        }
      },
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true
    await Promise.all(this.#continuing.values())
  }

  close(): void {
    for (const id of this.#running.keys()) this.#flushTime(id)
    for (const installed of this.#installed.values()) installed.unsubscribe()
    this.#installed.clear()
    this.#store.close()
  }

  #requireCurrentTurn(threadId: string, turnId: string | undefined): void {
    if (turnId !== undefined && this.#running.get(threadId)?.turnId !== turnId)
      throw new GoalToolError("stale_turn", "This turn is no longer active.")
  }

  #attachGoal(goal: ThreadGoal): void {
    for (const [id, turn] of this.#running) {
      if (id !== goal.threadId && turn.rootThreadId !== goal.threadId) continue
      const alreadyBound = turn.targets.some(
        (target) =>
          target.threadId === goal.threadId && target.goalId === goal.id,
      )
      turn.targets = turn.targets.filter(
        (target) => target.threadId !== goal.threadId,
      )
      if (
        goal.status === "active" ||
        (goal.status === "budget_limited" && alreadyBound)
      )
        turn.targets.push({ threadId: goal.threadId, goalId: goal.id })
      if (id === goal.threadId) {
        // A newly created goal belongs to this turn. Replacing an existing
        // goal keeps the old identity so late tool calls cannot finish it.
        if (turn.goalId === undefined) turn.goalId = goal.id
        turn.startedAt = Date.now()
      }
    }
  }

  #changeStatus(goal: ThreadGoal, status: GoalStatus): ThreadGoal {
    const next = { ...goal, status, updatedAt: new Date().toISOString() }
    this.#store.save(next)
    this.#attachGoal(next)
    this.#notify(goal.threadId, next)
    return next
  }

  #flushTime(threadId: string): void {
    const turn = this.#running.get(threadId)
    if (turn === undefined) return
    const now = Date.now()
    const elapsedMs = Math.max(0, now - turn.startedAt)
    turn.startedAt = now
    const target = turn.targets.find((target) => target.threadId === threadId)
    if (target === undefined) return
    const current = this.#store.read(threadId)
    if (
      current?.id !== target.goalId ||
      (current.status !== "active" && current.status !== "budget_limited")
    )
      return
    // Carry subsecond work across turns without including idle or paused time.
    const totalMs = elapsedMs + (this.#timeRemainders.get(target.goalId) ?? 0)
    const elapsed = Math.floor(totalMs / 1000)
    this.#timeRemainders.set(target.goalId, totalMs % 1000)
    if (elapsed === 0) return
    const goal = this.#store.account(
      threadId,
      target.goalId,
      `${turn.threadId}:${turn.turnId}:time:${++turn.receipt}`,
      0,
      elapsed,
      new Date().toISOString(),
    )
    if (goal !== undefined) this.#notify(threadId, goal)
  }

  #accountUsage(turn: RunningGoalTurn, usage: TokenUsage): void {
    // Provider adapters normalize inputTokens to include cache reads/writes.
    // Cache reads do not consume the goal budget; cache writes do.
    const total =
      Math.max(0, usage.inputTokens - (usage.cacheReadInputTokens ?? 0)) +
      usage.outputTokens
    const delta = Math.max(0, total - turn.tokens)
    turn.tokens = Math.max(total, turn.tokens)
    if (delta === 0) return
    const receipt = `${turn.threadId}:${turn.turnId}:usage:${++turn.receipt}`
    for (const target of turn.targets) {
      const goal = this.#store.account(
        target.threadId,
        target.goalId,
        receipt,
        delta,
        0,
        new Date().toISOString(),
      )
      if (goal !== undefined) this.#notify(target.threadId, goal)
    }
  }

  #idle(threadId: string, cause?: SessionIdleCause): void {
    this.#flushTime(threadId)
    const turn = this.#running.get(threadId)
    this.#running.delete(threadId)
    const goal = this.#store.read(threadId)
    if (
      !this.#stopping &&
      goal?.status === "active" &&
      (turn?.goalId === goal.id || turn === undefined)
    ) {
      if (cause === "failed" || turn?.failed !== undefined)
        this.#changeStatus(goal, turn?.failed ?? "blocked")
      else if (cause !== "interrupted" && turn !== undefined) {
        const failures = turn.successfulTool
          ? 0
          : (this.#executionFailures.get(threadId) ?? 0) +
            Number(turn.failedExecution)
        this.#executionFailures.set(threadId, failures)
        if (failures >= 3) this.#changeStatus(goal, "blocked")
      }
      if (
        cause !== "interrupted" &&
        turn?.automatic &&
        this.#store.read(threadId)?.status === "active"
      ) {
        const empty =
          !turn.output && !turn.tool
            ? (this.#emptyTurns.get(threadId) ?? 0) + 1
            : 0
        this.#emptyTurns.set(threadId, empty)
        // Codex's no-progress boundary: three empty automatic turns. This is
        // a harness safety stop, not a model completion verdict or quota.
        if (empty >= 3) this.#changeStatus(goal, "blocked")
      }
    }
    if (!this.#stopping) this.wake(threadId)
  }

  async #continue(threadId: string): Promise<void> {
    const installed = this.#installed.get(threadId)
    if (
      installed === undefined ||
      installed.thread.status !== "idle" ||
      this.#stopping
    )
      return
    if (!(await installed.eligible())) return
    const goal = this.#store.read(threadId)
    if (
      this.#stopping ||
      this.#installed.get(threadId) !== installed ||
      goal?.status !== "active" ||
      this.#store.isContinuationDeferred(threadId)
    )
      return
    await installed.thread.startIfIdle({
      submissionId: createRequestId(),
      goalId: goal.id,
      content: createUserInput(
        `Continue working toward the active goal: ${goal.objective}\nMake concrete progress until it is achieved or a real blocker requires user input. Use update_goal to record completion or the permitted stop state. Do not treat a final message as completing the goal.`,
      ),
    })
  }
}

function goalObjective(snapshot: JsonObject | undefined): string | undefined {
  const goal = snapshot?.goal
  return typeof goal === "object" &&
    goal !== null &&
    !Array.isArray(goal) &&
    "text" in goal &&
    typeof goal.text === "string"
    ? goal.text
    : undefined
}
