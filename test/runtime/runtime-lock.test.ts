import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { acquireRuntimeLock } from "../../src/runtime/runtime-lock.ts"

describe("runtime lock", () => {
  it("uses the held OS lock as the ownership authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-runtime-lock-"))
    try {
      const first = await acquireRuntimeLock(root, { pid: 101 })
      await expect(acquireRuntimeLock(root, { pid: 202 })).rejects.toThrow(
        "held by live process 101",
      )

      await first.release()
      const second = await acquireRuntimeLock(root, { pid: 202 })
      expect(await readFile(second.path, "utf8")).toMatch(/^202\n/)
      await first.release()
      await expect(acquireRuntimeLock(root, { pid: 303 })).rejects.toThrow(
        "held by live process 202",
      )
      await second.release()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reuses an unlocked stale record without deleting the lock inode", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-runtime-lock-"))
    try {
      const path = join(root, "runtime.lock")
      await writeFile(path, "999\n2020-01-01T00:00:00.000Z\nstale\n")

      const lock = await acquireRuntimeLock(root, { pid: 404 })

      expect(lock.path).toBe(path)
      expect(await readFile(path, "utf8")).toMatch(/^404\n/)
      await lock.release()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
