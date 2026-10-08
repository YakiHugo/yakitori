import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createRolloutAssets } from "../../src/core/rollout-assets.ts"
import { inputContentAttachments } from "../../src/core/user-input.ts"
import { ModelStopReason } from "../../src/runtime/model.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import {
  createSideChatService,
  type SideChatSnapshot,
} from "../../src/server/side-chat.ts"
import { inputFixture } from "../fixtures/user-input.ts"
import {
  createFakeHandlers,
  createTestProcessor,
  initializeConnection,
  openTestConnection,
  waitForCondition,
} from "./rpc/testkit.ts"

// A valid 1×1 PNG keeps the real staging→request file transfer in this test.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6jYAAAAAASUVORK5CYII=",
  "base64",
)

describe("side conversation admission and draft cleanup", () => {
  it("preserves an admitted input and its idempotent response when draft cleanup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-side-admission-"))
    const assets = createRolloutAssets(root, {
      async withMutationLease(id, mutate) {
        await mkdir(join(root, "rollouts", id), { recursive: true })
        return mutate()
      },
    })
    const cleanupError = Object.assign(new Error("Draft unlink failed"), {
      code: "EIO",
    })
    const errors: unknown[] = []
    let turns = 0
    const service = createSideChatService({
      defaultCwd: root,
      defaultModel: { provider: "faux", model: "initial-model" },
      mateId: "test-mate",
      mateRevisionId: "test-revision",
      rolloutAssets: {
        ...assets,
        async discardDraftAttachments() {
          throw cleanupError
        },
      },
      createProcessor: () =>
        createTurnProcessor({
          async *stream() {
            turns += 1
            yield {
              type: "response",
              response: {
                stopReason: ModelStopReason.EndTurn,
                content: [{ type: "text", text: "accepted image" }],
              },
            }
          },
          rolloutAssets: assets,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
      releaseAssets: (id) => assets.discardEphemeralRolloutFiles(id),
      changed() {},
      reportError: (error) => errors.push(error),
    })
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers(),
      sideChats: service,
    })
    const connection = openTestConnection(processor)
    try {
      await initializeConnection(connection)
      const created = await service.create({})
      const [draft] = await service.importAttachmentBytes(created.id, "draft", [
        { name: "image.png", data: png },
      ])
      if (draft === undefined) throw new Error("Missing imported image")
      const request = {
        sideChatId: created.id,
        requestId: "image_request",
        modelSelection: { provider: "faux", model: "selected-model" },
        content: inputFixture([
          { type: "text", text: "Explain this image" },
          { type: "image", ...draft },
        ]),
      }
      const response = await connection.sendRequest("sideChat/send", request)
      await waitForCondition(() => turns === 1)
      await waitForCondition(
        () => service.read(created.id).activeTurnId === undefined,
      )
      const repeated = await connection.sendRequest("sideChat/send", request)
      expect(repeated).toHaveProperty("result")
      const result = (repeated as { result: SideChatSnapshot }).result
      expect(result.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ])
      expect(result.modelSelection).toEqual(request.modelSelection)
      expect(response).toHaveProperty("result")
      expect(turns).toBe(1)
      expect(errors).toEqual([cleanupError])
      const admitted = result.messages[0]
      if (admitted?.role !== "user") throw new Error("Missing admitted input")
      const [attachment] = inputContentAttachments(admitted.content)
      if (attachment === undefined) throw new Error("Missing admitted image")
      expect(attachment.file).toMatchObject({
        rolloutId: created.id,
        path: expect.stringMatching(/^attachments\/requests\//),
      })
      expect(await assets.read(attachment.file)).toEqual(png)
    } finally {
      await processor.closeConnection(connection.id)
      await service.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
