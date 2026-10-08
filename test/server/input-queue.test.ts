import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createUserInput, inputContentText } from "../../src/core/user-input.ts"
import {
  InputQueue,
  InputQueueFullError,
  MAX_QUEUED_ITEMS,
} from "../../src/server/input-queue.ts"
import { inputFixture } from "../fixtures/user-input.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("separate input queue", () => {
  it("preserves text, editor elements and attachments through edits, reorder and reopen", async () => {
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
      content: inputFixture([
        { type: "text", text: "before" },
        image,
        { type: "text", text: "after" },
      ]),
    })
    const next = queue.enqueue("session_one", {
      submissionId: "request_next",
      content: createUserInput("next"),
    })
    queue.update("session_one", original.id, {
      ...original.input,
      content: inputFixture([image, { type: "text", text: "edited" }]),
    })
    queue.reorder("session_one", [next.id, original.id])
    queue.close()
    queue = new InputQueue(path)
    expect(queue.list("session_one").map((entry) => entry.id)).toEqual([
      next.id,
      original.id,
    ])
    expect(queue.get("session_one", original.id)?.input.content).toEqual(
      inputFixture([image, { type: "text", text: "edited" }]),
    )
    queue.close()
  })

  it("enforces the configured capacity independently for each thread queue", () => {
    const queue = new InputQueue()
    for (let index = 0; index < MAX_QUEUED_ITEMS; index++) {
      queue.enqueue("session_one", {
        submissionId: `request_${index}`,
        content: inputFixture([
          { type: "text" as const, text: `prompt ${index}` },
        ]),
      })
    }
    expect(() =>
      queue.enqueue("session_one", {
        submissionId: "request_overflow",
        content: inputFixture([{ type: "text" as const, text: "overflow" }]),
      }),
    ).toThrow(InputQueueFullError)
    expect(queue.list("session_one")).toHaveLength(MAX_QUEUED_ITEMS)
    expect(() =>
      queue.enqueue("session_two", {
        submissionId: "request_other",
        content: inputFixture([
          { type: "text" as const, text: "another thread" },
        ]),
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
      content: inputFixture([{ type: "text" as const, text: "first" }]),
    })
    const second = queue.enqueue("session_one", {
      submissionId: "request_two",
      content: inputFixture([{ type: "text" as const, text: "second" }]),
    })
    expect(queue.enqueue("session_one", first.input)).toEqual(first)
    expect(() =>
      queue.enqueue("session_one", {
        submissionId: "request_one",
        content: inputFixture([{ type: "text" as const, text: "changed" }]),
      }),
    ).toThrow("conflicts")
    queue.reorder("session_one", [second.id, first.id])
    const updated = queue.update("session_one", first.id, {
      submissionId: "request_one_edit",
      content: inputFixture([{ type: "text" as const, text: "edited" }]),
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
