import { randomUUID } from "node:crypto"
import { link, mkdir, open, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"

export type RuntimeLock = {
  readonly path: string
  readonly ownerPid: number
  readonly startedAt: string
  release(): Promise<void>
}

export type RuntimeLockInfo = {
  readonly ownerPid: number
  readonly startedAt: string
  readonly token: string
}

export async function acquireRuntimeLock(
  storeDir: string,
  options: {
    readonly pid?: number
    readonly isProcessAlive?: (pid: number) => boolean
  } = {},
): Promise<RuntimeLock> {
  await mkdir(storeDir, { recursive: true })
  const path = join(storeDir, "runtime.lock")
  const ownerPid = options.pid ?? process.pid
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive
  const startedAt = new Date().toISOString()
  const token = randomUUID()
  const payload = `${ownerPid}\n${startedAt}\n${token}\n`

  for (;;) {
    try {
      await publishRuntimeLock(path, payload, token)
      break
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
    }

    const existing = await readRuntimeLock(path)
    if (!existing) {
      if (!(await pathExists(path))) continue
      throw new Error(
        "Runtime lock is incomplete or invalid; refusing to reclaim a possibly active owner.",
      )
    }
    if (isProcessAlive(existing.ownerPid)) {
      throw new Error(
        `Runtime lock is held by live process ${existing.ownerPid} (started ${existing.startedAt}).`,
      )
    }

    // Stale lock: reclaim after proving the previous owner is dead.
    const confirmed = await readRuntimeLock(path)
    if (confirmed?.token !== existing.token) continue
    await rm(path, { force: true })
  }

  if ((await readRuntimeLock(path))?.token !== token) {
    throw new Error("Runtime lock ownership changed during acquisition.")
  }

  let released = false
  return {
    path,
    ownerPid,
    startedAt,
    async release() {
      if (released) return
      released = true
      const current = await readRuntimeLock(path)
      if (current?.token === token) {
        await rm(path, { force: true })
      }
    },
  }
}

async function readRuntimeLock(
  path: string,
): Promise<RuntimeLockInfo | undefined> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch {
    return undefined
  }
  const [pidText, startedAt, token] = text.split("\n")
  const ownerPid = Number(pidText)
  if (!Number.isInteger(ownerPid) || ownerPid <= 0 || !startedAt || !token) {
    return undefined
  }
  return { ownerPid, startedAt, token }
}

async function publishRuntimeLock(
  path: string,
  payload: string,
  token: string,
): Promise<void> {
  const tempPath = `${path}.${token}.tmp`
  try {
    const handle = await open(tempPath, "wx")
    try {
      await handle.writeFile(payload, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await link(tempPath, path)
  } finally {
    await rm(tempPath, { force: true })
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "EEXIST"
  )
}
