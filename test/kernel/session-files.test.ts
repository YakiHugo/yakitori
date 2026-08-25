import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { EventType } from "../../src/kernel/events.ts"
import { createSessionId } from "../../src/kernel/ids.ts"
import { createJsonlEventStore } from "../../src/kernel/jsonl-event-store.ts"
import { createSessionFiles } from "../../src/kernel/session-files.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("Session files", () => {
  it("separates staging images from idempotent request snapshots", async () => {
    const root = await makeRoot()
    const sessionId = createSessionId()
    const files = createSessionFiles(root)
    const data = pngBytes()

    const draft = await files.importImageBytes(sessionId, "attachment_1", [
      { name: "screen.png", data },
    ])
    expect(draft[0]?.file.path).toBe("attachments/staging/attachment_1/1.png")
    const detailed = draft.map((attachment) => ({
      ...attachment,
      detail: "original" as const,
    }))
    const first = await files.promoteImageAttachments(
      sessionId,
      "attachment_1",
      detailed,
    )
    await files.discardDraftImageAttachments(detailed)
    const second = await files.promoteImageAttachments(
      sessionId,
      "attachment_1",
      detailed,
    )

    expect(first).toEqual(second)
    expect(first).toEqual([
      {
        name: "screen.png",
        mediaType: "image/png",
        detail: "original",
        sizeBytes: data.byteLength,
        file: {
          sessionId,
          path: "attachments/requests/attachment_1/1.png",
        },
      },
    ])
    const stored = first[0]
    if (stored === undefined || !("file" in stored)) {
      throw new Error("missing stored attachment")
    }
    expect(await files.read(stored.file)).toEqual(data)
    expect(
      await readFile(
        join(
          root,
          sessionId,
          "files",
          "attachments",
          "requests",
          "attachment_1",
          "1.png",
        ),
      ),
    ).toEqual(data)
    await expect(files.discardDraftImageAttachments(first)).rejects.toThrow(
      "not a draft",
    )
  })

  it("imports a native path as a snapshot and cleans abandoned staging", async () => {
    const root = await makeRoot()
    const sessionId = createSessionId()
    const sourcePath = join(root, "selected.png")
    await writeFile(sourcePath, pngBytes())
    const files = createSessionFiles(root)

    const [attachment] = await files.importImagePaths(
      sessionId,
      "draft_abandoned",
      [sourcePath],
    )
    if (attachment === undefined) throw new Error("missing imported attachment")
    await expect(files.read(attachment.file)).resolves.toEqual(pngBytes())

    await files.cleanupStagingImageAttachments()
    await expect(files.read(attachment.file)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("pages files and rejects references that escape the Session", async () => {
    const root = await makeRoot()
    const sessionId = createSessionId()
    const files = createSessionFiles(root)
    const prepared = await files.prepareCommandFiles(sessionId, "call_1")
    await writeFile(prepared.stdout.path, "0123456789")

    await expect(
      files.readRange(prepared.stdout.reference, 3, 4),
    ).resolves.toEqual({ bytes: Buffer.from("3456"), totalBytes: 10 })
    await expect(
      files.read({ sessionId, path: "../events.jsonl" }),
    ).rejects.toThrow("Invalid Session file path")
  })

  it("maps filesystem-unsafe owner IDs to stable portable directories", async () => {
    const root = await makeRoot()
    const sessionId = createSessionId()
    const files = createSessionFiles(root)
    const stored = await files.importImageBytes(sessionId, "request:1", [
      { name: "screen.png", data: pngBytes() },
    ])
    const attachment = stored[0]
    expect(attachment?.file.path).toMatch(
      /^attachments\/staging\/id-[a-f0-9]{64}\/1\.png$/,
    )
    expect(attachment?.file.path).not.toContain(":")

    const prepared = await files.prepareCommandFiles(sessionId, "call:1")
    expect(prepared.stdout.reference.path).toMatch(
      /^tools\/id-[a-f0-9]{64}\/stdout\.log$/,
    )
  })

  it("rolls back a staging batch when an image is invalid", async () => {
    const root = await makeRoot()
    const sessionId = createSessionId()
    const files = createSessionFiles(root)

    await expect(
      files.importImageBytes(sessionId, "atomic_batch", [
        { name: "valid.png", data: pngBytes() },
        {
          name: "truncated.png",
          data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        },
      ]),
    ).rejects.toThrow("truncated")
    await expect(
      readFile(
        join(
          root,
          sessionId,
          "files",
          "attachments",
          "staging",
          "atomic_batch",
          "1.png",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("is deleted with the owning Session directory", async () => {
    const root = await makeRoot()
    const store = createJsonlEventStore({ sessionsDir: root })
    const files = createSessionFiles(root)
    const sessionId = createSessionId()
    try {
      await store.createSession(sessionId, {
        type: EventType.SessionCreated,
        data: {},
      })
      const prepared = await files.prepareCommandFiles(sessionId, "call_1")
      await expect(files.read(prepared.stdout.reference)).resolves.toEqual(
        Buffer.alloc(0),
      )

      await store.deleteSession(sessionId)
      await expect(files.read(prepared.stdout.reference)).rejects.toMatchObject(
        {
          code: "ENOENT",
        },
      )
    } finally {
      await store.close()
    }
  })
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yakitori-session-files-"))
  roots.push(root)
  return root
}

function pngBytes(): Buffer {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(1, 16)
  bytes.writeUInt32BE(1, 20)
  return bytes
}
