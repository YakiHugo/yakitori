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
    service: "stepfun",
    url: "https://api.stepfun.com/step_plan/v1",
    model: "step-3.7-flash",
    detail: "high",
    native: true,
  },
  {
    service: "stepfun",
    url: "https://api.stepfun.ai/step_plan/v1",
    model: "step-3.7-flash",
    detail: "high",
    native: true,
  },
  {
    service: "stepfun",
    url: "https://api.stepfun.com/v1",
    model: "step-3.7-flash",
    detail: "high",
    native: true,
  },
  {
    service: "stepfun",
    url: "https://api.stepfun.ai/v1",
    model: "step-3.7-flash",
    detail: "original",
    native: true,
  },
  {
    service: "stepfun",
    url: "https://api.stepfun.com/v1",
    model: "step-5-preview",
    detail: "high",
    native: true,
  },
  {
    service: "stepfun",
    url: "https://api.stepfun.com/v1",
    model: "step-5-preview",
    detail: "original",
    native: true,
  },
  {
    service: undefined,
    url: "https://api.stepfun.com/v1",
    model: "step-5-preview",
    detail: "high",
    native: false,
  },
  {
    service: "stepfun",
    url: "https://relay.example",
    model: "step-5-preview",
    detail: "high",
    native: false,
  },
  {
    service: "stepfun",
    url: "https://api.stepfun.ai/v1",
    model: "step-5-preview",
    detail: "high",
    native: true,
  },
] as const)("prepares tool image through real Turn for $service $url $model $detail", async ({
  service,
  url,
  model,
  detail,
  native,
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
    const first = {
      id: `chat_${bodies.length}`,
      choices: [
        {
          index: 0,
          delta: { reasoning: "Inspect the image first." },
          finish_reason:
            service === "stepfun" && url !== "https://relay.example"
              ? ""
              : null,
        },
      ],
    }
    return new Response(
      `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify({ id: `chat_${bodies.length}`, choices: [{ index: 0, delta, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  })
  const root = await mkdtemp(join(tmpdir(), "yakitori-stepfun-vision-"))
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
          ...(native
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
    expect(bodies).toHaveLength(2)
    const second = JSON.parse(bodies[1] ?? "")
    expect(second.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        reasoning: "Inspect the image first.",
        tool_calls: expect.any(Array),
      }),
    )
    expect(second.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_image",
        content: expect.any(String),
      }),
    )
    if (native) {
      expect(second.reasoning_effort).toBe("medium")
      expect(second).not.toHaveProperty("stream_options")
    }
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
    expect((await sharp(bytes).metadata()).width).toBe(3000)
    if (native) expect(bytes).toEqual(source)
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
