import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createSessionId } from "../../src/kernel/ids.ts"
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

    expect(first.attachments).toEqual(second.attachments)
    expect(first.attachments).toEqual([
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
    const stored = first.attachments[0]
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
    await expect(
      files.discardDraftImageAttachments(first.attachments),
    ).rejects.toThrow("not a draft")
  })

  it("rejects a reused request owner when a new draft has different bytes", async () => {
    const root = await makeRoot()
    const sessionId = createSessionId()
    const files = createSessionFiles(root)
    const original = pngBytes()
    const replacement = Buffer.from(original)
    replacement[12] = 1

    const firstDraft = await files.importImageBytes(sessionId, "draft_first", [
      { name: "screen.png", data: original },
    ])
    await files.promoteImageAttachments(sessionId, "request_same", firstDraft)
    await files.discardDraftImageAttachments(firstDraft)
    const replacementDraft = await files.importImageBytes(
      sessionId,
      "draft_replacement",
      [{ name: "screen.png", data: replacement }],
    )

    await expect(
      files.promoteImageAttachments(
        sessionId,
        "request_same",
        replacementDraft,
      ),
    ).rejects.toThrow("different image")
  })

  it("gives a concurrent promotion exclusive rollback ownership", async () => {
    const root = await makeRoot()
    const sessionId = createSessionId()
    const files = createSessionFiles(root)
    const firstBytes = pngBytes()
    const secondBytes = Buffer.from(firstBytes)
    secondBytes[12] = 1
    const [firstDraft, secondDraft] = await Promise.all([
      files.importImageBytes(sessionId, "draft_concurrent_first", [
        { name: "screen.png", data: firstBytes },
      ]),
      files.importImageBytes(sessionId, "draft_concurrent_second", [
        { name: "screen.png", data: secondBytes },
      ]),
    ])

    const results = await Promise.allSettled([
      files.promoteImageAttachments(
        sessionId,
        "request_concurrent",
        firstDraft,
      ),
      files.promoteImageAttachments(
        sessionId,
        "request_concurrent",
        secondDraft,
      ),
    ])

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1)
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1)
    const winner = results.find((result) => result.status === "fulfilled")
    if (winner?.status !== "fulfilled") throw new Error("missing winner")
    const attachment = winner.value.attachments[0]
    if (attachment === undefined) throw new Error("missing promoted image")
    const stored = await files.read(attachment.file)
    expect(stored.equals(firstBytes) || stored.equals(secondBytes)).toBe(true)
  })

  it("rolls back files copied before a later attachment fails", async () => {
    const root = await makeRoot()
    const sourceSessionId = createSessionId()
    const targetSessionId = createSessionId()
    const files = createSessionFiles(root)
    const [source] = await files.importImageBytes(
      sourceSessionId,
      "draft_source",
      [{ name: "screen.png", data: pngBytes() }],
    )
    if (source === undefined) throw new Error("missing source attachment")
    const missing = {
      ...source,
      file: {
        sessionId: sourceSessionId,
        path: "attachments/requests/missing/2.png",
      },
    }

    await expect(
      files.copyImageAttachments(targetSessionId, "request_copy", [
        source,
        missing,
      ]),
    ).rejects.toMatchObject({ code: "ENOENT" })
    await expect(
      readFile(
        join(
          root,
          targetSessionId,
          "files",
          "attachments",
          "requests",
          "request_copy",
          "1.png",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" })
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
    const files = createSessionFiles(root)
    const sessionId = createSessionId()
    const prepared = await files.prepareCommandFiles(sessionId, "call_1")
    await expect(files.read(prepared.stdout.reference)).resolves.toEqual(
      Buffer.alloc(0),
    )

    await files.discardSessionFiles(sessionId)
    await expect(files.read(prepared.stdout.reference)).rejects.toMatchObject({
      code: "ENOENT",
    })
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
