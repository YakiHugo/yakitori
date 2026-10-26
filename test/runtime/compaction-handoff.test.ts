import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { isJsonObject, type JsonObject } from "../../src/kernel/index.ts"
import { createConfiguredModelsManager } from "../../src/runtime/configured-models-manager.ts"
import {
  createModelProvider,
  createProviderContinuationScope,
} from "../../src/runtime/model-provider.ts"
import { createOpenAIProvider } from "../../src/runtime/openai-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { inputFixture } from "../fixtures/user-input.ts"

it.each([
  { name: "equal window", targetWindow: 200_000 },
  { name: "smaller window", targetWindow: 60_000 },
])("restores a Responses checkpoint, converts it through its owner, and persists a $name model handoff", async ({
  targetWindow,
}) => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-compaction-handoff-"))
  const requests: Array<{ path: string | undefined; body: JsonObject }> = []
  let samples = 0
  const checkpoint = {
    type: "compaction",
    id: "checkpoint-a",
    encrypted_content: "opaque-model-a-state",
  }
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString())
    if (!isJsonObject(body)) {
      response.writeHead(400).end()
      return
    }
    requests.push({ path: request.url, body })
    if (request.url === "/v1/responses/compact") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          id: "compact-a",
          object: "response.compaction",
          created_at: 1,
          output: [
            {
              type: "message",
              id: "original-user",
              role: "user",
              content: [{ type: "input_text", text: "Original task" }],
            },
            checkpoint,
          ],
          usage: {
            input_tokens: 199_000,
            output_tokens: 10,
            total_tokens: 199_010,
          },
        }),
      )
      return
    }
    samples += 1
    const text =
      samples === 3 ? "Portable progress from model A" : `Answer ${samples}`
    const inputTokens = samples === 1 ? 199_000 : samples === 2 ? 100_000 : 100
    const message = {
      type: "message",
      id: `answer-${samples}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    for (const event of [
      { type: "response.output_item.done", output_index: 0, item: message },
      {
        type: "response.completed",
        response: {
          id: `response-${samples}`,
          model: body.model,
          status: "completed",
          output: [message],
          usage: {
            input_tokens: inputTokens,
            output_tokens: 10,
            total_tokens: inputTokens + 10,
          },
          error: null,
          incomplete_details: null,
        },
      },
    ])
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new Error("Missing test server address")
  const baseURL = `http://127.0.0.1:${address.port}/v1`
  const managers: ThreadManager[] = []
  const createManager = () => {
    // Recreate both the provider and store so replay relies on durable history
    // and stable account identity, rather than a previous transport's state.
    const registry = createProviderRegistry({
      work: createModelProvider({
        info: {
          id: "work",
          wireApi: "openai_responses",
          capabilities: { remoteCompaction: "responses_compact" },
          retry: { maxAttempts: 1 },
        },
        models: createConfiguredModelsManager({
          provider: "work",
          wireApi: "openai_responses",
          models: [
            { id: "model-a", contextWindowTokens: 200_000 },
            { id: "model-b", contextWindowTokens: targetWindow },
          ],
        }),
        continuationScope: createProviderContinuationScope(
          "work",
          baseURL,
          "test",
        ),
        stream: createOpenAIProvider({
          apiKey: "test",
          baseURL,
          model: "model-a",
        }),
      }),
    })
    const manager = new ThreadManager({
      store: new JsonlThreadStore({ root }),
      createTurnProcessor: () =>
        createTurnProcessor({
          modelClient: registry.createClient(),
          provider: "work",
          model: "model-a",
          loadProjectInstructions: async () => undefined,
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
    for (const [index, text] of ["Original task", "Continue"].entries()) {
      await thread.startIfIdle({
        content: inputFixture([{ type: "text", text }]),
      })
      await expect
        .poll(() => thread.agentStatus)
        .toEqual({ completed: `Answer ${index + 1}` })
    }
    await manager.shutdown()
    const resumedManager = createManager()
    const resumed = await resumedManager.resumeThread(thread.id)
    if (resumed === undefined) throw new Error("Missing restored thread")
    const restoredCheckpoint = resumed
      .snapshot()
      .context.history.flatMap(({ item }) =>
        item.role === "assistant"
          ? item.content.filter((block) => block.type === "compaction")
          : [],
      )
    expect(restoredCheckpoint).toMatchObject([
      {
        provider: "work",
        model: "model-a",
        encryptedContent: "opaque-model-a-state",
      },
    ])
    await resumed.startIfIdle({
      modelSelection: { provider: "work", model: "model-b" },
      content: inputFixture([
        { type: "text", text: "Fresh instruction for model B" },
      ]),
    })
    await expect
      .poll(() => resumed.agentStatus)
      .toEqual({ completed: "Answer 4" })
    expect(requests.map(({ path, body }) => [path, body.model])).toEqual([
      ["/v1/responses", "model-a"],
      ["/v1/responses/compact", "model-a"],
      ["/v1/responses", "model-a"],
      ["/v1/responses", "model-a"],
      ["/v1/responses", "model-b"],
    ])
    const ownerInput = requests[3]?.body.input
    expect(ownerInput).toEqual(expect.arrayContaining([checkpoint]))
    expect(JSON.stringify(ownerInput)).toContain("Write a concise checkpoint")
    expect(JSON.stringify(ownerInput)).not.toContain(
      "Fresh instruction for model B",
    )
    const targetInput = JSON.stringify(requests[4]?.body.input)
    expect(targetInput).toContain("Portable progress from model A")
    expect(targetInput).toContain("Fresh instruction for model B")
    expect(targetInput).not.toContain("opaque-model-a-state")
    await resumedManager.shutdown()

    const continued = await createManager().resumeThread(thread.id)
    if (continued === undefined) throw new Error("Missing converted thread")
    await continued.startIfIdle({
      content: inputFixture([
        { type: "text", text: "Continue after handoff restart" },
      ]),
    })
    await expect
      .poll(() => continued.agentStatus)
      .toEqual({ completed: "Answer 5" })
    expect(requests.at(-1)?.body.model).toBe("model-b")
    expect(JSON.stringify(requests.at(-1)?.body.input)).toContain(
      "Portable progress from model A",
    )
    expect(JSON.stringify(requests.at(-1)?.body.input)).not.toContain(
      "opaque-model-a-state",
    )
    expect(requests).toHaveLength(6)
  } finally {
    for (const manager of managers.reverse()) await manager.shutdown()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(root, { recursive: true, force: true })
  }
})
