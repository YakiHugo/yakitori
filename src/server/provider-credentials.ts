import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

// GUI credentials are separate from config/read, rollouts and renderer storage.
// Immutable references also let a failed config write leave the old key intact.
export function createProviderCredentialStore(directory: string) {
  return {
    async read(reference: string): Promise<string | undefined> {
      requireReference(reference)
      try {
        return await readFile(join(directory, reference), "utf8")
      } catch (error) {
        if (isMissing(error)) return undefined
        throw error
      }
    },
    async write(key: string): Promise<string> {
      if (key.trim() === "" || /[\r\n]/.test(key))
        throw new Error("API key must be a non-empty single line.")
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const reference = `key_${randomUUID()}`
      const temporary = join(directory, `${reference}.tmp`)
      try {
        await writeFile(temporary, key.trim(), { mode: 0o600, flag: "wx" })
        await rename(temporary, join(directory, reference))
      } finally {
        await unlink(temporary).catch((error: unknown) => {
          if (!isMissing(error)) throw error
        })
      }
      return reference
    },
    async delete(reference: string): Promise<void> {
      requireReference(reference)
      await unlink(join(directory, reference)).catch((error: unknown) => {
        if (!isMissing(error)) throw error
      })
    },
  }
}

function requireReference(reference: string) {
  if (!/^key_[a-zA-Z0-9-]+$/.test(reference))
    throw new Error("Invalid credential reference.")
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  )
}
