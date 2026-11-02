import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import type { ModelRequest, StreamFn } from "../../src/runtime/model.ts"
import { resolveFallbackModel } from "../../src/runtime/model-catalog.ts"
import { prepareModelRequestPlan } from "../../src/runtime/model-request-plan.ts"
import { createStaticModelsManager } from "../../src/runtime/models-manager.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import type { RuntimeTool } from "../../src/runtime/tools/types.ts"
import { createTurnLoop } from "../../src/runtime/turn-loop.ts"
import { pngImageBase64 } from "../fixtures/images.ts"
import { inputFixture } from "../fixtures/user-input.ts"

const model = {
  ...resolveFallbackModel({ provider: "faux", model: "scripted" }),
  toolPolicy: "chat_only" as const,
}
const request: ModelRequest = {
  target: model,
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text: "Describe" }] }],
  tools: [],
  toolWireProtocol: "eager",
}
const toolCall = {
  type: "tool_call" as const,
  id: "unexpected",
  name: "mutate",
  input: {},
}
const native = {
  provider: "faux",
  model: "scripted",
  scope: "test",
  wireApi: "openai_chat_completions" as const,
  value: {
    role: "assistant",
    tool_calls: [
      {
        id: "hidden_native",
        type: "function",
        function: { name: "mutate", arguments: "{}" },
      },
    ],
  },
}
const definition = {
  name: "mutate",
  description: "Mutate",
  inputSchema: { type: "object" },
}

it.each([
  { tools: [definition] },
  { toolChoice: "none" as const },
  { parallelToolCalls: false },
  {
    providerOptions: {
      provider: "faux",
      wireApi: "openai_responses" as const,
      body: { tools: [{ type: "web_search" }] },
    },
  },
  { messages: [{ role: "assistant" as const, content: [toolCall] }] },
  {
    messages: [
      {
        role: "tool" as const,
        toolCallId: "past",
        content: [{ type: "text" as const, text: "historical result" }],
      },
    ],
  },
  { compaction: "responses_compact" as const },
  {
    providerOptions: {
      provider: "faux",
      wireApi: "openai_chat_completions" as const,
      body: { enable_search: true },
    },
  },
  {
    messages: [
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "historical text" }],
        native: [native],
      },
    ],
  },
])("rejects unsupported input without mutating history: %j", (change) => {
  const input = { ...request, ...change }
  const before = structuredClone(input)
  expect(() =>
    prepareModelRequestPlan(input, { model, wireApi: "faux" }),
  ).toThrow("Chat-only execution rejects")
  expect(input).toEqual(before)
})

it("keeps plain chat and checks retry-rebuilt history with the same policy", async () => {
  const plan = prepareModelRequestPlan(
    {
      ...request,
      rebuildMessagesAfterOutput: async () => [
        { role: "assistant", content: [toolCall] },
      ],
    },
    { model, wireApi: "faux" },
  )
  expect(plan.request.tools).toEqual([])
  expect(plan.request.messages).toEqual(request.messages)
  expect(plan.request.toolPolicy).toBe("chat_only")
  await expect(plan.request.rebuildMessagesAfterOutput?.()).rejects.toThrow(
    "original history has not been changed",
  )
})

function runtimeTool(
  name: string,
  exposure: RuntimeTool["exposure"] = "direct",
): RuntimeTool {
  return {
    toolName: { name },
    description: name,
    exposure,
    inputSchema: {},
    effect: "mutate",
    approvalRequirement: { kind: "none" },
    execute: vi.fn(async () => ({
      ok: true as const,
      output: {},
      content: "must not run",
    })),
  }
}

it("disables trusted, MCP, deferred and hidden tools including synthesized dispatch", async () => {
  const registry = createToolRegistry([runtimeTool("trusted")])
  registry.replaceExternalSource("mcp", [
    runtimeTool("direct"),
    runtimeTool("deferred", "deferred"),
    runtimeTool("hidden", "hidden"),
  ])
  const router = registry.finalize({
    enabledTrustedTools: new Set(["trusted"]),
    customToolMode: "function",
    wireProtocol: "meta_dispatch",
    toolPolicy: "chat_only",
  })
  expect(router.definitions).toEqual([])
  expect(router.modelDefinitions).toEqual([])
  expect(router.deferredDefinitions).toEqual([])
  for (const name of [
    "trusted",
    "direct",
    "deferred",
    "hidden",
    "tool_search",
    "use_tool",
  ]) {
    expect(router.get(name)).toBeUndefined()
    expect(
      await router.execute(name, {}, { workspaceRoot: "/unused" }),
    ).toMatchObject({ ok: false, code: "unknown_tool" })
  }
  await router.release()
  await registry.dispose()
})

