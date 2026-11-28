import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import {
  closeSqliteDatabase,
  openReadOnlySqliteDatabase,
  openSqliteDatabase,
} from "../../src/core/sqlite.ts"

it.each([
  ["durable", 2, 0],
  ["projection", 1, 1],
] as const)("configures %s on a file-backed connection", async (profile, synchronous, checkpoint_fullfsync) => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-sqlite-"))
  try {
    const db = openSqliteDatabase(join(root, "nested", "state.sqlite"), {
      profile,
    })
    try {
      expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 })
      for (const [name, expected] of Object.entries({
        journal_mode: "wal",
        synchronous,
        checkpoint_fullfsync,
        foreign_keys: 1,
        journal_size_limit: 134217728,
      })) {
        expect(db.prepare(`PRAGMA ${name}`).get()).toEqual({ [name]: expected })
      }
    } finally {
      closeSqliteDatabase(db)
      closeSqliteDatabase(db)
    }
    expect(db.isOpen).toBe(false)
  } finally {
    await rm(root, { recursive: true })
  }
})

it("reads an existing rollback journal database without changing its mode or granting writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-sqlite-"))
  const path = join(root, "state.sqlite")
  try {
    const seed = new DatabaseSync(path)
    try {
      seed.exec(
        "PRAGMA journal_mode = DELETE; CREATE TABLE items(id INTEGER); INSERT INTO items VALUES(7)",
      )
    } finally {
      seed.close()
    }
    const db = openReadOnlySqliteDatabase(path)
    try {
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "delete",
      })
      expect(db.prepare("SELECT id FROM items").get()).toEqual({ id: 7 })
      expect(() => db.exec("DELETE FROM items")).toThrow(/readonly/i)
    } finally {
      closeSqliteDatabase(db)
    }
  } finally {
    await rm(root, { recursive: true })
  }
})
