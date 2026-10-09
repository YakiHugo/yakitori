import type { QueuedInput } from "../protocol/input-queue.ts"

export type { QueuedInput } from "../protocol/input-queue.ts"

import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { TurnInput } from "../core/session-io.ts"
import { readStoredInputContent } from "../core/user-input.ts"
import { createInputId } from "../kernel/ids.ts"

export const MAX_QUEUED_ITEMS = 100

export class InputQueueFullError extends Error {
  constructor() {
    super(`Queue cannot hold more than ${MAX_QUEUED_ITEMS} inputs.`)
  }
}

type QueueRow = Readonly<{
  id: string
  session_id: string
  input_json: string
  created_at: string
}>

// The queue is an editable resource. A queued message has not entered the
// conversation rollout; the rollout records it only when a Turn starts.
export class InputQueue {
  readonly #database: DatabaseSync
  readonly sharedAcrossConnections: boolean

  constructor(databasePath = ":memory:") {
    this.sharedAcrossConnections = databasePath !== ":memory:"
    if (databasePath !== ":memory:")
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
    this.#database = new DatabaseSync(databasePath, {
      timeout: 5_000,
      enableDoubleQuotedStringLiterals: false,
    })
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS input_queue (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        input_json TEXT NOT NULL,
        queue_order INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS input_queue_order
        ON input_queue(session_id, queue_order);
      CREATE TABLE IF NOT EXISTS input_queue_revisions (
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE
      );
      INSERT OR IGNORE INTO input_queue_revisions (session_id)
        SELECT DISTINCT session_id FROM input_queue ORDER BY session_id;
      CREATE TRIGGER IF NOT EXISTS input_queue_revision_after_insert
      AFTER INSERT ON input_queue BEGIN
        INSERT INTO input_queue_revisions (session_id) VALUES (NEW.session_id)
        ON CONFLICT(session_id) DO UPDATE SET revision =
          (SELECT COALESCE(MAX(revision), 0) + 1 FROM input_queue_revisions);
      END;
      CREATE TRIGGER IF NOT EXISTS input_queue_revision_after_update
      AFTER UPDATE ON input_queue BEGIN
        INSERT INTO input_queue_revisions (session_id) VALUES (NEW.session_id)
        ON CONFLICT(session_id) DO UPDATE SET revision =
          (SELECT COALESCE(MAX(revision), 0) + 1 FROM input_queue_revisions);
      END;
      CREATE TRIGGER IF NOT EXISTS input_queue_revision_after_delete
      AFTER DELETE ON input_queue BEGIN
        INSERT INTO input_queue_revisions (session_id) VALUES (OLD.session_id)
        ON CONFLICT(session_id) DO UPDATE SET revision =
          (SELECT COALESCE(MAX(revision), 0) + 1 FROM input_queue_revisions);
      END;
    `)
  }

  changeVersion(): number {
    const row = this.#database.prepare("PRAGMA data_version").get() as {
      data_version: number
    }
    return row.data_version
  }

  changesSince(
    revision: number,
    loadedSessionIds: readonly string[],
  ): readonly { sessionId: string; revision: number }[] {
    if (loadedSessionIds.length === 0) return []
    const placeholders = loadedSessionIds.map(() => "?").join(", ")
    const rows = this.#database
      .prepare(
        `SELECT session_id AS sessionId, revision FROM input_queue_revisions
         WHERE revision > ? AND session_id IN (${placeholders})
         ORDER BY revision`,
      )
      .all(revision, ...loadedSessionIds) as {
      sessionId: string
      revision: number
    }[]
    return rows
  }

  list(sessionId: string): readonly QueuedInput[] {
    const rows = this.#database
      .prepare(`SELECT id, session_id, input_json, created_at FROM input_queue
        WHERE session_id = ? ORDER BY queue_order, id`)
      .all(sessionId) as unknown as QueueRow[]
    return rows.map(fromRow)
  }

  get(sessionId: string, id: string): QueuedInput | undefined {
    const row = this.#database
      .prepare(`SELECT id, session_id, input_json, created_at FROM input_queue
        WHERE session_id = ? AND id = ?`)
      .get(sessionId, id) as QueueRow | undefined
    return row === undefined ? undefined : fromRow(row)
  }

  getByRequest(sessionId: string, requestId: string): QueuedInput | undefined {
    const row = this.#database
      .prepare(`SELECT id, session_id, input_json, created_at FROM input_queue
        WHERE session_id = ? AND request_id = ?`)
      .get(sessionId, requestId) as QueueRow | undefined
    return row === undefined ? undefined : fromRow(row)
  }

  enqueue(sessionId: string, input: TurnInput): QueuedInput {
    const existing = this.getByRequest(sessionId, input.submissionId)
    if (existing !== undefined) {
      if (JSON.stringify(existing.input) !== JSON.stringify(input))
        throw new Error("Queued request conflicts with its original input.")
      return existing
    }
    const item: QueuedInput = {
      id: createInputId(),
      sessionId,
      input: structuredClone(input),
      createdAt: new Date().toISOString(),
    }
    const inserted = this.#database
      .prepare(`INSERT INTO input_queue
        (id, session_id, request_id, input_json, queue_order, created_at)
        SELECT ?, ?, ?, ?, COALESCE(
          (SELECT MAX(queue_order) + 1 FROM input_queue WHERE session_id = ?), 0
        ), ? WHERE
          (SELECT COUNT(*) FROM input_queue WHERE session_id = ?) < ?`)
      .run(
        item.id,
        sessionId,
        input.submissionId,
        JSON.stringify(input),
        sessionId,
        item.createdAt,
        sessionId,
        MAX_QUEUED_ITEMS,
      )
    if (inserted.changes === 0) throw new InputQueueFullError()
    return item
  }

  update(
    sessionId: string,
    id: string,
    input: TurnInput,
  ): QueuedInput | undefined {
    const existing = this.get(sessionId, id)
    if (existing === undefined) return undefined
    this.#database
      .prepare(
        "UPDATE input_queue SET request_id = ?, input_json = ? WHERE session_id = ? AND id = ?",
      )
      .run(input.submissionId, JSON.stringify(input), sessionId, id)
    return { ...existing, input: structuredClone(input) }
  }

  delete(sessionId: string, id: string): boolean {
    return (
      this.#database
        .prepare("DELETE FROM input_queue WHERE session_id = ? AND id = ?")
        .run(sessionId, id).changes > 0
    )
  }

  deleteSession(sessionId: string): void {
    this.#database
      .prepare("DELETE FROM input_queue WHERE session_id = ?")
      .run(sessionId)
  }

  reorder(sessionId: string, orderedIds: readonly string[]): void {
    const current = this.list(sessionId).map((item) => item.id)
    if (
      current.length !== orderedIds.length ||
      new Set(orderedIds).size !== current.length ||
      orderedIds.some((id) => !current.includes(id))
    ) {
      throw new Error("Reorder must include every queued input exactly once.")
    }
    this.#database.exec("BEGIN IMMEDIATE")
    try {
      const update = this.#database.prepare(
        "UPDATE input_queue SET queue_order = ? WHERE session_id = ? AND id = ?",
      )
      orderedIds.forEach((id, index) => {
        update.run(index, sessionId, id)
      })
      this.#database.exec("COMMIT")
    } catch (error) {
      this.#database.exec("ROLLBACK")
      throw error
    }
  }

  close(): void {
    this.#database.close()
  }
}

function fromRow(row: QueueRow): QueuedInput {
  const input = JSON.parse(row.input_json) as TurnInput
  return {
    id: row.id,
    sessionId: row.session_id,
    input: { ...input, content: readStoredInputContent(input.content) },
    createdAt: row.created_at,
  }
}
