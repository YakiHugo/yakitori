import { mkdtemp, readFile, rm } from "node:fs/promises"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, onTestFinished, vi } from "vitest"
import type { SessionEvent } from "../../src/core/session-io.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import { isJsonObject, type JsonObject } from "../../src/kernel/index.ts"
import type { ProviderConfiguration } from "../../src/protocol/providers.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createWriteFileTool } from "../../src/runtime/tools/write-file.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { discoverProviderModels } from "../../src/server/provider-model-discovery.ts"
import { MemoryThreadStore } from "../core/memory-thread-store.ts"

it.each([
  { model: "k3.1-pro", capacity: 1_048_576 },
  { model: "future-code-model", capacity: 640_000 },
])("uses the shared Kimi Code profile and reported capacity for $model throughout a tool Turn", async ({
  model,
  capacity,
}) => {
  const fixture = await kimiCodeEndpoint(model, capacity)
  const connection: ProviderConfiguration = {
    name: "Personal Kimi Code",
    service: "kimi-code",
    wireApi: "anthropic_messages",
    baseURL: "https://api.kimi.com/coding",
    models: [],
  }
  const provider = createConfiguredProvider("personal", connection, "fixture", {
    loadModels: () => discoverProviderModels(connection, "fixture"),
    result() {},
  })
  await provider.models.refresh()
  const root = await mkdtemp(join(tmpdir(), "yakitori-kimi-metadata-"))
  const registry = createProviderRegistry({ personal: provider })
  const client = registry.createClient()
  const store = new MemoryThreadStore()
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () =>
      createTurnProcessor({
        modelClient: client,
        toolRegistry: createToolRegistry([createWriteFileTool()]),
        loadProjectInstructions: async () => undefined,
        skills: false,
      }),
  })
  onTestFinished(async () => {
    await manager.shutdown()
    await client.close()
    await registry.close()
    await rm(root, { recursive: true, force: true })
  })
  const selection = { provider: "personal", model }
  const configuration = SessionConfiguration.create(
    {
      selection,
      workspaceRoot: root,
      enabledTools: ["write_file"],
      approvalPolicy: "always_approve",
      promptCacheKey: "kimi-code-metadata",
    },
    provider.models,
  )
  const step = configuration.resolveStep(selection, provider.models)
  expect(step.modelInfo).toMatchObject({
    instructionProfileId: "kimi-code",
    usedFallbackModelMetadata: false,
    inputModalities: ["text", "image", "video"],
    efforts: ["low", "high", "max"],
    shellToolType: "unified_exec",
    fileEditingToolType: "edit_write",
    supportsCustomTools: false,
    supportsNativeToolSearch: false,
  })
  expect(step.modelCapacity).toMatchObject({ contextWindowTokens: capacity })
  expect(step.target.effort).toBeUndefined()
  expect(step.modelInstructions.text).toContain("You are Kimi Code CLI")
  const thread = await manager.createThread({
    workingDirectory: root,
    mateId: "mate_test",
    mateRevisionId: "revision_test",
    initialConfiguration: configuration.snapshot,
  })
  await thread.startIfIdle({ content: createUserInput("Create proof.txt") })
  const events: SessionEvent[] = []
  for (;;) {
    const event = await thread.nextEvent()
    if (event === undefined) throw new Error("Turn ended without completion")
    events.push(event)
    if (event.type === "turn.failed") throw new Error(JSON.stringify(event))
    if (event.type === "turn.completed") break
  }
  expect(thread.agentStatus).toEqual({ completed: "Saved." })
  expect(await readFile(join(root, "proof.txt"), "utf8")).toBe("verified\n")
  expect(
    events.filter(
      (event) =>
        event.type === "runtime.warning" &&
        event.message.includes("Model metadata"),
    ),
  ).toEqual([])
  expect(fixture.requests).toHaveLength(2)
  for (const body of fixture.requests) {
    expect(body.model).toBe(model)
    expect(JSON.stringify(body.system)).toContain("You are Kimi Code CLI")
    expect(body.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "write_file" })]),
    )
    expect(body.output_config).toBeUndefined()
  }
  expect(JSON.stringify(fixture.requests[1]?.messages)).toContain(
    '"type":"tool_result"',
  )
})

