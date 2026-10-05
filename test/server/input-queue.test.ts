import { DatabaseSync } from "node:sqlite"
import { inputContentText } from "../../src/kernel/input-content.ts"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  InputQueue,
  InputQueueFullError,
  MAX_QUEUED_ITEMS,
} from "../../src/server/input-queue.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("separate input queue", () => {
  it("reads shipped legacy queue rows without rewriting them and retains ordered retry identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-legacy-queue-"))
    roots.push(root)
    const path = join(root, "queue.sqlite")
    let queue = new InputQueue(path)
    const inserted = queue.enqueue("session_one", {
      submissionId: "request_saved",
      content: { kind: "parts", parts: [] },
    })
    queue.close()
    const attachment = {
      name: "saved.png",
      mediaType: "image/png",
      sizeBytes: 42,
      file: {
        rolloutId: "session_one",
        path: "attachments/requests/request_saved/1.png",
      },
    }
    const legacyJson = JSON.stringify({
      submissionId: "request_saved",
      content: { kind: "text", text: "saved", attachments: [attachment] },
    })
    const database = new DatabaseSync(path)
    database
      .prepare("UPDATE input_queue SET input_json = ? WHERE id = ?")
      .run(legacyJson, inserted.id)
    database.close()
    queue = new InputQueue(path)
    const restored = queue.getByRequest("session_one", "request_saved")
    expect(restored).toEqual({
      ...inserted,
      input: {
        submissionId: "request_saved",
        content: {
          kind: "parts",
          parts: [
            { type: "text", text: "saved" },
            { type: "image", ...attachment },
          ],
        },
      },
    })
    if (!restored) throw new Error("Missing saved queue item")
    expect(queue.enqueue("session_one", restored.input)).toEqual(restored)
    expect(() =>
      queue.enqueue("session_one", {
        ...restored.input,
        content: {
          kind: "parts",
          parts: [...restored.input.content.parts].reverse(),
        },
      }),
    ).toThrow("conflicts")
    queue.close()
    const readOnly = new DatabaseSync(path, { readOnly: true })
    expect(
      readOnly
        .prepare("SELECT input_json FROM input_queue WHERE id = ?")
        .get(inserted.id)?.input_json,
    ).toBe(legacyJson)
    readOnly.close()
  })

  it("preserves mixed part order through edits, reorder and reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-parts-queue-"))
    roots.push(root)
    const path = join(root, "queue.sqlite")
    let queue = new InputQueue(path)
    const image = {
      type: "image" as const,
      name: "queued.png",
      mediaType: "image/png" as const,
      sizeBytes: 42,
      file: { rolloutId: "session_one", path: "image.png" },
    }
    const original = queue.enqueue("session_one", {
      submissionId: "request_mixed",
      content: {
        kind: "parts",
        parts: [
          { type: "text", text: "before" },
          image,
          { type: "text", text: "after" },
        ],
      },
    })
    const next = queue.enqueue("session_one", {
      submissionId: "request_next",
      content: { kind: "parts", parts: [{ type: "text", text: "next" }] },
    })
    queue.update("session_one", original.id, {
      ...original.input,
      content: {
        kind: "parts",
        parts: [image, { type: "text", text: "edited" }],
      },
    })
    queue.reorder("session_one", [next.id, original.id])
    queue.close()
    queue = new InputQueue(path)
    expect(queue.list("session_one").map((entry) => entry.id)).toEqual([
      next.id,
      original.id,
    ])
    expect(queue.get("session_one", original.id)?.input.content).toEqual({
      kind: "parts",
      parts: [image, { type: "text", text: "edited" }],
    })
    queue.close()
  })

  it("enforces the configured capacity independently for each thread queue", () => {
    const queue = new InputQueue()
    for (let index = 0; index < MAX_QUEUED_ITEMS; index++) {
      queue.enqueue("session_one", {
        submissionId: `request_${index}`,
        content: {
          kind: "parts" as const,
          parts: [{ type: "text" as const, text: `prompt ${index}` }],
        },
      })
    }
    expect(() =>
      queue.enqueue("session_one", {
        submissionId: "request_overflow",
        content: {
          kind: "parts" as const,
          parts: [{ type: "text" as const, text: "overflow" }],
        },
      }),
    ).toThrow(InputQueueFullError)
    expect(queue.list("session_one")).toHaveLength(MAX_QUEUED_ITEMS)
    expect(() =>
      queue.enqueue("session_two", {
        submissionId: "request_other",
        content: {
          kind: "parts" as const,
          parts: [{ type: "text" as const, text: "another thread" }],
        },
      }),
    ).not.toThrow()
    queue.close()
  })

  it("keeps editable ordered inputs across queue-store reopen without adding rollout history", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-input-queue-"))
    roots.push(root)
    const path = join(root, "queue.sqlite")
    let queue = new InputQueue(path)
    const first = queue.enqueue("session_one", {
      submissionId: "request_one",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "first" }],
      },
    })
    const second = queue.enqueue("session_one", {
      submissionId: "request_two",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "second" }],
      },
    })
    expect(queue.enqueue("session_one", first.input)).toEqual(first)
    expect(() =>
      queue.enqueue("session_one", {
        submissionId: "request_one",
        content: {
          kind: "parts" as const,
          parts: [{ type: "text" as const, text: "changed" }],
        },
      }),
    ).toThrow("conflicts")
    queue.reorder("session_one", [second.id, first.id])
    const updated = queue.update("session_one", first.id, {
      submissionId: "request_one_edit",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "edited" }],
      },
    })
    expect(updated?.id).toBe(first.id)
    expect(() => queue.reorder("session_one", [first.id])).toThrow(
      "every queued input",
    )
    queue.close()

    queue = new InputQueue(path)
    expect(
      queue
        .list("session_one")
        .map((item) => inputContentText(item.input.content)),
    ).toEqual(["second", "edited"])
    expect(queue.getByRequest("session_one", "request_one_edit")?.id).toBe(
      first.id,
    )
    expect(queue.delete("session_one", second.id)).toBe(true)
    expect(queue.delete("session_one", second.id)).toBe(false)
    expect(queue.list("session_one").map((item) => item.id)).toEqual([first.id])
    queue.close()
  })
})
