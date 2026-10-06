import { strict as assert } from "node:assert"
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createSessionId } from "../../src/kernel/ids.ts"
import { readPdf } from "../../src/runtime/tools/read-pdf.ts"
import { pdfFixture } from "../runtime/tools/pdf-fixture.ts"
import { createRolloutAssets } from "../../src/kernel/rollout-assets.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("rollout assets", () => {
  it("preserves mixed attachment order, original PDF bytes and lost-response retries", async () => {
    const root = await makeRoot()
    const rolloutId = "rollout_mixed"
    const files = await createTestRolloutAssets(root, rolloutId)
    const pdf = pdfFixture(["original PDF content"])
    const source = join(root, "document.pdf")
    await writeFile(source, pdf)
    const drafts = await files.importAttachmentBytes(rolloutId, "mixed", [
      { name: "first.png", data: pngBytes() },
      { name: "middle.pdf", data: pdf },
      { name: "last.png", data: pngBytes() },
    ])
    expect(drafts.map((draft) => draft.file.path)).toEqual([
      "attachments/staging/mixed/1.png",
      "attachments/staging/mixed/2.pdf",
      "attachments/staging/mixed/3.png",
    ])
    expect(drafts[1]).toEqual({
      name: "middle.pdf",
      mediaType: "application/pdf",
      sizeBytes: pdf.byteLength,
      file: { rolloutId, path: "attachments/staging/mixed/2.pdf" },
    })
    const first = await files.promoteAttachments(rolloutId, "request", drafts)
    await files.discardDraftAttachments(drafts)
    const retry = await files.promoteAttachments(rolloutId, "request", drafts)
    expect(retry.attachments).toEqual(first.attachments)
    await retry.rollback()
    const firstPdf = first.attachments[1]
    assert(firstPdf !== undefined)
    expect(await files.read(firstPdf.file)).toEqual(pdf)
    const [snapshot] = await files.importAttachmentPaths(
      rolloutId,
      "snapshot",
      [source],
    )
    await writeFile(source, "source replaced after import")
    assert(snapshot !== undefined)
    expect(await files.read(snapshot.file)).toEqual(pdf)
  })

  it("validates real PDF parsing and fails closed when no validator is composed", async () => {
    const root = await makeRoot()
    const rolloutId = "rollout_validation"
    const files = await createTestRolloutAssets(root, rolloutId)
    for (const [index, bytes] of [
      Buffer.from("%PDF-1.4\ninvalid"),
      pdfFixture([]),
    ].entries()) {
      await expect(
        files.importAttachmentBytes(rolloutId, `invalid_${index}`, [
          { name: "invalid.pdf", data: bytes },
        ]),
      ).rejects.toThrow()
    }
    const encrypted = pdfFixture(["private"])
      .toString("utf8")
      .replace(
        "/Root 1 0 R",
        `/Root 1 0 R /Encrypt << /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> >> /ID [<${"00".repeat(16)}> <${"00".repeat(16)}>]`,
      )
    await expect(
      files.importAttachmentBytes(rolloutId, "encrypted", [
        { name: "encrypted.pdf", data: Buffer.from(encrypted) },
      ]),
    ).rejects.toThrow(/password/i)
    const unconfigured = createRolloutAssets(root, {
      withMutationLease: async (_id, mutate) => mutate(),
    })
    await expect(
      unconfigured.importAttachmentBytes(rolloutId, "unconfigured", [
        { name: "valid.pdf", data: pdfFixture(["valid"]) },
      ]),
    ).rejects.toThrow("validation is unavailable")
    const [largeDocument] = await files.importAttachmentBytes(
      rolloutId,
      "many_pages",
      [
        {
          name: "many-pages.pdf",
          data: pdfFixture(Array.from({ length: 1001 }, () => "page")),
        },
      ],
    )
    expect(largeDocument?.mediaType).toBe("application/pdf")
  })

  it("rejects oversized native files before creating a snapshot", async () => {
    const root = await makeRoot()
    const rolloutId = "rollout_bounded"
    const files = await createTestRolloutAssets(root, rolloutId)
    const source = join(root, "oversized.pdf")
    const handle = await open(source, "w")
    await handle.truncate(50_000_001)
    await handle.close()
    await expect(
      files.importAttachmentPaths(rolloutId, "bounded", [source]),
    ).rejects.toThrow("local safety boundary")
    await expect(
      stat(join(root, "rollouts", rolloutId, "files")),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("retains existing staging assets when a repeated mixed import later fails", async () => {
    const root = await makeRoot()
    const rolloutId = "rollout_retry"
    const files = await createTestRolloutAssets(root, rolloutId)
    const pdf = pdfFixture(["unchanged"])
    const [existing] = await files.importAttachmentBytes(rolloutId, "retry", [
      { name: "existing.pdf", data: pdf },
    ])
    await expect(
      files.importAttachmentBytes(rolloutId, "retry", [
        { name: "existing.pdf", data: pdf },
        { name: "new.png", data: pngBytes() },
        { name: "invalid.pdf", data: Buffer.from("%PDF-invalid") },
      ]),
    ).rejects.toThrow()
    assert(existing !== undefined)
    expect(await files.read(existing.file)).toEqual(pdf)
    expect(
      await readdir(
        join(
          root,
          "rollouts",
          rolloutId,
          "files",
          "attachments",
          "staging",
          "retry",
        ),
      ),
    ).toEqual(["1.pdf"])
  })

  it("rejects changed PDF bytes and metadata without removing durable request files", async () => {
    const root = await makeRoot()
    const rolloutId = "rollout_pdf_conflict"
    const files = await createTestRolloutAssets(root, rolloutId)
    const original = pdfFixture(["first"])
    const changed = pdfFixture(["other"])
    expect(changed.byteLength).toBe(original.byteLength)
    const drafts = await files.importAttachmentBytes(rolloutId, "first", [
      { name: "document.pdf", data: original },
    ])
    const stored = await files.promoteAttachments(rolloutId, "same", drafts)
    const replacements = await files.importAttachmentBytes(rolloutId, "other", [
      { name: "document.pdf", data: changed },
    ])
    await expect(
      files.promoteAttachments(rolloutId, "same", replacements),
    ).rejects.toThrow("different attachment")
    const draft = drafts[0]
    const durable = stored.attachments[0]
    assert(draft !== undefined && durable !== undefined)
    await expect(
      files.promoteAttachments(rolloutId, "bad_metadata", [
        { ...draft, sizeBytes: original.byteLength + 1 },
      ]),
    ).rejects.toThrow("metadata does not match")
    expect(await files.read(durable.file)).toEqual(original)
    const target = "rollout_independent"
    await createTestRolloutAssets(root, target)
    const copied = await files.copyAttachments(
      target,
      "copy",
      stored.attachments,
    )
    await rm(join(root, "rollouts", rolloutId), { recursive: true })
    const copy = copied.attachments[0]
    assert(copy !== undefined)
    expect(await files.read(copy.file)).toEqual(original)
  })

  it("rejects reordered media slots on a retry after draft cleanup", async () => {
    const root = await makeRoot()
    const rolloutId = "rollout_slot_conflict"
    const target = "rollout_copy_conflict"
    const files = await createTestRolloutAssets(root, rolloutId, target)
    const drafts = await files.importAttachmentBytes(rolloutId, "mixed", [
      { name: "first.pdf", data: pdfFixture(["first"]) },
      { name: "second.png", data: pngBytes() },
    ])
    const durable = await files.promoteAttachments(rolloutId, "request", drafts)
    const copied = await files.copyAttachments(target, "request", drafts)
    await files.discardDraftAttachments(drafts)
    const changedSize = drafts.map((attachment) => ({
      ...attachment,
      sizeBytes: attachment.sizeBytes + 1,
    }))
    await expect(
      files.promoteAttachments(rolloutId, "request", changedSize),
    ).rejects.toThrow("different attachment")
    await expect(
      files.copyAttachments(target, "request", changedSize),
    ).rejects.toThrow("different attachment")
    await expect(
      files.promoteAttachments(rolloutId, "request", [...drafts].reverse()),
    ).rejects.toThrow("different attachment")
    await expect(
      files.copyAttachments(target, "request", [...drafts].reverse()),
    ).rejects.toThrow("different attachment")
    for (const attachment of [...durable.attachments, ...copied.attachments])
      expect((await files.read(attachment.file)).byteLength).toBe(
        attachment.sizeBytes,
      )
  })

  it("separates staging images from idempotent request snapshots", async () => {
    const root = await makeRoot()
    const sessionId = createSessionId()
    const files = await createTestRolloutAssets(root, sessionId)
    const data = pngBytes()

    const draft = await files.importAttachmentBytes(sessionId, "attachment_1", [
      { name: "screen.png", data },
    ])
    expect(draft[0]?.file.path).toBe("attachments/staging/attachment_1/1.png")
    const detailed = draft.map((attachment) => ({
      ...attachment,
      detail: "original" as const,
    }))
    const first = await files.promoteAttachments(
      sessionId,
      "attachment_1",
      detailed,
    )
    await files.discardDraftAttachments(detailed)
    const second = await files.promoteAttachments(
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
          "rollouts",
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
      files.discardDraftAttachments(first.attachments),
    ).rejects.toThrow("not a draft")
  })

  it("rejects a reused request owner when a new draft has different bytes", async () => {
    const root = await makeRoot()
    const sessionId = createSessionId()
    const files = await createTestRolloutAssets(root, sessionId)
    const original = pngBytes()
    const replacement = Buffer.from(original)
    replacement[12] = 1

    const firstDraft = await files.importAttachmentBytes(
      sessionId,
      "draft_first",
      [{ name: "screen.png", data: original }],
    )
    await files.promoteAttachments(sessionId, "request_same", firstDraft)
    await files.discardDraftAttachments(firstDraft)
    const replacementDraft = await files.importAttachmentBytes(
      sessionId,
      "draft_replacement",
      [{ name: "screen.png", data: replacement }],
    )

    await expect(
      files.promoteAttachments(sessionId, "request_same", replacementDraft),
    ).rejects.toThrow("different attachment")
  })

  it("gives a concurrent promotion exclusive rollback ownership", async () => {
    const root = await makeRoot()
    const sessionId = createSessionId()
    const files = await createTestRolloutAssets(root, sessionId)
    const firstBytes = pngBytes()
    const secondBytes = Buffer.from(firstBytes)
    secondBytes[12] = 1
    const [firstDraft, secondDraft] = await Promise.all([
      files.importAttachmentBytes(sessionId, "draft_concurrent_first", [
        { name: "screen.png", data: firstBytes },
      ]),
      files.importAttachmentBytes(sessionId, "draft_concurrent_second", [
        { name: "screen.png", data: secondBytes },
      ]),
    ])

    const results = await Promise.allSettled([
      files.promoteAttachments(sessionId, "request_concurrent", firstDraft),
      files.promoteAttachments(sessionId, "request_concurrent", secondDraft),
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
    const files = await createTestRolloutAssets(
      root,
      sourceSessionId,
      targetSessionId,
    )
    const [source] = await files.importAttachmentBytes(
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
      files.copyAttachments(targetSessionId, "request_copy", [source, missing]),
    ).rejects.toMatchObject({ code: "ENOENT" })
    await expect(
      readFile(
        join(
          root,
          "rollouts",
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

  it("keeps existing request images when a retried copy is rolled back", async () => {
    const root = await makeRoot()
    const sourceSessionId = createSessionId()
    const targetSessionId = createSessionId()
    const files = await createTestRolloutAssets(
      root,
      sourceSessionId,
      targetSessionId,
    )
    const [source] = await files.importAttachmentBytes(
      sourceSessionId,
      "draft",
      [{ name: "screen.png", data: pngBytes() }],
    )
    if (source === undefined) throw new Error("missing source attachment")

    const first = await files.copyAttachments(targetSessionId, "retry", [
      source,
    ])
    const retry = await files.copyAttachments(targetSessionId, "retry", [
      source,
    ])
    await retry.rollback()
    if (first.attachments[0] === undefined)
      throw new Error("missing copied attachment")
    await expect(files.read(first.attachments[0].file)).resolves.toEqual(
      pngBytes(),
    )
  })

  it("rejects a reused copy owner when the source image has different bytes", async () => {
    const root = await makeRoot()
    const sourceRolloutId = createSessionId()
    const targetRolloutId = createSessionId()
    const files = await createTestRolloutAssets(
      root,
      sourceRolloutId,
      targetRolloutId,
    )
    const original = pngBytes()
    const replacement = Buffer.from(original)
    replacement[12] = 1
    const firstSource = await files.importAttachmentBytes(
      sourceRolloutId,
      "first_source",
      [{ name: "screen.png", data: original }],
    )
    const replacementSource = await files.importAttachmentBytes(
      sourceRolloutId,
      "replacement_source",
      [{ name: "screen.png", data: replacement }],
    )
    const first = await files.copyAttachments(
      targetRolloutId,
      "request_same",
      firstSource,
    )

    await expect(
      files.copyAttachments(targetRolloutId, "request_same", replacementSource),
    ).rejects.toThrow("A different attachment already exists for this request.")
    const copied = first.attachments[0]
    if (copied === undefined) throw new Error("missing original copy")
    await expect(files.read(copied.file)).resolves.toEqual(original)
  })

  it("imports a native path as a snapshot and discards it on request", async () => {
    const root = await makeRoot()
    const sessionId = createSessionId()
    const sourcePath = join(root, "selected.png")
    await writeFile(sourcePath, pngBytes())
    const files = await createTestRolloutAssets(root, sessionId)

    const [attachment] = await files.importAttachmentPaths(
      sessionId,
      "draft_abandoned",
      [sourcePath],
    )
    if (attachment === undefined) throw new Error("missing imported attachment")
    await expect(files.read(attachment.file)).resolves.toEqual(pngBytes())

    await files.discardDraftAttachments([attachment])
    await expect(files.read(attachment.file)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("rejects references that escape the rollout", async () => {
    const root = await makeRoot()
    const sessionId = createSessionId()
    const files = await createTestRolloutAssets(root, sessionId)
    const prepared = await files.saveToolFile(
      sessionId,
      "call_1",
      "stdout.log",
      new Uint8Array(),
    )
    await writeFile(prepared.path, "0123456789")

    await expect(files.read(prepared.reference)).resolves.toEqual(
      Buffer.from("0123456789"),
    )
    await expect(
      files.read({ rolloutId: sessionId, path: "../events.jsonl" }),
    ).rejects.toThrow("Invalid rollout asset path")
  })

  it("maps filesystem-unsafe owner IDs to stable portable directories", async () => {
    const root = await makeRoot()
    const sessionId = createSessionId()
    const files = await createTestRolloutAssets(root, sessionId)
    const stored = await files.importAttachmentBytes(sessionId, "request:1", [
      { name: "screen.png", data: pngBytes() },
    ])
    const attachment = stored[0]
    expect(attachment?.file.path).toMatch(
      /^attachments\/staging\/id-[a-f0-9]{64}\/1\.png$/,
    )
    expect(attachment?.file.path).not.toContain(":")

    const prepared = await files.saveToolFile(
      sessionId,
      "call:1",
      "stdout.log",
      new Uint8Array(),
    )
    expect(prepared.reference.path).toMatch(
      /^tools\/id-[a-f0-9]{64}\/stdout\.log$/,
    )
  })

  it("rolls back a staging batch when an image is invalid", async () => {
    const root = await makeRoot()
    const sessionId = createSessionId()
    const files = await createTestRolloutAssets(root, sessionId)

    await expect(
      files.importAttachmentBytes(sessionId, "atomic_batch", [
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
          "rollouts",
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

  it("stores files inside the owning physical rollout bundle", async () => {
    const root = await makeRoot()
    const rolloutId = "rollout_source"
    const files = await createTestRolloutAssets(root, rolloutId)
    const prepared = await files.saveToolFile(
      rolloutId,
      "call_1",
      "stdout.log",
      new Uint8Array(),
    )
    await writeFile(prepared.path, "output")

    expect(prepared.path).toBe(
      join(
        root,
        "rollouts",
        rolloutId,
        "files",
        "tools",
        "call_1",
        "stdout.log",
      ),
    )
    await expect(files.read(prepared.reference)).resolves.toEqual(
      Buffer.from("output"),
    )
  })

  it("cannot create files without an existing physical rollout", async () => {
    const root = await makeRoot()
    const rolloutId = "rollout_missing"
    const files = createTestAssetStore(root)

    await expect(
      files.saveToolFile(rolloutId, "call_1", "stdout.log", new Uint8Array()),
    ).rejects.toThrow("has no journal")
    await expect(stat(join(root, "rollouts", rolloutId))).rejects.toMatchObject(
      { code: "ENOENT" },
    )
  })
})

async function createTestRolloutAssets(root: string, ...rolloutIds: string[]) {
  for (const rolloutId of rolloutIds) {
    const directory = join(root, "rollouts", rolloutId)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "rollout.jsonl"), "fixture\n")
  }
  return createTestAssetStore(root)
}

function createTestAssetStore(root: string) {
  return createRolloutAssets(root, {
    async validatePdf(bytes) {
      const parsed = await readPdf({ bytes, format: "native" })
      if (!parsed.ok) throw new Error(parsed.message)
      if (parsed.totalPages <= 0) throw new Error("PDF has no pages.")
    },
    async withMutationLease(rolloutId, mutate) {
      const journal = await stat(
        join(root, "rollouts", rolloutId, "rollout.jsonl"),
      ).catch(() => {
        throw new Error(`Physical rollout ${rolloutId} has no journal.`)
      })
      if (!journal.isFile()) {
        throw new Error(`Physical rollout ${rolloutId} has no journal.`)
      }
      return mutate()
    },
  })
}

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
