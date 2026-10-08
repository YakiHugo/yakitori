import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { ModelProvider } from "../../src/runtime/model-provider.ts"
import { createFileModelsCacheStore } from "../../src/runtime/models-cache-store.ts"
import {
  createDiscoveringModelsManager,
  createStaticModelsManager,
  type PersistedModelsCache,
} from "../../src/runtime/models-manager.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const selection = { provider: "codex", model: "account-model" }

describe("model catalog owner transitions", () => {
  it("returns the current account catalog after A to B to A overlaps a slow save", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "yakitori-catalog-transition-"),
    )
    const file = createFileModelsCacheStore({ provider: "codex", directory })
    const firstSave = deferred<void>()
    const saved: string[] = []
    let identity = "A"
    let savingA = false
    let discovered = 0
    const manager = createDiscoveringModelsManager({
      provider: "codex",
      identity: async () => identity,
      discover: async () => {
        discovered += 1
        return [
          { id: "account-model", instructions: `instructions-${identity}` },
        ]
      },
      cacheStore: {
        load: file.load,
        async save(entry) {
          if (entry.identity === "A" && !savingA) {
            savingA = true
            await firstSave.promise
          }
          await file.save(entry)
          saved.push(entry.identity ?? "unknown")
        },
      },
    })
    try {
      const initialA = manager.refresh()
      await vi.waitFor(() => expect(savingA).toBe(true))
      identity = "B"
      const switchedB = manager.refresh()
      await vi.waitFor(() =>
        expect(manager.resolve(selection).instructions).toBe("instructions-B"),
      )
      identity = "A"
      const switchedBack = manager.refresh()
      await Promise.resolve()
      await Promise.resolve()
      firstSave.resolve()
      await Promise.all([initialA, switchedB, switchedBack])
      expect(manager.resolve(selection).instructions).toBe("instructions-A")
      expect(discovered).toBeGreaterThanOrEqual(2)
      expect(saved.slice(0, 2)).toEqual(["A", "B"])
      expect((await file.load())?.identity).toBe("A")
    } finally {
      firstSave.resolve()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("shares a failed disk load and still admits one cold discovery", async () => {
    const disk = deferred<PersistedModelsCache | undefined>()
    const remote = deferred<readonly { id: string; instructions: string }[]>()
    const load = vi.fn(() => disk.promise)
    const discover = vi.fn(() => remote.promise)
    const manager = createDiscoveringModelsManager({
      provider: "codex",
      identity: async () => "A",
      discover,
      cacheStore: { load, save: async () => {} },
    })
    const readers = [manager.refresh(), manager.refresh(), manager.listModels()]
    expect(load).toHaveBeenCalledTimes(1)
    expect(discover).not.toHaveBeenCalled()
    disk.reject(new Error("unreadable cache"))
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1))
    remote.resolve([{ id: "account-model", instructions: "current" }])
    await Promise.all(readers)
    expect(manager.resolve(selection).instructions).toBe("current")
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("rejects a disk snapshot whose account changed before the load completed", async () => {
    let identity = "A"
    const disk = deferred<PersistedModelsCache | undefined>()
    const remote = deferred<readonly { id: string; instructions: string }[]>()
    const manager = createDiscoveringModelsManager({
      provider: "codex",
      identity: async () => identity,
      discover: () => remote.promise,
      cacheStore: { load: () => disk.promise, save: async () => {} },
      now: () => 10,
    })
    const pending = manager.refresh()
    identity = "B"
    disk.resolve({
      identity: "A",
      fetchedAt: 10,
      models: [{ id: "account-model", instructions: "old-A" }],
    })
    await vi.waitFor(() =>
      expect(manager.resolve(selection).instructions).toBeUndefined(),
    )
    remote.resolve([{ id: "account-model", instructions: "new-B" }])
    await pending
    expect(manager.resolve(selection).instructions).toBe("new-B")
  })

  it("retains stale same-account data on refresh failure and releases the failed single flight", async () => {
    let now = 0
    let tries = 0
    const manager = createDiscoveringModelsManager({
      provider: "codex",
      identity: async () => "A",
      now: () => now,
      ttlMs: 10,
      discover: async () => {
        tries += 1
        if (tries === 2) throw new Error("offline")
        return [
          { id: "account-model", instructions: tries === 1 ? "old" : "new" },
        ]
      },
    })
    await manager.refresh()
    now = 10
    await manager.refresh()
    await vi.waitFor(() => expect(tries).toBe(2))
    expect(manager.resolve(selection).instructions).toBe("old")
    await manager.refresh()
    await vi.waitFor(() =>
      expect(manager.resolve(selection).instructions).toBe("new"),
    )
    expect(tries).toBe(3)
  })

  it("keeps a published snapshot usable after a save rejection and lets later saves proceed", async () => {
    let identity = "A"
    const saves: string[] = []
    const manager = createDiscoveringModelsManager({
      provider: "codex",
      identity: async () => identity,
      discover: async () => [{ id: "account-model", instructions: identity }],
      cacheStore: {
        load: async () => undefined,
        save: async (entry) => {
          saves.push(entry.identity ?? "unknown")
          if (entry.identity === "A") throw new Error("disk full")
        },
      },
    })
    await manager.refresh()
    expect(manager.resolve(selection).instructions).toBe("A")
    identity = "B"
    await manager.refresh()
    expect(manager.resolve(selection).instructions).toBe("B")
    expect(saves).toEqual(["A", "B"])
  })
})

describe("Session client close transitions", () => {
  it("fences new Turns immediately and joins overlapping Turn closes before aggregating all failures", async () => {
    const pending = deferred<void>()
    const firstError = new Error("first close failed")
    const secondError = new Error("second close failed")
    const closed: number[] = []
    const provider: ModelProvider = {
      info: {
        id: "codex",
        wireApi: "openai_responses",
        capabilities: { remoteCompaction: false },
      },
      models: createStaticModelsManager("codex"),
      startTurn() {
        const id = next++
        return {
          models: this.models,
          stream: async function* () {},
          close() {
            closed.push(id)
            if (id === 0) throw firstError
            return pending.promise.then(() => {
              throw secondError
            })
          },
        }
      },
    }
    let next = 0
    const client = createProviderRegistry({ codex: provider }).createClient()
    const first = client.startTurn("codex")
    const second = client.startTurn("codex")
    const firstClosing = first.close()
    const sessionClosing = client.close()
    let settled = false
    const observed = Promise.resolve(sessionClosing)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true
      })
    expect(client.close()).toBe(sessionClosing)
    expect(first.close()).toBe(firstClosing)
    expect(second.close()).toBe(second.close())
    expect(() => client.startTurn("codex")).toThrow("closed")
    await vi.waitFor(() => expect(closed).toEqual([0, 1]))
    expect(settled).toBe(false)
    pending.resolve()
    expect(await observed).toMatchObject({ errors: [firstError, secondError] })
    expect(closed).toEqual([0, 1])
  })
})
