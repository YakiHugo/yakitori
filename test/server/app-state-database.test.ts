import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it } from "vitest"
import { openAppStateDatabase } from "../../src/server/app-state-database.ts"

const roots: string[] = []
function fixture() {
  const rootDir = mkdtempSync(join(tmpdir(), "yakitori-app-state-"))
  roots.push(rootDir)
  const sessionStoreRoot = join(rootDir, "custom-sessions")
  mkdirSync(sessionStoreRoot)
  return { rootDir, sessionStoreRoot }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true })
})

function seed(path: string, sql: string) {
  const db = new DatabaseSync(path)
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}

it("imports all six stores including WAL rows, receipts, and the queue revision high-water mark", () => {
  const paths = fixture()
  const projects = join(paths.rootDir, "custom-projects.sqlite")
  seed(
    projects,
    `
    CREATE TABLE projects AS SELECT 'p' AS id, 'project' AS name, '{}' AS metadata,
      3 AS position, 1 AS created_at_ms, 2 AS updated_at_ms;
    CREATE TABLE project_roots AS SELECT 'p' AS project_id, 0 AS position, '/original' AS path;
    CREATE TABLE project_idempotency_keys AS SELECT 'once' AS key, 'p' AS project_id, 1 AS created_at_ms;
  `,
  )
  const original = readFileSync(projects)
  seed(
    join(paths.rootDir, "mates.sqlite"),
    `
    CREATE TABLE mate_events AS SELECT 'm' AS mate_id, 1 AS seq, 'event' AS event_id, '{"event":1}' AS envelope_json;
    CREATE TABLE mate_summaries AS SELECT 'm' AS mate_id, '{"rev":1}' AS summary_json;
  `,
  )
  seed(
    join(paths.sessionStoreRoot, "agent-graph.sqlite"),
    `
    CREATE TABLE thread_spawn_edges AS SELECT 'parent' AS parent_thread_id, 'child' AS child_thread_id, 'closed' AS status;
  `,
  )
  seed(
    join(paths.sessionStoreRoot, "thread-goals.sqlite"),
    `
    CREATE TABLE thread_goals AS SELECT 'child' AS thread_id, 'g' AS id, 'save' AS objective, 'paused' AS status,
      7 AS tokens_used, 1 AS time_used_seconds, 'start' AS created_at, 'end' AS updated_at;
    CREATE TABLE goal_usage_receipts AS SELECT 'g' AS goal_id, 'charged' AS event_id;
    CREATE TABLE goal_continuation_deferrals AS SELECT 'child' AS thread_id;
  `,
  )
  seed(
    join(paths.sessionStoreRoot, "input-queue.sqlite"),
    `
    CREATE TABLE input_queue AS SELECT 'q' AS id, 'child' AS session_id, 'r' AS request_id,
      '{}' AS input_json, 7 AS queue_order, 'start' AS created_at;
    CREATE TABLE input_queue_revisions(revision INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT UNIQUE);
    INSERT INTO input_queue_revisions VALUES(17, 'child'),(90,'deleted');
    DELETE FROM input_queue_revisions WHERE revision = 90;
  `,
  )
  using journal = new DatabaseSync(
    join(paths.rootDir, "external-sessions.sqlite"),
  )
  journal.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE external_sessions AS SELECT 's' AS id, 'engine' AS engine_id, '{}' AS data;
    CREATE TABLE external_events AS SELECT 's' AS session_id, 9007199254740993 AS seq, 'observed' AS data;
    CREATE TABLE external_requests AS SELECT 's' AS session_id, 'r' AS request_id, 'accepted' AS data;
  `)
  {
    using db = openAppStateDatabase({ ...paths, projectDatabasePath: projects })
    expect(
      db
        .prepare(
          "SELECT name, pinned, path, key FROM projects JOIN project_roots ON projects.id=project_roots.project_id JOIN project_idempotency_keys ON projects.id=project_idempotency_keys.project_id",
        )
        .get(),
    ).toEqual({ name: "project", pinned: 0, path: "/original", key: "once" })
    expect(
      db
        .prepare(
          "SELECT event_id, envelope_json, summary_json FROM mate_events JOIN mate_summaries USING(mate_id)",
        )
        .get(),
    ).toEqual({
      event_id: "event",
      envelope_json: '{"event":1}',
      summary_json: '{"rev":1}',
    })
    expect(
      db
        .prepare(
          "SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges",
        )
        .get(),
    ).toEqual({
      parent_thread_id: "parent",
      child_thread_id: "child",
      status: "closed",
    })
    expect(
      db
        .prepare(
          "SELECT tokens_used, event_id FROM thread_goals JOIN goal_usage_receipts ON goal_id = id JOIN goal_continuation_deferrals USING(thread_id)",
        )
        .get(),
    ).toEqual({ tokens_used: 7, event_id: "charged" })
    expect(
      db
        .prepare(
          "SELECT id, revision FROM input_queue JOIN input_queue_revisions USING(session_id)",
        )
        .get(),
    ).toEqual({ id: "q", revision: 17 })
    db.exec("INSERT INTO input_queue VALUES('q2','other','new','{}',0,'now')")
    expect(
      db
        .prepare(
          "SELECT revision FROM input_queue_revisions WHERE session_id='other'",
        )
        .get(),
    ).toEqual({ revision: 91 })
    expect(
      db
        .prepare(
          "SELECT engine_id, CAST(seq AS TEXT) AS seq, external_events.data AS event, external_requests.data AS request FROM external_sessions JOIN external_events ON id=session_id JOIN external_requests USING(session_id)",
        )
        .get(),
    ).toEqual({
      engine_id: "engine",
      seq: "9007199254740993",
      event: "observed",
      request: "accepted",
    })
    db.exec("DELETE FROM projects")
  }
  expect(readFileSync(projects)).toEqual(original)
  using reopened = openAppStateDatabase({
    ...paths,
    projectDatabasePath: projects,
  })
  expect(reopened.prepare("SELECT id FROM projects").all()).toEqual([])
})

it("rolls back earlier imports when a later source is invalid and retries from the originals", () => {
  const paths = fixture()
  seed(
    join(paths.sessionStoreRoot, "agent-graph.sqlite"),
    `
    CREATE TABLE thread_spawn_edges AS SELECT 'parent' AS parent_thread_id, 'child' AS child_thread_id, 'open' AS status;
  `,
  )
  const queue = join(paths.sessionStoreRoot, "input-queue.sqlite")
  seed(queue, "CREATE TABLE unexpected(id)")
  expect(() => openAppStateDatabase(paths)).toThrow(/input-queue\.sqlite/)
  {
    using failed = new DatabaseSync(
      join(paths.sessionStoreRoot, "app-state.sqlite"),
      { readOnly: true },
    )
    expect(failed.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 0,
    })
    expect(
      failed.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all(),
    ).toEqual([])
  }
  rmSync(queue)
  using retried = openAppStateDatabase(paths)
  expect(
    retried.prepare("SELECT child_thread_id FROM thread_spawn_edges").all(),
  ).toEqual([{ child_thread_id: "child" }])
  expect(readdirSync(paths.rootDir)).toEqual(["custom-sessions"])
})
