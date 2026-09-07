import { randomUUID } from "node:crypto"
import { mkdir, open, readFile } from "node:fs/promises"
import { join } from "node:path"
import { flock } from "fs-ext"

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
  options: { readonly pid?: number } = {},
): Promise<RuntimeLock> {
  await mkdir(storeDir, { recursive: true })
  const path = join(storeDir, "runtime.lock")
  const ownerPid = options.pid ?? process.pid
  const startedAt = new Date().toISOString()
  const token = randomUUID()
  const file = await open(path, "a+", 0o600)

  try {
    await flockPromise(file.fd, "exnb")
  } catch (error) {
    await file.close()
    if (!isLockConflict(error)) throw error
    const existing = await readRuntimeLock(path)
    throw new Error(
      existing === undefined
        ? "Runtime lock is held by another live process."
        : `Runtime lock is held by live process ${existing.ownerPid} (started ${existing.startedAt}).`,
    )
  }

  try {
    await file.truncate(0)
    await file.writeFile(`${ownerPid}\n${startedAt}\n${token}\n`, "utf8")
    await file.sync()
  } catch (error) {
    try {
      await flockPromise(file.fd, "un")
    } finally {
      await file.close()
    }
    throw error
  }

  let released = false
  return {
    path,
    ownerPid,
    startedAt,
    async release() {
      if (released) return
      released = true
      try {
        await flockPromise(file.fd, "un")
      } finally {
        await file.close()
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

function flockPromise(
  fileDescriptor: number,
  operation: "exnb" | "un",
): Promise<void> {
  return new Promise((resolve, reject) => {
    flock(fileDescriptor, operation, (error) => {
      if (error === null) resolve()
      else reject(error)
    })
  })
}

function isLockConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "EAGAIN" ||
      (error as NodeJS.ErrnoException).code === "EWOULDBLOCK")
  )
}
