import { mkdtemp, rm, writeFile } from "node:fs/promises"
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
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
  "base64",
)

describe("attachment admission reconciliation", () => {
  it.each([
    false,
    true,
  ])("recovers promoted attachments from history after draft cleanup (reopen: %s)", async (reopen) => {
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
      // A lost response is reconciled from history using its original ID.
      const replayed = await app.handlers.admitInput(request)
      expect(replayed).toMatchObject({ ok: false, error: { code: "conflict" } })
      const history = await app.handlers.readSessionEvents({
        sessionId: request.sessionId,
      })
      if (!history.ok) throw new Error(history.error.message)
      expect(
        history.value.events.filter((event) => event.type === "input.admitted"),
      ).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            requestId: request.requestId,
            content: submitted.value.content,
          }),
        }),
      ])
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
      const changed = Buffer.concat([
        png,
        Buffer.from("different source bytes"),
      ])
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

it.each([
  false,
  true,
])("rejects corrupt draft pixels before admission and preserves the draft for correction (same rollout: %s)", async (sameRollout) => {
  const root = await mkdtemp(
    join(tmpdir(), "yakitori-invalid-image-admission-"),
  )
  let app: YakitoriApplication | undefined
  let modelCalls = 0
  try {
    app = await createYakitoriApplication({
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
    })
    const created = await app.handlers.createSession({})
    if (!created.ok) throw new Error(created.error.message)
    const sessionId = created.value.session.id
    const rolloutId = (await app.threadStore.readThread(sessionId))?.metadata
      .rolloutId
    if (!rolloutId) throw new Error("Missing rollout")
    const [draft] = await app.rolloutAssets.importAttachmentBytes(
      sameRollout ? rolloutId : "draft_corrupt_image",
      "draft_original",
      [{ name: "image.png", data: png }],
    )
    if (!draft) throw new Error("Missing draft")
    const corrupt = Buffer.from(png)
    corrupt.fill(0, 24)
    await writeFile(app.rolloutAssets.resolve(draft.file), corrupt)
    const request = {
      sessionId,
      requestId: "request_corrupt_image",
      content: inputFixture([
        { type: "text", text: "Explain the image" },
        { type: "image", ...draft },
      ]),
    }
    const rejected = await app.handlers.admitInput(request)
    expect(rejected).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        message: expect.stringContaining(
          "Image was not sent: unable to decode image",
        ),
        details: { reason: "invalid_image" },
      },
    })
    expect(modelCalls).toBe(0)
    expect(await app.rolloutAssets.read(draft.file)).toEqual(corrupt)
    // The failed send did not consume the request ID or remove its draft.
    await writeFile(app.rolloutAssets.resolve(draft.file), png)
    const admitted = await app.handlers.admitInput(request)
    expect(admitted.ok).toBe(true)
    await vi.waitFor(() => expect(modelCalls).toBe(1))
  } finally {
    await app?.close()
    await rm(root, { recursive: true, force: true })
  }
})
