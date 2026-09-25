import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createFileModelsCacheStore } from "../../src/runtime/models-cache-store.ts"
import {
  createDiscoveringModelsManager,
  type DiscoveredModel,
} from "../../src/runtime/models-manager.ts"

describe("discovering models manager", () => {
  it("blocks only a cold cache on the first fetch", async () => {
    const gate = deferred<readonly DiscoveredModel[]>()
    let discovered = false
    const manager = createDiscoveringModelsManager({
      provider: "codex",
      identity: async () => "account",
      discover: () => {
        discovered = true
        return gate.promise
      },
    })

    let returned = false
    const pending = manager.refresh().then(() => {
      returned = true
    })
    await vi.waitFor(() => expect(discovered).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(returned).toBe(false)

    gate.resolve([{ id: "gpt-cold", contextWindowTokens: 100_000 }])
    await pending
    expect(
      manager.capacity({ provider: "codex", model: "gpt-cold" }),
    ).toMatchObject({ contextWindowTokens: 100_000 })
  })

  it("revalidates an expired cache in the background without blocking refresh", async () => {
    let now = 0
    const revalidation = deferred<readonly DiscoveredModel[]>()
    const discover = vi
      .fn<() => Promise<readonly DiscoveredModel[]>>()
      .mockResolvedValueOnce([
        { id: "gpt-5.6-sol", contextWindowTokens: 100_000 },
      ])
      .mockImplementationOnce(() => revalidation.promise)
    const manager = createDiscoveringModelsManager({
      provider: "codex",
      identity: async () => "account",
      discover,
      now: () => now,
      ttlMs: 100,
    })

    await manager.refresh()
    expect(discover).toHaveBeenCalledTimes(1)

    now = 101
    // refresh() returns without waiting for the in-flight revalidation.
    await manager.refresh()
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(2))
    // The revalidation is still in flight; the expired entry keeps serving.
    expect(
      manager.capacity({ provider: "codex", model: "gpt-5.6-sol" }),
    ).toMatchObject({ contextWindowTokens: 100_000 })

    revalidation.resolve([{ id: "gpt-5.6-sol", contextWindowTokens: 200_000 }])
    await vi.waitFor(() =>
      expect(
        manager.capacity({ provider: "codex", model: "gpt-5.6-sol" }),
      ).toMatchObject({ contextWindowTokens: 200_000 }),
    )
  })

  it("scopes the cached catalog to the account that produced it", async () => {
    let identity = "account_a"
    const revalidation = deferred<readonly DiscoveredModel[]>()
    const discover = vi
      .fn<() => Promise<readonly DiscoveredModel[]>>()
      .mockResolvedValueOnce([
        { id: "gpt-account-model", contextWindowTokens: 111_000 },
      ])
      .mockImplementationOnce(() => revalidation.promise)
    const manager = createDiscoveringModelsManager({
      provider: "codex",
      identity: async () => identity,
      discover,
    })

    await manager.refresh()
    expect(
      manager.capacity({ provider: "codex", model: "gpt-account-model" }),
    ).toMatchObject({ contextWindowTokens: 111_000 })

    identity = "account_b"
    const pending = manager.refresh()
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(2))
    // The old account's entry was evicted before the new fetch landed.
    expect(
      manager.capacity({ provider: "codex", model: "gpt-account-model" }),
    ).toBeUndefined()

    revalidation.resolve([{ id: "gpt-b-model", contextWindowTokens: 222_000 }])
    await pending
    expect(
      manager.capacity({ provider: "codex", model: "gpt-account-model" }),
    ).toBeUndefined()
    expect(
      manager.capacity({ provider: "codex", model: "gpt-b-model" }),
    ).toMatchObject({ contextWindowTokens: 222_000 })
  })

  it("discards a fetch whose account changed while it was in flight", async () => {
    let identity = "account_a"
    const gate = deferred<readonly DiscoveredModel[]>()
    const discover = vi
      .fn<() => Promise<readonly DiscoveredModel[]>>()
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValue([{ id: "gpt-b-model", contextWindowTokens: 222_000 }])
    const manager = createDiscoveringModelsManager({
      provider: "codex",
      identity: async () => identity,
      discover,
    })

    const pending = manager.refresh()
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1))
    identity = "account_b"
    gate.resolve([{ id: "gpt-a-only-model", contextWindowTokens: 111_000 }])
    await pending

    // The late result belongs to the old account and was not installed.
    expect(
      manager.capacity({ provider: "codex", model: "gpt-a-only-model" }),
    ).toBeUndefined()

    await manager.refresh()
    expect(discover).toHaveBeenCalledTimes(2)
    expect(
      manager.capacity({ provider: "codex", model: "gpt-b-model" }),
    ).toMatchObject({ contextWindowTokens: 222_000 })
  })

  it("retries discovery after a failure instead of suppressing retries", async () => {
    const discover = vi
      .fn<() => Promise<readonly DiscoveredModel[]>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([
        { id: "gpt-retry-test", contextWindowTokens: 100_000 },
      ])
    const manager = createDiscoveringModelsManager({
      provider: "codex",
      identity: async () => "account",
      discover,
      ttlMs: 60_000,
    })

    await manager.refresh()
    expect(discover).toHaveBeenCalledTimes(1)
    expect(
      manager.resolve({ provider: "codex", model: "gpt-retry-test" }),
    ).toMatchObject({ usedFallbackModelMetadata: true })

    await manager.refresh()
    expect(discover).toHaveBeenCalledTimes(2)
    expect(
      manager.capacity({ provider: "codex", model: "gpt-retry-test" }),
    ).toMatchObject({ contextWindowTokens: 100_000 })
  })
})

