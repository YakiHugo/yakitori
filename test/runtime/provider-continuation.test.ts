import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import type { JsonObject } from "../../src/kernel/index.ts"
import { createAnthropicProvider } from "../../src/runtime/anthropic-provider.ts"
import type { ModelResponse } from "../../src/runtime/model.ts"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import {
  createOpenAIProvider,
  toOpenAIInput,
} from "../../src/runtime/openai-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { inputFixture } from "../fixtures/user-input.ts"

const isolatedHome = vi.hoisted(() => ({ path: "" }))
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => isolatedHome.path,
}))

it("replays the entire public compact window after persistence without a Codex trigger", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-api-compact-"))
  const checkpoint = {
    type: "compaction",
    id: "cmp",
    encrypted_content: "opaque",
  }
  const canonical = [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Retained constraint" }],
    },
    checkpoint,
  ]
  let path: string | undefined
  let body: JsonObject | undefined
  const server = createServer(async (request, response) => {
    path = request.url
    let input = ""
    for await (const bytes of request) input += bytes.toString()
    body = JSON.parse(input)
    response.writeHead(200, {
      "content-type": "application/json",
      "x-request-id": "http_compact",
    })
    response.end(
      JSON.stringify({
        id: "response_compact",
        object: "response.compaction",
        output: canonical,
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
        },
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new Error("Missing address")
  const stream = createOpenAIProvider({
    apiKey: "fixture",
    model: "test",
    baseURL: `http://127.0.0.1:${address.port}`,
  })
  const store = new JsonlThreadStore({ root })
  let writer: JsonlThreadStore | undefined
  try {
    let terminal: ModelResponse | undefined
    for await (const event of stream({
      target: {
        provider: "openai",
        model: "test",
        instructionProfileId: "test",
      },
      continuationScope: "account",
      compaction: "responses_compact",
      cacheKey: "cache",
      system: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Original request" }] },
      ],
      tools: [],
      toolWireProtocol: "eager",
    })) {
      if (event.type === "failure") throw new Error(event.failure.message)
      if (event.type === "response") terminal = event.response
    }
    expect(path).toBe("/responses/compact")
    expect(body).toEqual({
      model: "test",
      instructions: "",
      prompt_cache_key: "cache",
      input: [
        {
          role: "user",
          content: "Original request",
        },
      ],
    })
    expect(terminal).toMatchObject({
      providerRequestId: "http_compact",
      providerResponseId: "response_compact",
      content: [{ type: "compaction", encryptedContent: "opaque" }],
    })
    if (terminal === undefined || terminal.native === undefined)
      throw new Error("Missing native response")
    const now = new Date().toISOString()
    await store.createThread({
      id: "thread_compact",
      conversationId: "thread_compact",
      createdAt: now,
      updatedAt: now,
    })
    writer = store
    await store.persistThread("thread_compact", "turn_start")
    await store.appendItems("thread_compact", [
      {
        type: "response_item",
        item: {
          id: "checkpoint",
          turnId: "turn",
          createdAt: now,
          item: {
            role: "assistant",
            content: terminal.content,
            native: terminal.native,
          },
        },
      },
    ])
    await store.shutdownThread("thread_compact")
    writer = undefined
    const reopened = new JsonlThreadStore({ root })
    const restored = await reopened.resumeThread("thread_compact")
    writer = reopened
    const item = restored?.rollout.find(
      ({ item }) => item.type === "response_item",
    )?.item
    if (item?.type !== "response_item" || item.item.item.role !== "assistant")
      throw new Error("Missing checkpoint")
    expect(
      toOpenAIInput(
        [item.item.item],
        false,
        "openai",
        "account",
        new Map(),
        "test",
      ),
    ).toEqual(canonical)
  } finally {
    if (writer !== undefined) await writer.shutdownThread("thread_compact")
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(root, { recursive: true, force: true })
  }
})

it("continues a Messages server-tool pause with native blocks and persists both attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-server-pause-"))
  isolatedHome.path = root
  const paused = {
    type: "server_tool_use",
    id: "server_search",
    name: "web_search",
    input: { query: "source" },
  }
  const requests: JsonObject[] = []
  const server = createServer(async (request, response) => {
    let input = ""
    for await (const bytes of request) input += bytes.toString()
    requests.push(JSON.parse(input))
    const first = requests.length === 1
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "request-id": `http_${requests.length}`,
    })
    const event = (type: string, payload: object) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)
    event("message_start", {
      type: "message_start",
      message: {
        id: `response_${requests.length}`,
        role: "assistant",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 7, output_tokens: 0 },
      },
    })
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: first ? paused : { type: "text", text: "Done" },
    })
    event("content_block_stop", { type: "content_block_stop", index: 0 })
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: first ? "pause_turn" : "end_turn" },
      usage: { output_tokens: 3 },
    })
    event("message_stop", { type: "message_stop" })
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new Error("Missing address")
  const registry = createProviderRegistry({
    anthropic: createModelProvider({
      info: {
        id: "anthropic",
        wireApi: "anthropic_messages",
        capabilities: { remoteCompaction: false },
        retry: { maxAttempts: 1 },
      },
      stream: createAnthropicProvider({
        apiKey: "fixture",
        model: "test",
        baseURL: `http://127.0.0.1:${address.port}`,
      }),
      continuationScope: "account",
    }),
  })
  const store = new JsonlThreadStore({ root })
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () =>
      createTurnProcessor({
        modelClient: registry.createClient(),
        provider: "anthropic",
        model: "test",
        loadProjectInstructions: async () => undefined,
      }),
  })
  try {
    const thread = await manager.createThread({
      workingDirectory: root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    await thread.startIfIdle({
      content: inputFixture([{ type: "text", text: "Search" }]),
    })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "Done" })
    expect(requests).toHaveLength(2)
    const messages = requests[1]?.messages
    expect(messages).toEqual(
      expect.arrayContaining([{ role: "assistant", content: [paused] }]),
    )
    const saved = await store.readThread(thread.id)
    expect(
      saved?.rollout
        .filter(({ item }) => item.type === "model_attempt")
        .map(({ item }) =>
          item.type === "model_attempt" ? item.attempt : undefined,
        ),
    ).toMatchObject([
      {
        outcome: "completed",
        stopReason: "pause_turn",
        providerResponseId: "response_1",
        providerRequestId: "http_1",
      },
      {
        outcome: "completed",
        stopReason: "end_turn",
        providerResponseId: "response_2",
        providerRequestId: "http_2",
      },
    ])
    const assistants =
      saved?.rollout.flatMap(({ item }) =>
        item.type === "response_item" && item.item.item.role === "assistant"
          ? [item.item.item]
          : [],
      ) ?? []
    expect(
      assistants
        .flatMap((message) => message.content)
        .some((block) => block.type === "tool_call"),
    ).toBe(false)
  } finally {
    await manager.shutdown()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(root, { recursive: true, force: true })
  }
})
