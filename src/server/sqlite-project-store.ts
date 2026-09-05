import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { createYakitoriError, YakitoriErrorCode } from "../kernel/errors.ts"

// First-class Project entity store (C8-D2, Codex convergence): the entity
// carries server-assigned identity, naming, an opaque metadata bag, and manual
// ordering — what cwd-derived grouping cannot express. Timestamps are integer
// milliseconds; this deliberately diverges from Codex's app-server wire, which
// exposes Unix seconds, because every other Yakitori API timestamp is ms.

export type Project = {
  readonly id: string
  readonly name: string
  readonly roots: readonly string[]
  readonly metadata: Readonly<Record<string, string>>
  readonly position: number
  readonly createdAt: number
  readonly updatedAt: number
}

export type ProjectListInput = Readonly<{
  cursor?: string
  limit?: number
}>

export type ProjectListResult = Readonly<{
  readonly projects: readonly Project[]
  readonly nextCursor?: string
}>

export type CreateProjectInput = Readonly<{
  readonly name: string
  readonly roots: readonly string[]
  readonly metadata?: Readonly<Record<string, string>>
  readonly idempotencyKey?: string
}>

export type CreatedProject = Readonly<{
  readonly project: Project
  readonly created: boolean
}>

export type UpdateProjectInput = Readonly<{
  readonly name?: string
  readonly metadata?: Readonly<Record<string, string>>
}>

export type UpdatedProject = Readonly<{
  readonly project: Project
  readonly changed: boolean
}>

export const ProjectMoveOutcome = {
  Moved: "moved",
  Unchanged: "unchanged",
} as const

export type ProjectMoveOutcome =
  (typeof ProjectMoveOutcome)[keyof typeof ProjectMoveOutcome]

export type ProjectStore = {
  listProjects(input?: ProjectListInput): Promise<ProjectListResult>
  readProject(projectId: string): Promise<Project | undefined>
  createProject(input: CreateProjectInput): Promise<CreatedProject>
  updateProject(
    projectId: string,
    input: UpdateProjectInput,
  ): Promise<UpdatedProject | undefined>
  moveProject(
    projectId: string,
    toPosition: number,
  ): Promise<ProjectMoveOutcome | undefined>
  deleteProject(projectId: string): Promise<boolean>
}

export type SqliteProjectStore = ProjectStore & Readonly<{ close(): void }>

export type SqliteProjectStoreOptions = Readonly<{
  databasePath?: string
  rootDir?: string
}>

// Cursor parse failures map to ApiErrorCode.InvalidCursor at the RPC boundary;
// the store has no ApiErrorCode dependency, so this is a dedicated class.
export class InvalidProjectCursorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidProjectCursorError"
  }
}

export function createProjectId(): string {
  return `project_${globalThis.crypto.randomUUID()}`
}

export function isGeneratedProjectId(value: string): boolean {
  return /^project_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  )
}

type ProjectRow = {
  readonly id: string
  readonly name: string
  readonly metadata: string
  readonly position: number
  readonly created_at_ms: number
  readonly updated_at_ms: number
}

type RootRow = { readonly path: string }

const defaultListLimit = 50
const maxListLimit = 100

