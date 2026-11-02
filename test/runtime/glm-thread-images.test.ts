import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import { expect, it, vi } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { createRolloutAssets } from "../../src/core/rollout-assets.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { inputFixture } from "../fixtures/user-input.ts"

it("preserves GLM tool-image pixels through actual execution, persistence and a reopened thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-glm-replay-"))
  const bytes = await sharp({
    create: { width: 3000, height: 20, channels: 3, background: "red" },
  })
    .png()
    .toBuffer()
  await writeFile(join(root, "screen.png"), bytes)
  const bodies: string[] = []
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, options) => {
      bodies.push(String(options?.body))
      const chunk = {
        id: `reply_${bodies.length}`,
        choices: [
          {
            index: 0,
            delta:
              bodies.length === 1
                ? {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_image",
                        type: "function",
                        function: {
                          name: "view_image",
                          arguments: '{"path":"screen.png"}',
                        },
                      },
                    ],
                  }
                : { content: "Inspected" },
            finish_reason: bodies.length === 1 ? "tool_calls" : "stop",
          },
        ],
      }
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    })
  const open = () => {
    const store = new JsonlThreadStore({ root })
    const assets = createRolloutAssets(root, {
      withMutationLease: async (id, mutate) => {
        await mkdir(join(root, "rollouts", id), { recursive: true })
        return mutate()
      },
    })
    const provider = createConfiguredProvider(
      "personal",
      {
        name: "GLM",
        service: "glm",
        wireApi: "openai_chat_completions",
        baseURL: "https://api.z.ai/api/paas/v4/",
        models: [{ id: "glm-5.3-flash" }],
      },
      "unused",
    )
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          modelClient: createProviderRegistry({
            personal: provider,
          }).createClient(),
          provider: "personal",
          model: "glm-5.3-flash",
          toolRegistry: createToolRegistry(),
          rolloutAssets: assets,
          baseInstructions: "Inspect images",
          loadProjectInstructions: async () => undefined,
        }),
    })
    return { manager, store, assets, provider }
  }
  let runtime = open()
  try {
    const thread = await runtime.manager.createThread({
      workingDirectory: root,
      mateId: "mate_test",
      mateRevisionId: "revision_test",
    })
    await thread.startIfIdle({
      content: inputFixture([{ type: "text", text: "Inspect screen.png" }]),
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "Inspected" })
    const history = thread.snapshot().context.history.map((entry) => entry.item)
    const storedImage = history
      .find((message) => message.role === "tool")
      ?.content.find((block) => block.type === "image")
    if (storedImage?.type !== "image" || storedImage.file === undefined)
      throw new Error("Missing persisted GLM tool image")
    expect(storedImage.data).toBeUndefined()
    expect(await runtime.assets.read(storedImage.file)).toEqual(bytes)
    const expected = {
      role: "user",
      content: [
        {
          type: "text",
          text: 'Image from tool result "call_image", content part 2:',
        },
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${bytes.toString("base64")}`,
          },
        },
      ],
    }
    expect(JSON.parse(bodies[1] ?? "{}").messages).toContainEqual(expected)
    await runtime.manager.shutdown()
    await runtime.provider.close?.()
    runtime = open()
    expect(await runtime.assets.read(storedImage.file)).toEqual(bytes)
    const resumed = await runtime.manager.resumeThread(thread.id)
    if (resumed === undefined) throw new Error("Missing resumed GLM thread")
    await resumed.startIfIdle({
      content: inputFixture([{ type: "text", text: "Inspect again" }]),
    })
    await expect
      .poll(() => resumed.agentStatus)
      .toEqual({ completed: "Inspected" })
    expect(JSON.parse(bodies[2] ?? "{}").messages).toContainEqual(expected)
    expect(bodies).toHaveLength(3)
  } finally {
    await runtime.manager.shutdown()
    await runtime.provider.close?.()
    fetch.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
