import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import { afterEach, expect, it, vi } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { createRolloutAssets } from "../../src/core/rollout-assets.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { inputFixture } from "../fixtures/user-input.ts"

afterEach(() => vi.restoreAllMocks())

it("retains original user image bytes across two real chat-only Turns without tool exposure", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-longcat-turn-"))
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
  const assets = createRolloutAssets(root, {
    withMutationLease: async (id, mutate) => {
      await mkdir(join(root, "rollouts", id), { recursive: true })
      return mutate()
    },
  })
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async () =>
        new Response(
          'data: {"id":"chat","choices":[{"index":0,"delta":{"reasoning_content":"private reasoning"},"finish_reason":null}]}\n\ndata: {"id":"chat","choices":[{"index":0,"delta":{"content":"Described"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
    )
  const tools = createToolRegistry([])
  const registry = createProviderRegistry({
    personal: createConfiguredProvider(
      "personal",
      {
        name: "Renamed account",
        service: "longcat",
        baseURL: "https://api.longcat.chat/openai/v1",
        wireApi: "openai_chat_completions",
        models: [{ id: "LongCat-2.5" }],
      },
      "fixture-key",
    ),
  })
  const manager = new ThreadManager({
    store: new JsonlThreadStore({ root }),
    createTurnProcessor: () =>
      createTurnProcessor({
        modelClient: registry.createClient(),
        provider: "personal",
        model: "LongCat-2.5",
        rolloutAssets: assets,
        toolRegistry: tools,
        loadProjectInstructions: async () => undefined,
      }),
  })
  try {
    const thread = await manager.createThread({
      workingDirectory: root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    const saved = await assets.saveToolFile(
      thread.id,
      "user-image",
      "original.png",
      source,
    )
    const attachment = {
      type: "image" as const,
      name: "original.png",
      mediaType: "image/png" as const,
      detail: "high" as const,
      file: saved.reference,
      sizeBytes: source.length,
    }
    await thread.startIfIdle({
      content: inputFixture([{ type: "text", text: "Describe" }, attachment]),
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "Described" })
    await thread.startIfIdle({
      content: inputFixture([{ type: "text", text: "Describe again" }]),
    })
    await expect.poll(() => fetch.mock.calls.length).toBe(2)
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "Described" })
    for (const [, init] of fetch.mock.calls) {
      const body = JSON.parse(String(init?.body))
      expect(body).not.toHaveProperty("tools")
      expect(body).not.toHaveProperty("reasoning_effort")
      expect(String(init?.body)).not.toContain("private reasoning")
      expect(body.messages).toContainEqual(
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("cannot call tools"),
        }),
      )
      const parts: { type: string; image_url?: { url: string } }[] =
        body.messages.flatMap((message: { content: unknown }) =>
          Array.isArray(message.content) ? message.content : [],
        )
      expect(parts.find((part) => part.type === "image_url")).toEqual({
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${source.toString("base64")}`,
        },
      })
    }
    expect(await assets.read(saved.reference)).toEqual(source)
  } finally {
    await manager.shutdown()
    await registry.close()
    await tools.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