export function createSqliteProjectStore(
  options: SqliteProjectStoreOptions = {},
): SqliteProjectStore {
  const databasePath =
    options.databasePath ??
    join(options.rootDir ?? ".yakitori", "projects.sqlite")
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true })
  }
  const database = new DatabaseSync(databasePath)
  initializeDatabase(database)

  return {
    async listProjects(input = {}) {
      const limit = requireListLimit(input.limit)
      const anchor =
        input.cursor === undefined ? undefined : parseListCursor(input.cursor)
      const rows = (
        anchor === undefined
          ? database
              .prepare(`
                SELECT id, name, metadata, position, created_at_ms, updated_at_ms
                FROM projects
                ORDER BY position ASC, id ASC
                LIMIT ?
              `)
              .all(limit + 1)
          : database
              .prepare(`
                SELECT id, name, metadata, position, created_at_ms, updated_at_ms
                FROM projects
                WHERE position > ?
                   OR (position = ? AND id > ?)
                ORDER BY position ASC, id ASC
                LIMIT ?
              `)
              .all(anchor.position, anchor.position, anchor.id, limit + 1)
      ) as ProjectRow[]
      const page = rows.slice(0, limit)
      const projects = page.map((row) => readProjectRow(database, row))
      const last = page.at(-1)
      return {
        projects,
        ...(rows.length <= limit || last === undefined
          ? {}
          : { nextCursor: encodeListCursor(last) }),
      }
    },

    async readProject(projectId) {
      requireProjectId(projectId)
      const row = database
        .prepare(`
          SELECT id, name, metadata, position, created_at_ms, updated_at_ms
          FROM projects
          WHERE id = ?
        `)
        .get(projectId) as ProjectRow | undefined
      return row === undefined ? undefined : readProjectRow(database, row)
    },

    async createProject(input) {
      requireProjectName(input.name)
      const roots = requireProjectRoots(input.roots)
      const metadata = input.metadata ?? {}
      const idempotencyKey =
        input.idempotencyKey === undefined
          ? undefined
          : requireIdempotencyKey(input.idempotencyKey)
      database.exec("BEGIN IMMEDIATE")
      try {
        if (idempotencyKey !== undefined) {
          const existing = database
            .prepare(
              "SELECT project_id FROM project_idempotency_keys WHERE key = ?",
            )
            .get(idempotencyKey) as { readonly project_id: string } | undefined
          if (existing !== undefined) {
            const row = readProjectRowById(database, existing.project_id)
            if (row === undefined) {
              // The key table deliberately has no ON DELETE CASCADE: a repeated
              // create must be able to report that its key referred to a
              // deleted project instead of silently creating a new one.
              throw createYakitoriError({
                code: YakitoriErrorCode.InvalidState,
                message: `idempotency key refers to deleted project: ${idempotencyKey}`,
                details: { idempotencyKey },
              })
            }
            database.exec("COMMIT")
            return { project: row, created: false }
          }
        }
        const id = createProjectId()
        const now = Date.now()
        const position = nextPosition(database)
        database
          .prepare(`
            INSERT INTO projects (id, name, metadata, position, created_at_ms, updated_at_ms)
            VALUES (?, ?, ?, ?, ?, ?)
          `)
          .run(id, input.name, JSON.stringify(metadata), position, now, now)
        for (const [rootPosition, path] of roots.entries()) {
          database
            .prepare(
              "INSERT INTO project_roots (project_id, position, path) VALUES (?, ?, ?)",
            )
            .run(id, rootPosition, path)
        }
        if (idempotencyKey !== undefined) {
          database
            .prepare(
              "INSERT INTO project_idempotency_keys (key, project_id, created_at_ms) VALUES (?, ?, ?)",
            )
            .run(idempotencyKey, id, now)
        }
        database.exec("COMMIT")
        const project = readProjectRowById(database, id)
        if (project === undefined) {
          throw new Error(`Created project ${id} was not readable.`)
        }
        return { project, created: true }
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK")
        throw error
      }
    },

    async updateProject(projectId, input) {
      requireProjectId(projectId)
      if (input.name !== undefined) requireProjectName(input.name)
      database.exec("BEGIN IMMEDIATE")
      try {
        const current = readProjectRowById(database, projectId)
        if (current === undefined) {
          database.exec("ROLLBACK")
          return undefined
        }
        const name = input.name ?? current.name
        const metadata = input.metadata ?? current.metadata
        if (name === current.name && sameMetadata(metadata, current.metadata)) {
          database.exec("ROLLBACK")
          return { project: current, changed: false }
        }
        const now = Date.now()
        database
          .prepare(
            "UPDATE projects SET name = ?, metadata = ?, updated_at_ms = ? WHERE id = ?",
          )
          .run(name, JSON.stringify(metadata), now, projectId)
        database.exec("COMMIT")
        return {
          project: { ...current, name, metadata, updatedAt: now },
          changed: true,
        }
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK")
        throw error
      }
    },

    async moveProject(projectId, toPosition) {
      requireProjectId(projectId)
      if (!Number.isInteger(toPosition) || toPosition < 0) {
        throw createYakitoriError({
          code: YakitoriErrorCode.InvalidArgument,
          message: "toPosition must be a non-negative integer.",
          details: { toPosition },
        })
      }
      database.exec("BEGIN IMMEDIATE")
      try {
        const orderedIds = (
          database
            .prepare("SELECT id FROM projects ORDER BY position ASC, id ASC")
            .all() as { readonly id: string }[]
        ).map((row) => row.id)
        const from = orderedIds.indexOf(projectId)
        if (from === -1) {
          database.exec("ROLLBACK")
          return undefined
        }
        if (toPosition >= orderedIds.length) {
          throw createYakitoriError({
            code: YakitoriErrorCode.InvalidArgument,
            message: `toPosition ${toPosition} is outside the project list.`,
            details: { toPosition, projectCount: orderedIds.length },
          })
        }
        orderedIds.splice(from, 1)
        orderedIds.splice(toPosition, 0, projectId)
        if (from === toPosition) {
          database.exec("ROLLBACK")
          return ProjectMoveOutcome.Unchanged
        }
        for (const [position, id] of orderedIds.entries()) {
          database
            .prepare("UPDATE projects SET position = ? WHERE id = ?")
            .run(position, id)
        }
        database
          .prepare("UPDATE projects SET updated_at_ms = ? WHERE id = ?")
          .run(Date.now(), projectId)
        database.exec("COMMIT")
        return ProjectMoveOutcome.Moved
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK")
        throw error
      }
    },

    async deleteProject(projectId) {
      requireProjectId(projectId)
      // Roots cascade; idempotency keys survive by design (see createProject).
      const result = database
        .prepare("DELETE FROM projects WHERE id = ?")
        .run(projectId)
      return result.changes > 0
    },

    close() {
      if (database.isOpen) database.close()
    },
  }
}

