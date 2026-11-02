import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import { createModelRouter } from "../../src/server/model-router.ts"
import type { ModelRequest } from "../../src/runtime/model.ts"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import { createTurnLoop } from "../../src/runtime/turn-loop.ts"
import { inputFixture } from "../fixtures/user-input.ts"
import { afterEach, expect, it, vi } from "vitest"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { createModelDirectory } from "../../src/server/model-directory.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { captureStepContext } from "../../src/runtime/tools/spec-plan.ts"
import { createTencentImagePolicy } from "../../src/runtime/tencent-image-policy.ts"
import { tencentVisionModel } from "../../src/runtime/tencent-chat-only.ts"
import { pngImageBase64 } from "../fixtures/images.ts"

const selection = { provider: "renamed-account", model: tencentVisionModel }
function provider(
  baseURL = "https://tokenhub.tencentmaas.com/v1",
  service = "tencent",
) {
  return createConfiguredProvider(
    selection.provider,
    {
      name: "Editable account label",
      service,
      baseURL,
      wireApi: "openai_chat_completions",
      models: [
        {
          id: tencentVisionModel,
          contextWindowTokens: 999_999,
          maxOutputTokens: 999_999,
          inputModalities: ["text", "image", "video"],
          efforts: ["high"],
        },
      ],
    },
    "not-a-real-key",
  )
}
afterEach(() => vi.restoreAllMocks())

it.each([
  "https://tokenhub.tencentmaas.com/v1",
  "https://tokenhub-intl.tencentmaas.com/v1",
  "https://tokenhub.tencentmaas.cn/v1",
  "https://tokenhub-intl.tencentmaas.cn/v1",
])("binds chat-only execution to the exact service endpoint %s", async (url) => {
  const p = provider(url)
  const registry = createProviderRegistry({ [selection.provider]: p })
  try {
    const model = registry.models(selection.provider).resolve(selection)
    expect(model.toolPolicy).toBe("chat_only")
    expect(model.inputModalities).toEqual(["text", "image"])
    expect(model.efforts).toEqual([])
    expect(model.maxOutputTokens).toBe(16_000)
    expect(model.instructions).toContain("cannot call tools")
    expect(
      registry.models(selection.provider).capacity(selection),
    ).toMatchObject({
      contextWindowTokens: 24_000,
      contextWindowScope: "input",
    })
    expect(
      await createModelDirectory(registry).listModels(selection.provider),
    ).toMatchObject([{ toolPolicy: "chat_only" }])
    const config = SessionConfiguration.create(
      {
        selection,
        workspaceRoot: "/tmp",
        enabledTools: ["exec_command"],
        approvalPolicy: "always_approve",
        promptCacheKey: "fixture",
      },
      registry.models(selection.provider),
    )
    const captured = captureStepContext({
      configuration: config.resolveStep(
        selection,
        registry.models(selection.provider),
      ),
      registry: createToolRegistry([]),
      serviceId: "tencent",
      wireApi: "openai_chat_completions",
    })
    expect(captured.deferImagePreparation).toBe(true)
  } finally {
    await registry.close()
  }
})

it.each([
  ["https://relay.example/v1", "tencent"],
  ["https://tokenhub.tencentmaas.com/proxy/v1", "tencent"],
  ["https://tokenhub.tencentmaas.com/v1", "openrouter"],
])("does not infer official capability from a model or label (%s)", async (url, service) => {
  const p = provider(url, service)
  expect(p.models.resolve(selection).toolPolicy).toBeUndefined()
  await p.close?.()
})

