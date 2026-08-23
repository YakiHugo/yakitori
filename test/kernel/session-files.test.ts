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
  it("persists image bytes once and returns a Session-relative reference", async () => {
    const root = await makeRoot()
    const sessionId = createSessionId()
    const files = createSessionFiles(root)
    const data = Buffer.from("image-bytes")
    const attachment = {
      name: "screen.png",
      mediaType: "image/png" as const,
      detail: "original" as const,
      sizeBytes: data.byteLength,
      data: data.toString("base64"),
    }

    const first = await files.persistImageAttachments(sessionId, "request_1", [
      attachment,
    ])
    const second = await files.persistImageAttachments(sessionId, "request_1", [
      attachment,
    ])

    expect(first).toEqual(second)
    expect(first).toEqual([
      {
        name: "screen.png",
        mediaType: "image/png",
        detail: "original",
        sizeBytes: data.byteLength,
        file: {
          sessionId,
          path: "attachments/request_1/1.png",
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
        join(root, sessionId, "files", "attachments", "request_1", "1.png"),
      ),
    ).toEqual(data)
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
    const stored = await files.persistImageAttachments(sessionId, "request:1", [
      {
        name: "screen.png",
        mediaType: "image/png",
        sizeBytes: 1,
        data: "eA==",
      },
    ])
    const attachment = stored[0]
    expect(attachment?.file.path).toMatch(
      /^attachments\/id-[a-f0-9]{64}\/1\.png$/,
    )
    expect(attachment?.file.path).not.toContain(":")

    const prepared = await files.prepareCommandFiles(sessionId, "call:1")
    expect(prepared.stdout.reference.path).toMatch(
      /^tools\/id-[a-f0-9]{64}\/stdout\.log$/,
    )
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
