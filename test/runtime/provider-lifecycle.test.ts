import { createServer } from "node:http"
import { setImmediate } from "node:timers/promises"
import { expect, it, onTestFinished } from "vitest"
import type {
  ModelRequest,
  ModelStreamEvent,
  StreamFn,
} from "../../src/runtime/model.ts"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createStaticModelsManager } from "../../src/runtime/models-manager.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"

it.each([
  "refresh",
  "listModels",
] as const)("retires a replaced provider after captured Turns and %s settle", async (operation) => {
  const old = await endpoint("old")
  const next = await endpoint("new")
  const registry = createProviderRegistry()
  const source = registry.register("plugin", { personal: old.provider })
  const client = registry.createClient()
  onTestFinished(async () => {
    old.releaseCatalog()
    await client.close()
    await registry.close()
  })
  const active = client.startTurn("personal")
  const catalog = registry.models("personal")
  const listing = catalog[operation]()
  await old.catalogEntered
  const replacing = source.replace({ personal: next.provider })
  expect(await text(client.startTurn("personal").stream(request))).toBe("new")
  expect(await text(active.stream(request))).toBe("old")
  await client.close()
  await setImmediate()
  expect(old.closed()).toBe(false)
  old.releaseCatalog()
  await listing
  await replacing
  expect(old.closed()).toBe(true)
  await expect(catalog[operation]()).rejects.toThrow("retired")
  expect(await text(registry.stream(request))).toBe("new")
  await source.close()
  expect(next.closed()).toBe(true)
})

it("rejects an invalid replacement and competing ownership without changing published routes", async () => {
  const first = await endpoint("first")
  const other = await endpoint("other", "work")
  const candidate = await endpoint("candidate")
  const registry = createProviderRegistry()
  const source = registry.register("one", { personal: first.provider })
  registry.register("two", { work: other.provider })
  onTestFinished(async () => {
    await registry.close()
    await candidate.provider.close?.()
  })
  expect(() =>
    source.replace({ personal: candidate.provider, invalid: other.provider }),
  ).toThrow("does not match")
  expect(() => source.replace({ work: other.provider })).toThrow(
    "another source",
  )
  expect(() => registry.register("one", {})).toThrow("already registered")
  expect(registry.providers).toEqual(["personal", "work"])
  expect(await text(registry.stream(request))).toBe("first")
  expect(
    await text(
      registry.stream({
        ...request,
        target: { ...request.target, provider: "work" },
      }),
    ),
  ).toBe("other")
  expect(first.closed()).toBe(false)
})

it("withdraws immediately, joins every provider cleanup, and retains cleanup failure", async () => {
  const failed = await endpoint("failed", "personal", true)
  const delayed = await endpoint("delayed", "work")
  const registry = createProviderRegistry()
  registry.register("one", { personal: failed.provider })
  const source = registry.register("two", { work: delayed.provider })
  const client = registry.createClient()
  const turn = client.startTurn("work")
  onTestFinished(async () => {
    await client.close()
    await expect(registry.close()).rejects.toThrow(
      "Failed to close provider registry",
    )
  })
  const closing = registry.close()
  const observed = expect(closing).rejects.toMatchObject({
    errors: [
      expect.objectContaining({ message: "Failed to retire model providers." }),
    ],
  })
  expect(registry.close()).toBe(closing)
  expect(() => client.startTurn("work")).toThrow("closed")
  expect(() => registry.register("three", {})).toThrow("closed")
  await setImmediate()
  expect(delayed.closed()).toBe(false)
  expect(
    await text(
      turn.stream({
        ...request,
        target: { ...request.target, provider: "work" },
      }),
    ),
  ).toBe("delayed")
  await turn.close()
  await observed
  expect(failed.closed()).toBe(true)
  expect(delayed.closed()).toBe(true)
  await source.close()
  expect(() => source.replace({})).toThrow("closed")
})

it("prevents stream and warmup work after Turn closure, including an unconsumed stream", async () => {
  let requests = 0
  const stream: StreamFn = async function* () {
    requests++
    yield {
      type: "response",
      response: { stopReason: "end_turn", content: [] },
    }
  }
  const registry = createProviderRegistry({
    personal: createModelProvider({
      info: {
        id: "personal",
        wireApi: "unknown",
        capabilities: { remoteCompaction: false },
      },
      createTurnTransport: () => ({ stream, warmup: stream, close() {} }),
    }),
  })
  const client = registry.createClient()
  const turn = client.startTurn("personal")
  const unconsumed = turn.stream(request)
  await turn.close()
  expect(() => turn.stream(request)).toThrow("closed")
  expect(() => turn.warmup?.(request)).toThrow("closed")
  await expect(text(unconsumed)).rejects.toThrow("closed")
  expect(requests).toBe(0)
  await client.close()
  await registry.close()
})

it("retains failed Turn ownership instead of disposing its shared provider", async () => {
  const failure = new Error("transport still owns resources")
  let disposed = false
  const registry = createProviderRegistry()
  const source = registry.register("plugin", {
    personal: createModelProvider({
      info: {
        id: "personal",
        wireApi: "unknown",
        capabilities: { remoteCompaction: false },
      },
      createTurnTransport: () => ({
        stream: async function* () {},
        close() {
          throw failure
        },
      }),
      close() {
        disposed = true
      },
    }),
  })
  const client = registry.createClient()
  await expect(client.startTurn("personal").close()).rejects.toBe(failure)
  await expect(client.close()).rejects.toMatchObject({ errors: [failure] })
  await expect(source.close()).rejects.toMatchObject({ errors: [failure] })
  await expect(registry.close()).rejects.toThrow(
    "Failed to close provider registry",
  )
  expect(disposed).toBe(false)
})

const request: ModelRequest = {
  target: {
    provider: "personal",
    model: "model",
    instructionProfileId: "default",
  },
  system: [],
  messages: [],
  tools: [],
  toolWireProtocol: "eager",
}

async function text(events: AsyncIterable<ModelStreamEvent>): Promise<string> {
  const output: string[] = []
  for await (const event of events) {
    if (event.type === "response") {
      for (const block of event.response.content)
        if (block.type === "text") output.push(block.text)
    }
  }
  return output.join("")
}

async function endpoint(label: string, id = "personal", failClose = false) {
  const { promise: catalogEntered, resolve: entered } =
    Promise.withResolvers<void>()
  const { promise: catalogBarrier, resolve: releaseCatalog } =
    Promise.withResolvers<void>()
  let closed = false
  const server = createServer(async (request, response) => {
    if (request.url === "/catalog") {
      entered()
      await catalogBarrier
    }
    response.end(label)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new Error("Missing endpoint address")
  const baseURL = `http://127.0.0.1:${address.port}`
  const models = createStaticModelsManager(id)
  const load = async () => {
    await (await fetch(`${baseURL}/catalog`)).text()
  }
  const provider = createModelProvider({
    info: { id, wireApi: "unknown", capabilities: { remoteCompaction: false } },
    models: {
      ...models,
      refresh: load,
      async listModels() {
        await load()
        return models.listModels()
      },
    },
    stream: async function* () {
      const value = await (await fetch(baseURL)).text()
      yield {
        type: "response",
        response: {
          stopReason: "end_turn",
          content: [{ type: "text", text: value }],
        },
      }
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      closed = true
      if (failClose) throw new Error("shared cleanup failed")
    },
  })
  return { provider, closed: () => closed, catalogEntered, releaseCatalog }
}