it.each([
  "output_item",
  "response",
  "native",
  "plain",
  "empty_tool",
  "incomplete",
] as const)("enforces portable chat output for %s without tool effects", async (type) => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-chat-only-"))
  const tool = runtimeTool("mutate")
  const store = new JsonlThreadStore({ root: join(root, "store") })
  const fallback = createStaticModelsManager("faux")
  const models = { ...fallback, resolve: () => model }
  const cleanup = vi.fn()
  const stream: StreamFn = async function* (incoming) {
    try {
      expect(incoming.tools).toEqual([])
      expect(incoming.toolPolicy).toBe("chat_only")
      if (type === "output_item")
        yield { type, itemId: "tool", content: [toolCall] }
      yield {
        type: "response",
        response:
          type === "plain"
            ? {
                stopReason: "end_turn",
                content: [{ type: "text", text: "Portable chat answer" }],
              }
            : type === "native"
              ? {
                  stopReason: "end_turn",
                  content: [{ type: "text", text: "Opaque native answer" }],
                  native: [native],
                }
              : type === "empty_tool"
                ? { stopReason: "tool_use", content: [] }
                : type === "incomplete"
                  ? {
                      stopReason: "content_filter",
                      content: [],
                      incompleteToolCalls: true,
                    }
                  : { stopReason: "tool_use", content: [toolCall] },
      }
    } finally {
      cleanup()
    }
  }
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () =>
      createTurnLoop({
        toolRegistry: createToolRegistry([tool]),
        modelClient: {
          hasProvider: () => true,
          models: () => models,
          startTurn: () => ({ models, stream, close() {} }),
          close() {},
        },
      }),
  })
  try {
    const thread = await manager.createThread({
      workingDirectory: root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    await thread.startIfIdle({
      submissionId: "chat",
      content: createUserInput("Describe"),
    })
    await expect
      .poll(async () =>
        (await store.readThread(thread.id))?.rollout.some(
          ({ item }) => item.type === "turn_completed",
        ),
      )
      .toBe(true)
    expect(tool.execute).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalledTimes(1)
    const durable = await store.readThread(thread.id)
    const serialized = JSON.stringify(durable)
    expect(serialized).toContain(
      type === "plain"
        ? "Portable chat answer"
        : "Chat-only execution received",
    )
    expect(serialized).not.toContain("hidden_native")
    expect(serialized).not.toContain('"id":"unexpected"')
    expect(serialized).not.toContain('"type":"tool_started"')
  } finally {
    await manager.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})

it("completes two portable Chat turns while retaining native history and images", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-chat-native-"))
  const store = new JsonlThreadStore({ root: join(root, "store") })
  const tool = runtimeTool("mutate")
  const fallback = createStaticModelsManager("faux")
  const visualModel = {
    ...model,
    inputModalities: ["text", "image"] as const,
    imageDetailModes: ["high"] as const,
  }
  const models = { ...fallback, resolve: () => visualModel }
  const bodies: string[] = []
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON body")
      bodies.push(init.body)
      return new Response(
        `data: ${JSON.stringify({ id: `chat_${bodies.length}`, choices: [{ index: 0, delta: { role: "assistant", content: `answer ${bodies.length}` }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    })
  const stream = createChatCompletionsProvider({
    apiKey: "test-not-a-real-key",
    model: model.model,
    baseURL: "https://invalid.test/v1",
  })
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () =>
      createTurnLoop({
        toolRegistry: createToolRegistry([tool]),
        modelClient: {
          hasProvider: () => true,
          models: () => models,
          startTurn: () => ({
            models,
            stream,
            wireApi: "openai_chat_completions",
            close() {},
          }),
          close() {},
        },
      }),
  })
  try {
    const thread = await manager.createThread({
      workingDirectory: root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    await thread.startIfIdle({
      submissionId: "one",
      content: inputFixture([
        { type: "text", text: "Describe" },
        { type: "image", mediaType: "image/png", data: pngImageBase64 },
      ]),
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "answer 1" })
    const first = thread
      .snapshot()
      .context.history.filter(({ item }) => item.role === "assistant")
    expect(JSON.stringify(first)).toContain(
      '"wireApi":"openai_chat_completions"',
    )
    const original = structuredClone(first)
    await thread.startIfIdle({
      submissionId: "two",
      content: createUserInput("Explain further"),
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "answer 2" })
    expect(
      thread
        .snapshot()
        .context.history.filter(({ item }) => item.role === "assistant")
        .slice(0, first.length),
    ).toEqual(original)
    expect(bodies).toHaveLength(2)
    const secondBody = bodies[1]
    if (secondBody === undefined) throw new Error("Missing second request")
    const second = JSON.parse(secondBody)
    expect(second).not.toHaveProperty("tools")
    expect(second).not.toHaveProperty("tool_choice")
    expect(second.messages).toContainEqual({
      role: "assistant",
      content: "answer 1",
    })
    expect(bodies[1]).toContain(`data:image/png;base64,${pngImageBase64}`)
    expect(tool.execute).not.toHaveBeenCalled()
  } finally {
    await manager.shutdown()
    fetch.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
