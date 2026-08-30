import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createSessionId } from "../../src/kernel/ids.ts"
import { createRolloutAssets } from "../../src/kernel/rollout-assets.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("rollout assets", () => {
  it("separates staging images from idempotent request snapshots", async () => {
    const root = await makeRoot()
    const sessionId = createSessionId()
    const files = createRolloutAssets(root)
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
          rolloutId: sessionId,
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
          "assets",
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
    const files = createRolloutAssets(root)
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
    const files = createRolloutAssets(root)
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
    const files = createRolloutAssets(root)
    const [source] = await files.importImageBytes(
      sourceSessionId,
      "draft_source",
      [{ name: "screen.png", data: pngBytes() }],
    )
    if (source === undefined) throw new Error("missing source attachment")
    const missing = {
      ...source,
      file: {
        rolloutId: sourceSessionId,
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
          "assets",
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
    const files = createRolloutAssets(root)

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

  it("pages assets and rejects references that escape the rollout", async () => {
    const root = await makeRoot()
    const sessionId = createSessionId()
    const files = createRolloutAssets(root)
    const prepared = await files.prepareCommandFiles(sessionId, "call_1")
    await writeFile(prepared.stdout.path, "0123456789")

    await expect(
      files.readRange(prepared.stdout.reference, 3, 4),
    ).resolves.toEqual({ bytes: Buffer.from("3456"), totalBytes: 10 })
    await expect(
      files.read({ rolloutId: sessionId, path: "../events.jsonl" }),
    ).rejects.toThrow("Invalid rollout asset path")
  })

  it("maps filesystem-unsafe owner IDs to stable portable directories", async () => {
    const root = await makeRoot()
    const sessionId = createSessionId()
    const files = createRolloutAssets(root)
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
    const files = createRolloutAssets(root)

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
          "assets",
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

  it("is deleted with the owning rollout asset directory", async () => {
    const root = await makeRoot()
    const files = createRolloutAssets(root)
    const sessionId = createSessionId()
    const prepared = await files.prepareCommandFiles(sessionId, "call_1")
    await expect(files.read(prepared.stdout.reference)).resolves.toEqual(
      Buffer.alloc(0),
    )

    await files.discardRolloutAssets(sessionId)
    await expect(files.read(prepared.stdout.reference)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("accepts storage-safe rollout IDs without exposing store directories to GC", async () => {
    const root = await makeRoot()
    const files = createRolloutAssets(root)
    const rolloutId = "rollout_source"
    const prepared = await files.prepareCommandFiles(rolloutId, "call_1")
    await writeFile(prepared.stdout.path, "output")
    await mkdir(join(root, "threads"))

    await expect(files.read(prepared.stdout.reference)).resolves.toEqual(
      Buffer.from("output"),
    )
    await files.collectUnreferencedRolloutAssets(new Set())

    await expect(stat(join(root, "assets", rolloutId))).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(stat(join(root, "threads"))).resolves.toMatchObject({})
  })
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yakitori-rollout-assets-"))
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
