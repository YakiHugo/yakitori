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
    service: "deepseek",
    url: "https://api.deepseek.com",
    model: "deepseek-flash",
    detail: "high",
    width: 3000,
  },
  {
    service: "deepseek",
    url: "https://api.deepseek.com",
    model: "deepseek-flash",
    detail: "original",
    width: 3000,
  },
  {
    service: undefined,
    url: "https://api.deepseek.com",
    model: "deepseek-flash",
    detail: "high",
    width: 3000,
  },
  {
    service: "deepseek",
    url: "https://relay.example",
    model: "deepseek-flash",
    detail: "high",
    width: 3000,
  },
  {
    service: "deepseek",
    url: "https://api.deepseek.com",
    model: "deepseek-chat",
    detail: "high",
    width: 3000,
  },
] as const)("prepares tool image through real Turn for $service $url $model $detail", async ({
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
    bodies.push(init.body)
    const delta =
      bodies.length === 1
        ? {
            tool_calls: [
              {
                index: 0,
                id: "call_image",
                type: "function",
                function: { name: "inspect", arguments: "{}" },
              },
            ],
          }
        : { content: "Inspected" }
    return new Response(
      `data: ${JSON.stringify({ id: `chat_${bodies.length}`, choices: [{ index: 0, delta, finish_reason: bodies.length === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  })
  const root = await mkdtemp(join(tmpdir(), "yakitori-deepseek-vision-"))
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
      wireApi: "openai_chat_completions",
      // Explicit vision metadata on negative controls tests that an opted-in
      // custom model still does not acquire a native provider preparation policy.
      models: [
        {
          id: model,
          inputModalities: ["text", "image"],
          imageDetailModes: ["high", "original"],
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
    expect(bodies).toHaveLength(2)
    const outgoing: {
      role: string
      content: string | { type: string; image_url?: { url: string } }[]
    }[] = JSON.parse(bodies[1] ?? "").messages
    const sentImage = outgoing
      .flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      )
      .find((block) => block.type === "image_url")
    if (!sentImage?.image_url) throw new Error("Missing outgoing image")
    const bytes = Buffer.from(
      sentImage.image_url.url.split(",")[1] ?? "",
      "base64",
    )
    expect((await sharp(bytes).metadata()).width).toBe(width)
    if (width === 3000) expect(bytes).toEqual(source)
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
