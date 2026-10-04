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
  it("enforces the configured capacity independently for each thread queue", () => {
    const queue = new InputQueue()
    for (let index = 0; index < MAX_QUEUED_ITEMS; index++) {
      queue.enqueue("session_one", {
        submissionId: `request_${index}`,
        content: { kind: "text", text: `prompt ${index}` },
      })
    }
    expect(() =>
      queue.enqueue("session_one", {
        submissionId: "request_overflow",
        content: { kind: "text", text: "overflow" },
      }),
    ).toThrow(InputQueueFullError)
    expect(queue.list("session_one")).toHaveLength(MAX_QUEUED_ITEMS)
    expect(() =>
      queue.enqueue("session_two", {
        submissionId: "request_other",
        content: { kind: "text", text: "another thread" },
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
      content: { kind: "text", text: "first" },
    })
    const second = queue.enqueue("session_one", {
      submissionId: "request_two",
      content: { kind: "text", text: "second" },
    })
    expect(queue.enqueue("session_one", first.input)).toEqual(first)
    expect(() =>
      queue.enqueue("session_one", {
        submissionId: "request_one",
        content: { kind: "text", text: "changed" },
      }),
    ).toThrow("conflicts")
    queue.reorder("session_one", [second.id, first.id])
    const updated = queue.update("session_one", first.id, {
      submissionId: "request_one_edit",
      content: { kind: "text", text: "edited" },
    })
    expect(updated?.id).toBe(first.id)
    expect(() => queue.reorder("session_one", [first.id])).toThrow(
      "every queued input",
    )
    queue.close()

    queue = new InputQueue(path)
    expect(
      queue.list("session_one").map((item) => item.input.content.text),
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