describe("persisted models cache", () => {
  let root: string | undefined
  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  it("starts a cold process with the last good catalog", async () => {
    root = await mkdtemp(join(tmpdir(), "yakitori-models-cache-"))
    const store = createFileModelsCacheStore({
      provider: "codex",
      directory: root,
    })
    const first = createDiscoveringModelsManager({
      provider: "codex",
      identity: async () => "account",
      discover: async () => [
        { id: "gpt-persisted", contextWindowTokens: 321_000 },
      ],
      cacheStore: store,
    })
    await first.refresh()

    // A new manager over the same store serves the persisted catalog without
    // touching the network.
    const discover = vi.fn<() => Promise<readonly DiscoveredModel[]>>()
    const second = createDiscoveringModelsManager({
      provider: "codex",
      identity: async () => "account",
      discover,
      cacheStore: store,
    })
    await second.refresh()
    expect(
      second.capacity({ provider: "codex", model: "gpt-persisted" }),
    ).toMatchObject({ contextWindowTokens: 321_000 })
    expect(discover).not.toHaveBeenCalled()
  })

  it("ignores a persisted catalog from another account", async () => {
    root = await mkdtemp(join(tmpdir(), "yakitori-models-cache-"))
    const store = createFileModelsCacheStore({
      provider: "codex",
      directory: root,
    })
    await store.save({
      identity: "account_a",
      fetchedAt: Date.now(),
      models: [{ id: "gpt-persisted", contextWindowTokens: 321_000 }],
    })

    const discover = vi
      .fn<() => Promise<readonly DiscoveredModel[]>>()
      .mockResolvedValue([{ id: "gpt-b-model", contextWindowTokens: 222_000 }])
    const manager = createDiscoveringModelsManager({
      provider: "codex",
      identity: async () => "account_b",
      discover,
      cacheStore: store,
    })
    await manager.refresh()

    expect(
      manager.capacity({ provider: "codex", model: "gpt-persisted" }),
    ).toBeUndefined()
    expect(discover).toHaveBeenCalledTimes(1)
    expect(
      manager.capacity({ provider: "codex", model: "gpt-b-model" }),
    ).toMatchObject({ contextWindowTokens: 222_000 })
  })

  it("ignores a persisted catalog older than the TTL", async () => {
    root = await mkdtemp(join(tmpdir(), "yakitori-models-cache-"))
    const store = createFileModelsCacheStore({
      provider: "codex",
      directory: root,
    })
    await store.save({
      identity: "account",
      fetchedAt: 1_000,
      models: [{ id: "gpt-persisted", contextWindowTokens: 321_000 }],
    })

    const discover = vi
      .fn<() => Promise<readonly DiscoveredModel[]>>()
      .mockResolvedValue([])
    const manager = createDiscoveringModelsManager({
      provider: "codex",
      identity: async () => "account",
      discover,
      cacheStore: store,
      now: () => 1_000 + 5 * 60 * 1_000,
      ttlMs: 5 * 60 * 1_000,
    })
    await manager.refresh()

    expect(
      manager.capacity({ provider: "codex", model: "gpt-persisted" }),
    ).toBeUndefined()
    expect(discover).toHaveBeenCalledTimes(1)
  })

  it("treats a malformed cache file as absent", async () => {
    root = await mkdtemp(join(tmpdir(), "yakitori-models-cache-"))
    await writeFile(join(root, "codex.json"), "not json")
    const store = createFileModelsCacheStore({
      provider: "codex",
      directory: root,
    })
    await expect(store.load()).resolves.toBeUndefined()
  })
})

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
