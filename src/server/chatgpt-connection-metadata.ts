import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { flock } from "fs-ext"
import { join } from "node:path"
import type { ChatGPTAccountIdentity } from "./chatgpt-credential-store.ts"

export type ChatGPTConnectionRecord = {
  id: string
  label: string
  // Pending registration metadata is never accepted as a verified identity.
  pendingClientId?: string
  identity?: ChatGPTAccountIdentity
  identityOnly?: boolean
  remoteRevocation?: "confirmed" | "unconfirmed"
}
type Document = {
  version: 1
  accounts: ChatGPTConnectionRecord[]
  welcomed: boolean
}

// Atomic metadata updates are serialized across local processes. This file has
// only display/recovery metadata; tokens belong to the credential store.
export function createChatGPTConnectionMetadata(directory: string) {
  const path = join(directory, "connections.json")
  let queue = Promise.resolve()
  async function read(): Promise<Document> {
    let source: string
    try {
      source = await readFile(path, "utf8")
    } catch (error) {
      if (isMissing(error)) return { version: 1, accounts: [], welcomed: false }
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(source)
    } catch {
      throw new Error("ChatGPT connection metadata is invalid.")
    }
    if (
      !record(value) ||
      value.version !== 1 ||
      typeof value.welcomed !== "boolean" ||
      !Array.isArray(value.accounts)
    )
      throw new Error("ChatGPT connection metadata is invalid.")
    const accounts = value.accounts.map((a: unknown) => {
      if (
        !record(a) ||
        typeof a.id !== "string" ||
        !/^connection_[a-z0-9-]+$/.test(a.id) ||
        typeof a.label !== "string" ||
        !a.label.trim() ||
        a.label.length > 80 ||
        (a.pendingClientId !== undefined &&
          (typeof a.pendingClientId !== "string" ||
            !/^oaiapp_[a-zA-Z0-9_-]+$/.test(a.pendingClientId))) ||
        (a.identity !== undefined &&
          (!record(a.identity) ||
            typeof a.identity.clientId !== "string" ||
            !/^oaiapp_[a-zA-Z0-9_-]+$/.test(a.identity.clientId) ||
            typeof a.identity.subject !== "string" ||
            !a.identity.subject)) ||
        (a.identityOnly !== undefined && typeof a.identityOnly !== "boolean") ||
        (a.remoteRevocation !== undefined &&
          a.remoteRevocation !== "confirmed" &&
          a.remoteRevocation !== "unconfirmed")
      )
        throw new Error("ChatGPT connection metadata is invalid.")
      return {
        id: a.id,
        label: a.label,
        ...(a.pendingClientId === undefined
          ? {}
          : { pendingClientId: a.pendingClientId as string }),
        ...(a.identity === undefined
          ? {}
          : {
              identity: {
                clientId: String(
                  (a.identity as Record<string, unknown>).clientId,
                ),
                subject: String(
                  (a.identity as Record<string, unknown>).subject,
                ),
              },
            }),
        ...(a.identityOnly === undefined
          ? {}
          : { identityOnly: a.identityOnly as boolean }),
        ...(a.remoteRevocation === undefined
          ? {}
          : {
              remoteRevocation: a.remoteRevocation as
                | "confirmed"
                | "unconfirmed",
            }),
      }
    })
    if (
      new Set(accounts.map((a) => a.id)).size !== accounts.length ||
      new Set(accounts.map((a) => a.label)).size !== accounts.length
    )
      throw new Error("ChatGPT connection metadata has duplicate accounts.")
    return { version: 1, accounts, welcomed: value.welcomed }
  }
  return {
    async read() {
      await queue
      return read()
    },
    update<T>(change: (document: Document) => T | Promise<T>): Promise<T> {
      const operation = queue.then(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const lock = await open(
          join(directory, "connections.lock"),
          constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
          0o600,
        )
        try {
          const deadline = Date.now() + 30_000 // Local bound for an unresponsive metadata writer.
          for (;;) {
            try {
              await lockFile(lock.fd, "exnb")
              break
            } catch (error) {
              if (
                typeof error !== "object" ||
                error === null ||
                !("code" in error) ||
                !["EAGAIN", "EWOULDBLOCK"].includes(String(error.code))
              )
                throw error
              if (Date.now() >= deadline)
                throw new Error("ChatGPT connection metadata is busy.")
              await new Promise((resolve) => setTimeout(resolve, 10))
            }
          }
          const document = await read()
          const result = await change(document)
          const temporary = join(directory, `.connections-${randomUUID()}`)
          try {
            const file = await open(temporary, "wx", 0o600)
            try {
              await file.writeFile(JSON.stringify(document))
              await file.sync()
            } finally {
              await file.close()
            }
            await rename(temporary, path)
            const parent = await open(
              directory,
              constants.O_RDONLY | constants.O_DIRECTORY,
            )
            try {
              await parent.sync()
            } finally {
              await parent.close()
            }
          } finally {
            await rm(temporary, { force: true })
          }
          return result
        } finally {
          await lock.close() // Closing also releases the advisory lock after failures.
        }
      })
      queue = operation.then(
        () => {},
        () => {},
      )
      return operation
    },
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function isMissing(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  )
}

function lockFile(fd: number, operation: "exnb"): Promise<void> {
  return new Promise((resolve, reject) =>
    flock(fd, operation, (error) => (error ? reject(error) : resolve())),
  )
}
