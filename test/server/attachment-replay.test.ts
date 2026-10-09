import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { inputContentAttachments } from "../../src/core/user-input.ts"
import { ModelStopReason } from "../../src/runtime/model.ts"
import {
  createYakitoriApplication,
  type YakitoriApplication,
} from "../../src/server/application.ts"
import { inputFixture } from "../fixtures/user-input.ts"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6jYAAAAAASUVORK5CYII=",
  "base64",
)

describe("attachment admission replay", () => {
  it.each([
    false,
    true,
  ])("replays an original cross-rollout draft after cleanup (reopen: %s)", async (reopen) => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-attachment-replay-"))
    let app: YakitoriApplication | undefined
    let modelCalls = 0
    const options = {
      rootDir: join(root, "state"),
      workspace: root,
      userConfigPath: join(root, "config.toml"),
      provider: "faux",
      model: "faux-test",
      async *stream() {
        modelCalls += 1
        yield {
          type: "response" as const,
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [{ type: "text" as const, text: "done" }],
          },
        }
      },
    }
    try {
      app = await createYakitoriApplication(options)
      // Desktop attachments selected before a first send have their own
      // draft rollout; the newly created session copies them on admission.
      const [draft] = await app.rolloutAssets.importAttachmentBytes(
        "draft_before_session",
        "draft_original",
        [{ name: "image.png", data: png }],
      )
      if (draft === undefined) throw new Error("Missing imported draft")
      const created = await app.handlers.createSession({})
      if (!created.ok) throw new Error(created.error.message)
      const request = {
        sessionId: created.value.session.id,
        requestId: "request_original",
        content: inputFixture([
          { type: "text", text: "Explain this image" },
          { type: "image", ...draft },
        ]),
      }
      const submitted = await app.handlers.admitInput(request)
      if (!submitted.ok) throw new Error(submitted.error.message)
      await vi.waitFor(() =>
        expect(app?.threadManager.runningTurnCount).toBe(0),
      )
      await vi.waitFor(async () => {
        await expect(app?.rolloutAssets.read(draft.file)).rejects.toMatchObject(
          { code: "ENOENT" },
        )
      })
      if (reopen) {
        await app.close()
        app = await createYakitoriApplication(options)
      }
      // A lost response leaves the renderer with the original source reference.
      const replayed = await app.handlers.admitInput(request)
      expect(replayed).toMatchObject({ ok: true, value: submitted.value })
      expect(modelCalls).toBe(1)
      const changedText = await app.handlers.admitInput({
        ...request,
        content: inputFixture([
          { type: "text", text: "Different input" },
          { type: "image", ...draft },
        ]),
      })
      expect(changedText).toMatchObject({
        ok: false,
        error: { code: "conflict" },
      })
      const changed = Buffer.from(png)
      changed[12] = 1
      const [replacement] = await app.rolloutAssets.importAttachmentBytes(
        "draft_replacement",
        "different_source",
        [{ name: "image.png", data: changed }],
      )
      if (replacement === undefined)
        throw new Error("Missing replacement draft")
      const changedImage = await app.handlers.admitInput({
        ...request,
        content: inputFixture([
          { type: "text", text: "Explain this image" },
          { type: "image", ...replacement },
        ]),
      })
      expect(changedImage).toMatchObject({
        ok: false,
        error: { code: "conflict" },
      })
      const [accepted] = inputContentAttachments(submitted.value.content)
      if (accepted === undefined) throw new Error("Missing accepted media")
      expect(await app.rolloutAssets.read(accepted.file)).toEqual(png)
      expect(await app.rolloutAssets.read(replacement.file)).toEqual(changed)
      expect(modelCalls).toBe(1)
    } finally {
      await app?.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
