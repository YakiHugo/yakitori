import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { isYakitoriError } from "../../src/kernel/errors.ts"
import {
  createSqliteProjectStore,
  InvalidProjectCursorError,
  ProjectMoveOutcome,
  type SqliteProjectStore,
} from "../../src/server/sqlite-project-store.ts"

function memoryStore(): SqliteProjectStore {
  return createSqliteProjectStore({ databasePath: ":memory:" })
}

describe("sqlite project store", () => {
  it("creates, reads, and lists projects in position order", async () => {
    const store = memoryStore()
    try {
      const first = await store.createProject({
        name: "alpha",
        roots: ["/p/a"],
        metadata: { tier: "one" },
      })
      const second = await store.createProject({
        name: "beta",
        roots: ["/p/b", "/p/b2"],
      })

      expect(first.created).toBe(true)
      expect(first.project.id).toMatch(/^project_/)
      expect(first.project).toMatchObject({
        name: "alpha",
        roots: ["/p/a"],
        metadata: { tier: "one" },
        position: 0,
      })
      expect(first.project.createdAt).toBeGreaterThan(0)
      expect(first.project.updatedAt).toBe(first.project.createdAt)
      expect(second.project.position).toBe(1)

      expect(await store.readProject(first.project.id)).toEqual(first.project)
      expect(await store.readProject(second.project.id)).toEqual(second.project)

      const page = await store.listProjects()
      expect(page.nextCursor).toBeUndefined()
      expect(page.projects).toEqual([first.project, second.project])
    } finally {
      store.close()
    }
  })

  it("returns an existing project for a repeated idempotency key", async () => {
    const store = memoryStore()
    try {
      const created = await store.createProject({
        name: "alpha",
        roots: ["/p/a"],
        idempotencyKey: "key-1",
      })
      const replayed = await store.createProject({
        name: "renamed",
        roots: ["/p/other"],
        idempotencyKey: "key-1",
      })

      expect(replayed.created).toBe(false)
      expect(replayed.project).toEqual(created.project)
      expect((await store.listProjects()).projects).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it("reports an idempotency key that refers to a deleted project", async () => {
    const store = memoryStore()
    try {
      const created = await store.createProject({
        name: "alpha",
        roots: ["/p/a"],
        idempotencyKey: "key-1",
      })
      expect(await store.deleteProject(created.project.id)).toBe(true)

      const error = await store
        .createProject({
          name: "beta",
          roots: ["/p/b"],
          idempotencyKey: "key-1",
        })
        .catch((caught: unknown) => caught)
      expect(isYakitoriError(error) && error.code === "invalid_state").toBe(
        true,
      )
      expect((error as Error).message).toContain(
        "idempotency key refers to deleted project",
      )
      expect((await store.listProjects()).projects).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it("detects no-op updates and bumps updatedAt only on changes", async () => {
    const store = memoryStore()
    try {
      const created = await store.createProject({
        name: "alpha",
        roots: ["/p/a"],
        metadata: { tier: "one" },
      })

      const noop = await store.updateProject(created.project.id, {
        name: "alpha",
        metadata: { tier: "one" },
      })
      expect(noop).toEqual({ project: created.project, changed: false })

      const renamed = await store.updateProject(created.project.id, {
        name: "renamed",
      })
      expect(renamed?.changed).toBe(true)
      expect(renamed?.project.name).toBe("renamed")
      expect(renamed?.project.metadata).toEqual({ tier: "one" })
      expect(renamed?.project.updatedAt).toBeGreaterThanOrEqual(
        created.project.updatedAt,
      )

      expect(
        await store.updateProject(
          "project_00000000-0000-0000-0000-000000000000",
          { name: "x" },
        ),
      ).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it("moves projects with dense renumbering", async () => {
    const store = memoryStore()
    try {
      const ids: string[] = []
      for (const name of ["a", "b", "c"]) {
        const created = await store.createProject({
          name,
          roots: [`/p/${name}`],
        })
        ids.push(created.project.id)
      }
      const [a, b, c] = ids as [string, string, string]

      expect(await store.moveProject(c, 0)).toBe(ProjectMoveOutcome.Moved)
      const page = await store.listProjects()
      expect(page.projects.map((project) => project.id)).toEqual([c, a, b])
      expect(page.projects.map((project) => project.position)).toEqual([
        0, 1, 2,
      ])

      expect(await store.moveProject(c, 0)).toBe(ProjectMoveOutcome.Unchanged)
      expect(
        await store.moveProject(
          "project_00000000-0000-0000-0000-000000000000",
          0,
        ),
      ).toBeUndefined()

      const error = await store
        .moveProject(a, 5)
        .catch((caught: unknown) => caught)
      expect(isYakitoriError(error) && error.code === "invalid_argument").toBe(
        true,
      )
    } finally {
      store.close()
    }
  })

  it("cascades roots on delete while idempotency keys survive", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "yakitori-projects-"))
    try {
      const databasePath = join(rootDir, "projects.sqlite")
      const store = createSqliteProjectStore({ databasePath })
      const created = await store.createProject({
        name: "alpha",
        roots: ["/p/a", "/p/b"],
        idempotencyKey: "key-1",
      })
      expect(await store.deleteProject(created.project.id)).toBe(true)
      store.close()

      const database = new DatabaseSync(databasePath)
      try {
        expect(
          database.prepare("SELECT COUNT(*) AS count FROM projects").get(),
        ).toMatchObject({ count: 0 })
        expect(
          database.prepare("SELECT COUNT(*) AS count FROM project_roots").get(),
        ).toMatchObject({ count: 0 })
        expect(
          database
            .prepare(
              "SELECT project_id FROM project_idempotency_keys WHERE key = 'key-1'",
            )
            .get(),
        ).toMatchObject({ project_id: created.project.id })
      } finally {
        database.close()
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("paginates with a strict position|id keyset cursor", async () => {
    const store = memoryStore()
    try {
      for (const name of ["a", "b", "c"]) {
        await store.createProject({ name, roots: [`/p/${name}`] })
      }

      const first = await store.listProjects({ limit: 2 })
      expect(first.projects.map((project) => project.name)).toEqual(["a", "b"])
      expect(first.nextCursor).toBe(`1|${first.projects[1]?.id}`)

      const second = await store.listProjects({
        limit: 2,
        ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
      })
      expect(second.projects.map((project) => project.name)).toEqual(["c"])
      expect(second.nextCursor).toBeUndefined()

      for (const cursor of [
        "bogus",
        "1",
        "1|nope",
        `01|${first.projects[1]?.id}`,
        `-1|${first.projects[1]?.id}`,
        `1|${first.projects[1]?.id}|extra`,
      ]) {
        await expect(store.listProjects({ cursor })).rejects.toBeInstanceOf(
          InvalidProjectCursorError,
        )
      }
    } finally {
      store.close()
    }
  })

  it("rejects invalid create input and malformed ids", async () => {
    const store = memoryStore()
    try {
      await expect(
        store.createProject({ name: "  ", roots: ["/p/a"] }),
      ).rejects.toMatchObject({ code: "invalid_argument" })
      await expect(
        store.createProject({ name: "alpha", roots: [] }),
      ).rejects.toMatchObject({ code: "invalid_argument" })
      await expect(store.readProject("not-a-project")).rejects.toMatchObject({
        code: "invalid_argument",
      })
    } finally {
      store.close()
    }
  })
})