it("sends original images with Bearer credentials and no tool or detail fields", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(
        'data: {"id":"chat","choices":[{"index":0,"delta":{"role":"assistant","content":"A picture"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
  const p = provider()
  const registry = createProviderRegistry({ [selection.provider]: p })
  try {
    const events = await Array.fromAsync(
      registry.stream({
        target: { ...selection, instructionProfileId: "default" },
        system: [],
        tools: [],
        toolWireProtocol: "eager",
        messages: [
          {
            role: "user",
            content: [
              { type: "image", mediaType: "image/png", data: pngImageBase64 },
            ],
          },
        ],
      }),
    )
    expect(events.at(-1)?.type).toBe("response")
    expect(fetch).toHaveBeenCalledTimes(1)
    const call = fetch.mock.calls[0]
    if (call === undefined) throw new Error("Missing request")
    const [url, init] = call
    expect(String(url)).toBe(
      "https://tokenhub.tencentmaas.com/v1/chat/completions",
    )
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer not-a-real-key",
    )
    const body = JSON.parse(String(init?.body))
    expect(body.model).toBe(tencentVisionModel)
    expect(body).not.toHaveProperty("tools")
    expect(body).not.toHaveProperty("tool_choice")
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${pngImageBase64}` },
          },
        ],
      },
    ])
  } finally {
    await registry.close()
  }
})

it("bounds the complete JSON request, including text beyond image bytes", () => {
  const policy = createTencentImagePolicy()
  // Use one shared string repeatedly: check the real wire size without an
  // equally large serialized intermediate allocation.
  const chunk = "x".repeat(1_000_000)
  expect(() =>
    policy.validateBody({ messages: Array(100).fill(chunk) }),
  ).toThrow("100 MB")
  expect(() =>
    policy.validateBody({ messages: Array(99).fill(chunk) }),
  ).not.toThrow()
})

it("completes two real configured TokenHub turns with immutable native history and original images", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-tencent-"))
  const { default: sharp } = await import("sharp")
  const originalImage = (
    await sharp({
      create: { width: 3000, height: 8, channels: 3, background: "red" },
    })
      .jpeg()
      .toBuffer()
  ).toString("base64")
  const bodies: string[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    bodies.push(String(init?.body))
    return new Response(
      `data: ${JSON.stringify({ id: `chat_${bodies.length}`, choices: [{ index: 0, delta: { role: "assistant", content: `answer ${bodies.length}` }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  })
  const registry = createProviderRegistry({ [selection.provider]: provider() })
  const execute = vi.fn(async () => ({
    ok: true as const,
    output: {},
    content: "must not run",
  }))
  const manager = new ThreadManager({
    store: new JsonlThreadStore({ root: join(root, "store") }),
    createTurnProcessor: () =>
      createTurnLoop({
        modelClient: registry.createClient(),
        toolRegistry: createToolRegistry([
          {
            toolName: { name: "mutate" },
            description: "mutate",
            inputSchema: { type: "object" },
            effect: "mutate",
            approvalRequirement: { kind: "none" },
            execute,
          },
        ]),
      }),
  })
  try {
    const config = SessionConfiguration.create(
      {
        selection,
        workspaceRoot: root,
        enabledTools: ["mutate"],
        approvalPolicy: "always_approve",
        promptCacheKey: "fixture",
      },
      registry.models(selection.provider),
    )
    const thread = await manager.createThread({
      workingDirectory: root,
      mateId: "mate",
      mateRevisionId: "revision",
      initialConfiguration: config.snapshot,
    })
    await thread.startIfIdle({
      submissionId: "one",
      content: inputFixture([
        { type: "text", text: "Describe" },
        { type: "image", mediaType: "image/jpeg", data: originalImage },
      ]),
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "answer 1" })
    const original = structuredClone(
      thread
        .snapshot()
        .context.history.filter(({ item }) => item.role === "assistant"),
    )
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
        .slice(0, original.length),
    ).toEqual(original)
    expect(bodies).toHaveLength(2)
    for (const encoded of bodies) {
      const body = JSON.parse(encoded)
      expect(body).not.toHaveProperty("tools")
      expect(body).not.toHaveProperty("tool_choice")
      expect(encoded).toContain(`data:image/jpeg;base64,${originalImage}`)
      expect(encoded).toContain("cannot call tools")
      expect(encoded).not.toContain('"detail"')
    }
    const second = bodies[1]
    if (second === undefined) throw new Error("Missing second request")
    expect(JSON.parse(second).messages).toContainEqual({
      role: "assistant",
      content: "answer 1",
    })
    expect(execute).not.toHaveBeenCalled()
  } finally {
    await manager.shutdown()
    await registry.close()
    await rm(root, { recursive: true, force: true })
  }
})

it("preserves restrictions across discovery refresh and user settings", async () => {
  const p = createConfiguredProvider(
    selection.provider,
    {
      name: "Renamed",
      service: "tencent",
      baseURL: "https://tokenhub.tencentmaas.com/v1",
      wireApi: "openai_chat_completions",
      models: [{ id: tencentVisionModel }],
    },
    "fixture",
    {
      loadModels: async () => [
        {
          id: tencentVisionModel,
          efforts: ["max"],
          contextWindowTokens: 999_999,
          maxOutputTokens: 999_999,
        },
      ],
      result() {},
    },
  )
  const registry = createProviderRegistry(
    { [selection.provider]: p },
    {
      settings: () => ({
        [tencentVisionModel]: {
          contextWindowTokens: 8_000,
          maxOutputTokens: 2_000,
          contextWindowScope: "total",
          efforts: ["high"],
          defaultEffort: "high",
          speeds: ["fast"],
          inputModalities: ["video"],
          imageDetailModes: ["original"],
        },
      }),
    },
  )
  try {
    await registry.models(selection.provider).refresh({ force: true })
    expect(
      registry.models(selection.provider).resolve(selection),
    ).toMatchObject({
      toolPolicy: "chat_only",
      efforts: [],
      speeds: [],
      inputModalities: ["text", "image"],
      imageDetailModes: ["high"],
      maxOutputTokens: 2_000,
      defaultOutputTokens: 2_000,
    })
    expect(
      registry.models(selection.provider).capacity(selection),
    ).toMatchObject({ contextWindowTokens: 8_000, contextWindowScope: "input" })
    expect(
      await registry.models(selection.provider).listModels(),
    ).toMatchObject([{ toolPolicy: "chat_only" }])
  } finally {
    await registry.close()
  }
})

it("reports the selected account's restriction rather than a logical capability union", async () => {
  const relay = createConfiguredProvider(
    "relay",
    {
      name: "Relay",
      wireApi: "openai_chat_completions",
      baseURL: "https://relay.example/v1",
      models: [{ id: "alias" }],
    },
    "fixture",
  )
  const registry = createProviderRegistry({
    [selection.provider]: provider(),
    relay,
  })
  try {
    const directory = createModelDirectory(registry)
    const router = createModelRouter({
      registry,
      readAccounts: async () => [
        {
          accountId: selection.provider,
          namespace: "tencent",
          serviceName: "Tencent",
          summary: {
            name: selection.provider,
            models: await directory.listModels(selection.provider),
          },
        },
        {
          accountId: "relay",
          namespace: "relay",
          serviceName: "Relay",
          identities: {
            alias: { namespace: "tencent", model: tencentVisionModel },
          },
          summary: {
            name: "relay",
            models: await directory.listModels("relay"),
          },
        },
      ],
    })
    await router.refresh()
    const logical = { provider: "tencent", model: tencentVisionModel }
    expect(router.preview(logical)).toMatchObject({
      toolPolicy: "chat_only",
      target: selection,
    })
    expect(
      router.preview(logical, { preferredAccount: "relay" }).toolPolicy,
    ).toBeUndefined()
    expect(
      router.preview(logical, { preferredAccount: "relay" }).target?.provider,
    ).toBe("relay")
  } finally {
    await registry.close()
  }
})

it("rejects old tool history without changing it and permits a fresh conversation", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(
        'data: {"id":"chat","choices":[{"index":0,"delta":{"role":"assistant","content":"fresh"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
  const registry = createProviderRegistry({ [selection.provider]: provider() })
  const request: ModelRequest = {
    target: { ...selection, instructionProfileId: "default" },
    system: [],
    tools: [],
    toolWireProtocol: "eager",
    messages: [
      { role: "user", content: [{ type: "text", text: "keep this" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call",
            name: "mutate",
            input: { path: "original" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call",
        content: [{ type: "text", text: "original result" }],
      },
    ],
  }
  const original = structuredClone(request)
  try {
    const events = await Array.fromAsync(registry.stream(request))
    expect(JSON.stringify(events)).toContain("Start a new conversation")
    expect(request).toEqual(original)
    expect(fetch).not.toHaveBeenCalled()
    const fresh = await Array.fromAsync(
      registry.stream({ ...request, messages: request.messages.slice(0, 1) }),
    )
    expect(fresh.at(-1)?.type).toBe("response")
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(request).toEqual(original)
  } finally {
    await registry.close()
  }
})

it("projects chat-only instructions without destroying an older model-owned coding prompt", async () => {
  const old = provider("https://relay.example/v1")
  const current = provider()
  try {
    const config = SessionConfiguration.create(
      {
        selection,
        workspaceRoot: "/tmp",
        enabledTools: [],
        approvalPolicy: "always_approve",
        promptCacheKey: "old",
      },
      old.models,
    )
    const original = structuredClone(config.snapshot)
    const projected = config.resolveStep(selection, current.models)
    expect(projected.baseInstructions.text).toBe(
      projected.modelInstructions.text,
    )
    expect(projected.baseInstructions.text).toContain("cannot call tools")
    expect(config.snapshot).toEqual(original)
    expect(
      config.resolveStep(selection, old.models).baseInstructions.text,
    ).toBe(original.baseInstructions.text)
  } finally {
    await old.close?.()
    await current.close?.()
  }
})

it("rejects direct TokenHub transport tool controls before any network request", async () => {
  const fetch = vi.spyOn(globalThis, "fetch")
  const stream = createChatCompletionsProvider({
    apiKey: "fixture",
    baseURL: "https://tokenhub.tencentmaas.com/v1",
    model: tencentVisionModel,
    flavor: "tencent",
  })
  const events = await Array.fromAsync(
    stream({
      target: { ...selection, instructionProfileId: "default" },
      system: [],
      messages: [],
      tools: [],
      toolWireProtocol: "eager",
      providerOptions: {
        provider: selection.provider,
        wireApi: "openai_chat_completions",
        body: { enable_search: true },
      },
    }),
  )
  expect(events).toMatchObject([
    {
      type: "failure",
      failure: { kind: "invalid_request", stage: "request_build" },
    },
  ])
  expect(fetch).not.toHaveBeenCalled()
})
