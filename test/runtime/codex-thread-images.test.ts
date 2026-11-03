import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import { expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { createRolloutAssets } from "../../src/core/rollout-assets.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import type OpenAI from "openai"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createOpenAIProvider } from "../../src/runtime/openai-provider.ts"
import { createCodexProvider } from "../../src/runtime/codex-provider.ts"
import { createDiscoveringModelsManager } from "../../src/runtime/models-manager.ts"
import { inspectImageBytes } from "../../src/kernel/image-metadata.ts"
import { withSDKResponse } from "../support/sdk-response.ts"
import { inputFixture } from "../fixtures/user-input.ts"

it("preserves Codex tool-image pixels through actual execution, persistence and a reopened thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-codex-replay-"))
  const bytes = await sharp({
    create: { width: 2048, height: 2048, channels: 3, background: "red" },
  })
    .png()
    .toBuffer()
  await writeFile(join(root, "screen.png"), bytes)
  const bodies: string[] = []
  const client = withSDKResponse({
    responses: {
      async create(body: unknown) {
        bodies.push(JSON.stringify(body))
        const output =
          bodies.length === 1
            ? [
                {
                  type: "function_call",
                  id: "item_image",
                  call_id: "call_image",
                  name: "view_image",
                  arguments: '{"path":"screen.png"}',
                  status: "completed",
                },
              ]
            : [
                {
                  type: "message",
                  id: "message_done",
                  role: "assistant",
                  status: "completed",
                  content: [
                    { type: "output_text", text: "Inspected", annotations: [] },
                  ],
                },
              ]
        return (async function* () {
          yield {
            type: "response.completed",
            response: { id: `r_${bodies.length}`, status: "completed", output },
          }
        })()
      },
    },
  } as unknown as OpenAI)
  const open = () => {
    const store = new JsonlThreadStore({ root })
    const assets = createRolloutAssets(root, {
      withMutationLease: async (id, mutate) => {
        await mkdir(join(root, "rollouts", id), { recursive: true })
        return mutate()
      },
    })
    const models = createDiscoveringModelsManager({
      provider: "personal",
      identity: async () => "test-account",
      discover: async () => [
        {
          id: "gpt-6.1-sol",
          instructions: "Inspect images",
          contextWindowTokens: 272000,
          capabilities: {
            inputModalities: ["text", "image"],
            imageDetailModes: ["high", "original"],
            shellToolType: "unified_exec",
            fileEditingToolType: "none",
            supportsNativeToolSearch: false,
            supportsCustomTools: false,
          },
        },
      ],
    })
    const provider = createModelProvider({
      info: {
        id: "personal",
        serviceId: "codex",
        wireApi: "openai_responses",
        capabilities: { remoteCompaction: false },
      },
      models,
      createTurnStream: () =>
        createCodexProvider({
          auth: {
            async resolve() {
              return { accessToken: "test", accountId: "test-account" }
            },
            invalidate() {},
          },
          createStream: (options) =>
            createOpenAIProvider({ ...options, client }),
        }),
    })
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          modelClient: createProviderRegistry({
            personal: provider,
          }).createClient(),
          provider: "personal",
          model: "gpt-6.1-sol",
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
      throw new Error("Missing persisted Codex tool image")
    expect(storedImage.data).toBeUndefined()
    expect(await runtime.assets.read(storedImage.file)).toEqual(bytes)
    const assertPrepared = (body: string | undefined) => {
      const parsed = JSON.parse(body ?? "{}") as {
        input: {
          type: string
          output?: { type: string; image_url?: string; detail?: string }[]
        }[]
      }
      const images = parsed.input
        .flatMap((item) => (Array.isArray(item.output) ? item.output : []))
        .filter((block) => block.type === "input_image")
      expect(images).toHaveLength(1)
      expect(images[0]?.detail).toBe("high")
      expect(
        inspectImageBytes(
          Buffer.from(images[0]?.image_url?.split(",")[1] ?? "", "base64"),
        ),
      ).toMatchObject({ width: 1600, height: 1600 })
    }
    assertPrepared(bodies[1])
    await runtime.manager.shutdown()
    await runtime.provider.close?.()
    runtime = open()
    expect(await runtime.assets.read(storedImage.file)).toEqual(bytes)
    const resumed = await runtime.manager.resumeThread(thread.id)
    if (resumed === undefined) throw new Error("Missing resumed Codex thread")
    await resumed.startIfIdle({
      content: inputFixture([{ type: "text", text: "Inspect again" }]),
    })
    await expect
      .poll(() => resumed.agentStatus)
      .toEqual({ completed: "Inspected" })
    assertPrepared(bodies[2])
    expect(bodies).toHaveLength(3)
  } finally {
    await runtime.manager.shutdown()
    await runtime.provider.close?.()
    await rm(root, { recursive: true, force: true })
  }
})
