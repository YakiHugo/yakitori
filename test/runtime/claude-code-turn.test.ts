import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import { afterEach, expect, it, vi } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import {
  createToolRegistry,
  plainToolName,
} from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { inputFixture } from "../fixtures/user-input.ts"

afterEach(() => vi.restoreAllMocks())

it.each([
  {
    service: "anthropic",
    url: "https://api.anthropic.com",
    model: "claude-fable-5-1",
    detail: "high",
    width: 3000,
  },
  {
    service: "anthropic",
    url: "https://api.anthropic.com",
    model: "claude-sonnet-5-5",
    detail: "original",
    width: 3000,
  },
  {
    service: "anthropic",
    url: "https://api.anthropic.com",
    model: "claude-haiku-4-5-20251001",
    detail: "high",
    width: 3000,
  },
  {
    service: "anthropic",
    url: "https://relay.example",
    model: "claude-sonnet-5-5",
    detail: "high",
    width: 2048,
  },
] as const)("prepares tool images through real Turn for $url $model $detail", async ({
  service,
  url,
  model,
  detail,
  width,
}) => {
  const source = await sharp({
    create: {
      width: 3000,
      height: 100,
      channels: 4,
      background: { r: 20, g: 30, b: 40, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer()
  const image = {
    type: "image" as const,
    mediaType: "image/png" as const,
    data: source.toString("base64"),
    detail,
  }
  const bodies: string[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (typeof init?.body !== "string") throw new Error("Expected request body")
    expect(new Headers(init.headers).get("x-api-key")).toBe("test")
    bodies.push(init.body)
    const content =
      bodies.length === 1
        ? [
            {
              type: "thinking",
              thinking: "Inspect the image first.",
              signature: "opaque-signature",
            },
            { type: "tool_use", id: "call_image", name: "inspect", input: {} },
          ]
        : [{ type: "text", text: "Inspected" }]
    const events = [
      {
        type: "message_start",
        message: {
          id: `msg_${bodies.length}`,
          role: "assistant",
          content: [],
          model,
          usage: { input_tokens: 5, output_tokens: 0 },
          stop_reason: null,
          ...(bodies.length === 2 &&
          width === 3000 &&
          model !== "claude-haiku-4-5-20251001"
            ? {
                input_transformations: [
                  {
                    type: "thinking_dropped",
                    reason: "prefix_binding_mismatch",
                    path: "messages.1.content.0",
                  },
                ],
              }
            : {}),
        },
      },
      ...content.flatMap((content_block, index) => [
        { type: "content_block_start", index, content_block },
        { type: "content_block_stop", index },
      ]),
      {
        type: "message_delta",
        delta: { stop_reason: bodies.length === 1 ? "tool_use" : "end_turn" },
        usage: { output_tokens: 4 },
      },
      { type: "message_stop" },
    ]
    return new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    )
  })
  const root = await mkdtemp(join(tmpdir(), "yakitori-claude-code-"))
  const tools = createToolRegistry([
    {
      toolName: plainToolName("inspect"),
      description: "Inspect",
      inputSchema: { type: "object" },
      effect: "observe",
      approvalRequirement: { kind: "none" },
      async execute() {
        return {
          ok: true,
          output: "Image",
          content: "Image",
          presentation: {
            toModelContent() {
              return { content: [image] }
            },
          },
        }
      },
    },
  ])
  const provider = createConfiguredProvider(
    "personal",
    {
      name: "My account",
      ...(service === undefined ? {} : { service }),
      baseURL: url,
      wireApi: "anthropic_messages",
      // Explicit vision metadata on negative controls tests that an opted-in
      // custom model still does not acquire a native provider preparation policy.
      models: [
        {
          id: model,
          ...(width === 3000
            ? {}
            : {
                inputModalities: ["text", "image"],
                imageDetailModes: ["high"],
              }),
        },
      ],
    },
    "test",
  )
  const manager = new ThreadManager({
    store: new JsonlThreadStore({ root }),
    createTurnProcessor: () =>
      createTurnProcessor({
        modelClient: createProviderRegistry({
          personal: provider,
        }).createClient(),
        provider: "personal",
        model,
        toolRegistry: tools,
        baseInstructions: "Inspect image",
        loadProjectInstructions: async () => undefined,
      }),
  })
  try {
    const thread = await manager.createThread({
      workingDirectory: root,
      mateId: "mate_test",
      mateRevisionId: "revision_test",
    })
    await thread.startIfIdle({
      content: inputFixture([{ type: "text", text: "Inspect" }]),
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "Inspected" })
    const warnings = []
    for (;;) {
      const event = await thread.nextEvent()
      if (event === undefined) throw new Error("Missing terminal event")
      if (
        event.type === "runtime.warning" &&
        event.code === "anthropic.thinking_transformed"
      )
        warnings.push(event)
      if (event.type === "turn.completed") break
    }
    expect(warnings).toHaveLength(
      width === 3000 && model !== "claude-haiku-4-5-20251001" ? 1 : 0,
    )
    if (warnings.length) expect(warnings[0]?.message).toContain("extra tokens")
    expect(bodies).toHaveLength(2)
    const second = JSON.parse(bodies[1] ?? "")
    expect(second.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([
          {
            type: "thinking",
            thinking: "Inspect the image first.",
            signature: "opaque-signature",
          },
          expect.objectContaining({
            type: "tool_use",
            id: "call_image",
            name: "inspect",
          }),
        ]),
      }),
    )
    const toolResult = second.messages
      .flatMap((message: { content: unknown[] }) => message.content)
      .find((block: { type: string }) => block.type === "tool_result")
    expect(toolResult).toMatchObject({ tool_use_id: "call_image" })
    const sentImage = toolResult.content.find(
      (block: { type: string }) => block.type === "image",
    )
    const bytes = Buffer.from(sentImage.source.data, "base64")
    expect((await sharp(bytes).metadata()).width).toBe(width)
    if (width === 3000) expect(bytes).toEqual(source)
    expect(JSON.stringify(second.system)).toContain("Inspect image")
    const tool = thread
      .snapshot()
      .context.history.map((entry) => entry.item)
      .find((message) => message.role === "tool")
    expect(tool?.content).toContainEqual(image)
  } finally {
    await manager.shutdown()
    await tools.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
