import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { fetch as bedrockFetch } from "undici"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { isJsonObject, type JsonObject } from "../../src/kernel/index.ts"
import { createBedrockConverseProvider } from "../../src/runtime/bedrock-converse-provider.ts"
import { createConfiguredModelsManager } from "../../src/runtime/configured-models-manager.ts"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import {
  createToolRegistry,
  plainToolName,
} from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { inputFixture } from "../fixtures/user-input.ts"

it("persists buffered Converse tool rounds and resumes native history without repeating effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-bedrock-loop-"))
  const model = "us.amazon.nova-2-lite-v1:0"
  const requests: JsonObject[] = []
  const call = {
    toolUse: {
      toolUseId: "save_note",
      name: "save",
      input: { text: "saved once" },
    },
  }
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString())
    if (!isJsonObject(body)) {
      outgoing.writeHead(400).end()
      return
    }
    requests.push(body)
    outgoing.writeHead(200, { "content-type": "application/json" })
    outgoing.end(
      JSON.stringify({
        output: {
          message: {
            role: "assistant",
            content:
              requests.length === 1
                ? [call]
                : [{ text: requests.length === 2 ? "Saved." : "Resumed." }],
          },
        },
        stopReason: requests.length === 1 ? "tool_use" : "end_turn",
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      }),
    )
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Missing server address")
  const managers: ThreadManager[] = []
  const registries: ReturnType<typeof createProviderRegistry>[] = []
  let effects = 0
  const createManager = () => {
    const registry = createProviderRegistry({
      work: createModelProvider({
        info: {
          id: "work",
          wireApi: "bedrock_converse",
          capabilities: {
            remoteCompaction: false,
            tools: { supportsCustomTools: false, eagerTools: true },
          },
        },
        models: createConfiguredModelsManager({
          provider: "work",
          wireApi: "bedrock_converse",
          models: [{ id: model, contextWindowTokens: 1_000_000 }],
        }),
        continuationScope: "fixture-account",
        stream: createBedrockConverseProvider({
          apiKey: "fixture-only",
          model,
          baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com",
          fetchFn: (_url, init) =>
            bedrockFetch(`http://127.0.0.1:${address.port}`, init),
        }),
      }),
    })
    registries.push(registry)
    const manager = new ThreadManager({
      store: new JsonlThreadStore({ root }),
      createTurnProcessor: () =>
        createTurnProcessor({
          modelClient: registry.createClient(),
          provider: "work",
          model,
          loadProjectInstructions: async () => undefined,
          toolRegistry: createToolRegistry([
            {
              toolName: plainToolName("save"),
              description: "Save a note",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
              effect: "mutate",
              approvalRequirement: { kind: "none" },
              async execute(input) {
                if (!isJsonObject(input) || input.text !== "saved once")
                  throw new Error("Invalid input")
                effects++
                await writeFile(join(root, "note.txt"), input.text)
                return { ok: true, content: "saved", output: "saved" }
              },
            },
          ]),
        }),
    })
    managers.push(manager)
    return manager
  }
  try {
    const manager = createManager()
    const thread = await manager.createThread({
      workingDirectory: root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    await thread.startIfIdle({
      content: inputFixture([{ type: "text", text: "Save a note" }]),
    })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "Saved." })
    expect(effects).toBe(1)
    expect(await readFile(join(root, "note.txt"), "utf8")).toBe("saved once")
    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({
      messages: [
        expect.anything(),
        { role: "assistant", content: [call] },
        {
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: "save_note",
                content: [{ text: "saved" }],
                status: "success",
              },
            },
          ],
        },
      ],
    })
    await manager.shutdown()
    const resumed = await createManager().resumeThread(thread.id)
    if (!resumed) throw new Error("Missing resumed thread")
    const native = resumed
      .snapshot()
      .context.history.flatMap(({ item }) =>
        item.role === "assistant" ? (item.native ?? []) : [],
      )
    expect(native.map((item) => item.value)).toEqual([call, { text: "Saved." }])
    expect(
      native.every(
        (item) =>
          item.wireApi === "bedrock_converse" &&
          item.scope === "fixture-account",
      ),
    ).toBe(true)
    await resumed.startIfIdle({
      content: inputFixture([{ type: "text", text: "Continue" }]),
    })
    await expect
      .poll(() => resumed.agentStatus)
      .toEqual({ completed: "Resumed." })
    expect(effects).toBe(1)
    expect(requests).toHaveLength(3)
    expect(JSON.stringify(requests[2])).toContain('"toolUseId":"save_note"')
  } finally {
    for (const manager of managers) await manager.shutdown()
    for (const registry of registries) await registry.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(root, { recursive: true, force: true })
  }
})
