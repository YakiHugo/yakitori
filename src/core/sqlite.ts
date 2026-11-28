import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

type SqliteProfile = "durable" | "projection"

export function openSqliteDatabase(
  databasePath: string,
  options: { profile: SqliteProfile },
): DatabaseSync {
  if (databasePath !== ":memory:")
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
  return openDatabase(databasePath, options.profile)
}

export function openReadOnlySqliteDatabase(databasePath: string): DatabaseSync {
  return openDatabase(databasePath, "readonly")
}

function openDatabase(
  databasePath: string,
  profile: SqliteProfile | "readonly",
): DatabaseSync {
  const database = new DatabaseSync(databasePath, {
    readOnly: profile === "readonly",
    timeout: 5_000,
    enableDoubleQuotedStringLiterals: false,
  })
  try {
    database.enableDefensive?.(true)
    if (profile !== "readonly") {
      // Bound the retained journal after checkpoint/reset to 128 MiB.
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        PRAGMA journal_size_limit = 134217728;
      `)
      database.exec(
        profile === "durable"
          ? "PRAGMA synchronous = FULL"
          : "PRAGMA synchronous = NORMAL; PRAGMA checkpoint_fullfsync = ON",
      )
    }
    return database
  } catch (error) {
    closeSqliteDatabase(database)
    throw error
  }
}

export function closeSqliteDatabase(database: DatabaseSync): void {
  if (database.isOpen) database.close()
}