function initializeDatabase(database: DatabaseSync): void {
  try {
    database.exec("PRAGMA journal_mode = WAL")
    database.exec("PRAGMA synchronous = FULL")
    database.exec("PRAGMA busy_timeout = 5000")
    database.exec("PRAGMA foreign_keys = ON")
    database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        metadata TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS project_roots (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        path TEXT NOT NULL,
        PRIMARY KEY (project_id, position)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS project_idempotency_keys (
        key TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS projects_position
      ON projects (position ASC, id ASC);
    `)
    const enableDefensive = Reflect.get(database, "enableDefensive")
    if (typeof enableDefensive === "function") {
      Reflect.apply(enableDefensive, database, [true])
    }
  } catch (error) {
    if (database.isOpen) database.close()
    throw error
  }
}

function readProjectRowById(
  database: DatabaseSync,
  projectId: string,
): Project | undefined {
  const row = database
    .prepare(`
      SELECT id, name, metadata, position, created_at_ms, updated_at_ms
      FROM projects
      WHERE id = ?
    `)
    .get(projectId) as ProjectRow | undefined
  return row === undefined ? undefined : readProjectRow(database, row)
}

function readProjectRow(database: DatabaseSync, row: ProjectRow): Project {
  const roots = (
    database
      .prepare(
        "SELECT path FROM project_roots WHERE project_id = ? ORDER BY position ASC",
      )
      .all(row.id) as RootRow[]
  ).map((root) => root.path)
  return {
    id: row.id,
    name: row.name,
    roots,
    metadata: parseMetadata(row.metadata, row.id),
    position: row.position,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
  }
}

function parseMetadata(
  serialized: string,
  projectId: string,
): Record<string, string> {
  const parsed: unknown = JSON.parse(serialized)
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Object.values(parsed).every((value) => typeof value === "string")
  ) {
    return parsed as Record<string, string>
  }
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidEventLog,
    message: "Stored project metadata is not a string map.",
    details: { projectId },
  })
}

function nextPosition(database: DatabaseSync): number {
  const row = database
    .prepare("SELECT MAX(position) AS position FROM projects")
    .get() as { readonly position: number | null }
  return (row.position ?? -1) + 1
}

// Keyset cursor over the (position, id) order: "<position>|<id>", strictly
// parsed so a malformed or non-canonical cursor never silently re-anchors.
function encodeListCursor(row: ProjectRow): string {
  return `${row.position}|${row.id}`
}

function parseListCursor(cursor: string): {
  readonly position: number
  readonly id: string
} {
  const invalid = (): InvalidProjectCursorError =>
    new InvalidProjectCursorError("Project list cursor is invalid.")
  if (cursor.length > 128) throw invalid()
  const parts = cursor.split("|")
  if (parts.length !== 2) throw invalid()
  const [rawPosition, id] = parts as [string, string]
  if (!/^(0|[1-9][0-9]*)$/.test(rawPosition)) throw invalid()
  const position = Number(rawPosition)
  if (!Number.isSafeInteger(position) || !isGeneratedProjectId(id)) {
    throw invalid()
  }
  return { position, id }
}

function requireListLimit(limit: number | undefined): number {
  if (limit === undefined) return defaultListLimit
  if (Number.isInteger(limit) && limit > 0 && limit <= maxListLimit) {
    return limit
  }
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidArgument,
    message: `Project list limit must be an integer from 1 to ${maxListLimit}.`,
    details: { limit: limit ?? null },
  })
}

function requireProjectId(projectId: string): void {
  if (isGeneratedProjectId(projectId)) return
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidArgument,
    message: "Project id is invalid.",
    details: { projectId },
  })
}

function requireProjectName(name: string): void {
  if (name.trim().length > 0) return
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidArgument,
    message: "Project name must not be empty.",
  })
}

function requireProjectRoots(roots: readonly string[]): readonly string[] {
  if (roots.length === 0) {
    throw createYakitoriError({
      code: YakitoriErrorCode.InvalidArgument,
      message: "A project requires at least one root.",
    })
  }
  return roots
}

function requireIdempotencyKey(key: string): string {
  if (key.trim().length > 0 && key.length <= 512) return key
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidArgument,
    message: "idempotencyKey must be non-empty and at most 512 bytes.",
  })
}

function sameMetadata(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => right[key] === left[key])
  )
}