it("keeps an unbound relay on generic metadata for directory and settings-only models", () => {
  const provider = createConfiguredProvider(
    "kimi-code",
    {
      name: "Kimi Code relay",
      service: "kimi-code",
      wireApi: "anthropic_messages",
      baseURL: "https://relay.example/coding",
      models: [
        {
          id: "future-code-model",
          contextWindowTokens: 640_000,
          inputModalities: ["text", "image"],
          efforts: ["low", "high", "max"],
        },
      ],
    },
    "fixture",
  )
  const selection = { provider: "kimi-code", model: "future-code-model" }
  expect(provider.info.serviceId).toBeUndefined()
  expect(provider.models.resolve(selection)).toMatchObject({
    instructionProfileId: "default",
    usedFallbackModelMetadata: true,
    inputModalities: ["text", "image"],
  })
  expect(provider.models.capacity(selection)?.contextWindowTokens).toBe(640_000)
  const registry = createProviderRegistry(
    { "kimi-code": provider },
    { settings: () => ({ "settings-only-model": { visible: true } }) },
  )
  onTestFinished(() => registry.close())
  const models = registry.models("kimi-code")
  const settingsOnly = { provider: "kimi-code", model: "settings-only-model" }
  const resolved = models.resolve(settingsOnly)
  expect(resolved).toMatchObject({
    provider: "kimi-code",
    model: "settings-only-model",
    instructionProfileId: "default",
    usedFallbackModelMetadata: true,
    inputModalities: ["text"],
    supportsCustomTools: false,
    supportsNativeToolSearch: false,
  })
  expect(resolved.efforts).toBeUndefined()
  expect(resolved.defaultEffort).toBeUndefined()
  expect(models.capacity(settingsOnly)).toBeUndefined()
})

async function kimiCodeEndpoint(model: string, capacity: number) {
  const requests: JsonObject[] = []
  const failures: unknown[] = []
  const server = createServer((request, response) => {
    Promise.resolve()
      .then(async () => {
        if (request.method === "GET" && request.url === "/coding/v1/models") {
          response.writeHead(200, { "content-type": "application/json" })
          response.end(
            JSON.stringify({
              data: [
                {
                  id: model,
                  context_length: capacity,
                  supports_image_in: true,
                  supports_video_in: true,
                  think_efforts: {
                    support: true,
                    valid_efforts: ["low", "high", "max"],
                  },
                },
              ],
            }),
          )
          return
        }
        if (request.method !== "POST" || request.url !== "/coding/v1/messages")
          throw new Error(`Unexpected request ${request.method} ${request.url}`)
        requests.push(await requestBody(request))
        const block =
          requests.length === 1
            ? {
                type: "tool_use",
                id: "write_proof",
                name: "write_file",
                input: { path: "proof.txt", content: "verified\n" },
              }
            : { type: "text", text: "Saved." }
        sendMessage(response, model, block)
      })
      .catch((error: unknown) => {
        failures.push(error)
        response.destroy()
      })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new Error("Missing fixture server address")
  const fetch = globalThis.fetch
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const original = new Request(input, init)
    const url = new URL(original.url)
    return fetch(
      new Request(`http://127.0.0.1:${address.port}${url.pathname}`, original),
    )
  })
  onTestFinished(async () => {
    vi.unstubAllGlobals()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    expect(failures).toEqual([])
  })
  return { requests }
}

function sendMessage(
  response: ServerResponse,
  model: string,
  block: JsonObject,
) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "message_fixture",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: {
        stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn",
      },
      usage: { output_tokens: 10 },
    },
    { type: "message_stop" },
  ]
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.end(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
  )
}

async function requestBody(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (!isJsonObject(body)) throw new Error("Invalid fixture body")
  return body
}
