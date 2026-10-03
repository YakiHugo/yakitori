import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  createGoalId,
  GoalStatus,
  isGoalStatus,
  type ThreadGoal,
} from "./goal.ts"

type GoalRow = Readonly<{
  id: string
  thread_id: string
  objective: string
  status: GoalStatus
  token_budget: number | null
  tokens_used: number
  time_used_seconds: number
  created_at: string
  updated_at: string
  input_id: string | null
}>

// Goals are durable thread state, independent of sidebar presentation and
// disposable rollout projections. Receipts make replayed usage safe to charge.
export class SqliteGoalStore {
  readonly #database: DatabaseSync

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
    }
    this.#database = new DatabaseSync(databasePath, {
      timeout: 5_000,
      enableDoubleQuotedStringLiterals: false,
    })
    try {
      this.#database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS thread_goals (
          thread_id TEXT PRIMARY KEY NOT NULL,
          id TEXT UNIQUE NOT NULL,
          objective TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (
            'active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'complete'
          )),
          token_budget INTEGER CHECK (token_budget > 0),
          tokens_used INTEGER NOT NULL CHECK (tokens_used >= 0),
          time_used_seconds INTEGER NOT NULL CHECK (time_used_seconds >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          input_id TEXT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS goal_usage_receipts (
          goal_id TEXT NOT NULL REFERENCES thread_goals(id) ON DELETE CASCADE,
          event_id TEXT NOT NULL,
          PRIMARY KEY (goal_id, event_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS goal_continuation_deferrals (
          thread_id TEXT PRIMARY KEY NOT NULL
            REFERENCES thread_goals(thread_id) ON DELETE CASCADE
        ) STRICT;
      `)
    } catch (error) {
      this.#database.close()
      throw error
    }
  }

  read(threadId: string): ThreadGoal | undefined {
    const row = this.#database
      .prepare("SELECT * FROM thread_goals WHERE thread_id = ?")
      .get(threadId) as GoalRow | undefined
    if (row === undefined) return undefined
    return {
      id: row.id,
      threadId: row.thread_id,
      objective: row.objective,
      status: row.status,
      ...(row.token_budget === null ? {} : { tokenBudget: row.token_budget }),
      tokensUsed: row.tokens_used,
      timeUsedSeconds: row.time_used_seconds,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.input_id === null ? {} : { inputId: row.input_id }),
    }
  }

  save(goal: ThreadGoal): void {
    requireGoal(goal)
    this.#database.exec("BEGIN IMMEDIATE")
    try {
      // A new goal identity must not inherit the old goal's receipts or deferral.
      this.#database
        .prepare("DELETE FROM thread_goals WHERE thread_id = ? AND id <> ?")
        .run(goal.threadId, goal.id)
      this.#writeGoal(goal)
      this.#database.exec("COMMIT")
    } catch (error) {
      this.#database.exec("ROLLBACK")
      throw error
    }
  }

  delete(threadId: string): void {
    this.#database
      .prepare("DELETE FROM thread_goals WHERE thread_id = ?")
      .run(threadId)
  }

  isContinuationDeferred(threadId: string): boolean {
    return (
      this.#database
        .prepare(
          "SELECT 1 FROM goal_continuation_deferrals WHERE thread_id = ?",
        )
        .get(threadId) !== undefined
    )
  }

  setContinuationDeferred(threadId: string, deferred: boolean): void {
    if (deferred) {
      this.#database
        .prepare(`
          INSERT OR IGNORE INTO goal_continuation_deferrals (thread_id)
          SELECT thread_id FROM thread_goals WHERE thread_id = ?
        `)
        .run(threadId)
    } else {
      this.#database
        .prepare("DELETE FROM goal_continuation_deferrals WHERE thread_id = ?")
        .run(threadId)
    }
  }

  fork(
    sourceThreadId: string,
    targetThreadId: string,
    now: string,
  ): ThreadGoal | undefined {
    requireText(targetThreadId, "targetThreadId")
    requireTimestamp(now, "now")
    if (sourceThreadId === targetThreadId) {
      throw new Error("A goal cannot be forked onto its own thread.")
    }
    this.#database.exec("BEGIN IMMEDIATE")
    try {
      const source = this.read(sourceThreadId)
      if (source === undefined) {
        this.#database.exec("COMMIT")
        return undefined
      }
      const goal = {
        ...source,
        id: createGoalId(),
        threadId: targetThreadId,
        createdAt: now,
        updatedAt: now,
      }
      this.delete(targetThreadId)
      this.#writeGoal(goal)
      // An inherited active snapshot must wait for deliberate work on the fork.
      this.setContinuationDeferred(targetThreadId, true)
      this.#database.exec("COMMIT")
      return goal
    } catch (error) {
      this.#database.exec("ROLLBACK")
      throw error
    }
  }

  account(
    threadId: string,
    goalId: string,
    eventId: string,
    tokens: number,
    seconds: number,
    now: string,
  ): ThreadGoal | undefined {
    requireText(eventId, "eventId")
    requireNonnegativeInteger(tokens, "tokens")
    requireNonnegativeInteger(seconds, "seconds")
    requireTimestamp(now, "now")
    this.#database.exec("BEGIN IMMEDIATE")
    try {
      const goal = this.read(threadId)
      if (goal === undefined || goal.id !== goalId) {
        this.#database.exec("COMMIT")
        return undefined
      }
      // Budget-limited turns still spend tokens while wrapping up. Other stopped
      // goals are flushed by the runtime before changing their status.
      if (
        goal.status !== GoalStatus.Active &&
        goal.status !== GoalStatus.BudgetLimited
      ) {
        this.#database.exec("COMMIT")
        return goal
      }
      const receipt = this.#database
        .prepare(
          "INSERT OR IGNORE INTO goal_usage_receipts (goal_id, event_id) VALUES (?, ?)",
        )
        .run(goalId, eventId)
      if (receipt.changes > 0) {
        const tokensUsed = goal.tokensUsed + tokens
        const timeUsedSeconds = goal.timeUsedSeconds + seconds
        requireNonnegativeInteger(tokensUsed, "tokensUsed")
        requireNonnegativeInteger(timeUsedSeconds, "timeUsedSeconds")
        const status =
          goal.tokenBudget !== undefined && tokensUsed >= goal.tokenBudget
            ? GoalStatus.BudgetLimited
            : goal.status
        this.#database
          .prepare(`
            UPDATE thread_goals
            SET tokens_used = ?, time_used_seconds = ?, status = ?, updated_at = ?
            WHERE thread_id = ? AND id = ?
          `)
          .run(tokensUsed, timeUsedSeconds, status, now, threadId, goalId)
      }
      const updated = this.read(threadId)
      this.#database.exec("COMMIT")
      return updated
    } catch (error) {
      this.#database.exec("ROLLBACK")
      throw error
    }
  }

  close(): void {
    if (this.#database.isOpen) this.#database.close()
  }

  #writeGoal(goal: ThreadGoal): void {
    this.#database
      .prepare(`
      INSERT INTO thread_goals (
        thread_id, id, objective, status, token_budget,
        tokens_used, time_used_seconds, created_at, updated_at, input_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (thread_id) DO UPDATE SET
        objective = excluded.objective, status = excluded.status,
        token_budget = excluded.token_budget, tokens_used = excluded.tokens_used,
        time_used_seconds = excluded.time_used_seconds,
        created_at = excluded.created_at, updated_at = excluded.updated_at,
        input_id = excluded.input_id
    `)
      .run(
        goal.threadId,
        goal.id,
        goal.objective,
        goal.status,
        goal.tokenBudget ?? null,
        goal.tokensUsed,
        goal.timeUsedSeconds,
        goal.createdAt,
        goal.updatedAt,
        goal.inputId ?? null,
      )
  }
}

function requireGoal(goal: ThreadGoal): void {
  requireText(goal.id, "id")
  requireText(goal.threadId, "threadId")
  requireText(goal.objective, "objective")
  if (!isGoalStatus(goal.status)) throw new Error("Invalid goal status.")
  if (goal.tokenBudget !== undefined) {
    requireNonnegativeInteger(goal.tokenBudget, "tokenBudget")
    if (goal.tokenBudget === 0) throw new Error("tokenBudget must be positive.")
  }
  requireNonnegativeInteger(goal.tokensUsed, "tokensUsed")
  requireNonnegativeInteger(goal.timeUsedSeconds, "timeUsedSeconds")
  requireTimestamp(goal.createdAt, "createdAt")
  requireTimestamp(goal.updatedAt, "updatedAt")
  if (goal.inputId !== undefined) requireText(goal.inputId, "inputId")
}

function requireText(value: string, name: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must not be empty.`)
  }
}

function requireNonnegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`)
  }
}

function requireTimestamp(value: string, name: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be a timestamp.`)
  }
}
