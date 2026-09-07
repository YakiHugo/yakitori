import { describe, expect, it } from "vitest"
import type {
  RolloutItem,
  StoredRolloutItem,
  StoredThread,
} from "../../src/core/rollout.ts"
import {
  firstVisibleThreadMatch,
  visibleThreadSearchOccurrences,
} from "../../src/core/thread-search.ts"
import { MemoryThreadStore } from "./memory-thread-store.ts"

describe("thread search projection", () => {
  it("searches rendered user text and only terminal assistant answers", () => {
    const stored = thread([
      response("turn_user", "user", "Please [read](https://example.com) **docs**."),
      {
        type: "agent_message",
        messageId: "mailbox",
        item: envelope("turn_user", "user", "internal-only"),
      },
      response("turn_tool", "assistant", "draft-only"),
      response("turn_tool", "tool", "tool output"),
      completed("turn_tool"),
      response(
        "turn_final",
        "assistant",
        "Final [read](https://example.com) **docs**.",
      ),
      completed("turn_final"),
      response("turn_incomplete", "assistant", "unfinished-only"),
    ])

    expect(firstVisibleThreadMatch(stored, "internal-only")).toBeUndefined()
    expect(firstVisibleThreadMatch(stored, "draft-only")).toBeUndefined()
    expect(firstVisibleThreadMatch(stored, "unfinished-only")).toBeUndefined()
    const occurrences = visibleThreadSearchOccurrences(stored, "read docs")
    expect(occurrences).toHaveLength(2)
    for (const occurrence of occurrences) {
      expect(
        occurrence.snippet.slice(
          occurrence.snippetMatchRange.start,
          occurrence.snippetMatchRange.end,
        ),
      ).toBe("read docs")
      expect(occurrence.snippet).not.toContain("https://")
      expect(occurrence.snippet).not.toContain("**")
    }
  })

  it("continues after a deleted cursor anchor without duplicating the first page", async () => {
    const store = new MemoryThreadStore()
    for (const [id, updatedAt] of [
      ["session_new", "2026-01-03T00:00:00.000Z"],
      ["session_middle", "2026-01-02T00:00:00.000Z"],
      ["session_old", "2026-01-01T00:00:00.000Z"],
    ] as const) {
      await store.createThread({
        id,
        conversationId: id,
        title: "needle",
        createdAt: updatedAt,
        updatedAt,
      })
    }
    const first = await store.searchThreads({ searchTerm: "needle", limit: 1 })
    expect(first.matches.map(({ summary }) => summary.id)).toEqual([
      "session_new",
    ])
    if (first.nextCursor === undefined) throw new Error("missing cursor")
    await store.deleteThread("session_new")

    const second = await store.searchThreads({
      searchTerm: "needle",
      limit: 1,
      cursor: first.nextCursor,
    })

    expect(second.matches.map(({ summary }) => summary.id)).toEqual([
      "session_middle",
    ])
  })
})

function thread(items: readonly RolloutItem[]): StoredThread {
  const metadata = {
    id: "session_search",
    rolloutId: "session_search",
    conversationId: "session_search",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
  return {
    metadata,
    rollout: [
      record(0, { type: "session_meta", metadata }),
      ...items.map((item, index) => record(index + 1, item)),
    ],
  }
}

function response(
  turnId: string,
  role: "assistant" | "tool" | "user",
  text: string,
): RolloutItem {
  return { type: "response_item", item: envelope(turnId, role, text) }
}

function envelope(
  turnId: string,
  role: "assistant" | "tool" | "user",
  text: string,
) {
  return {
    id: `item_${turnId}_${role}`,
    turnId,
    createdAt: "2026-01-01T00:00:00.000Z",
    item:
      role === "tool"
        ? { role, toolCallId: `call_${turnId}`, content: text }
        : { role, content: [{ type: "text" as const, text }] },
  }
}

function completed(turnId: string): RolloutItem {
  return { type: "turn_completed", turnId, outcome: "completed" }
}

function record(seq: number, item: RolloutItem): StoredRolloutItem {
  return {
    threadId: "session_search",
    rolloutId: "session_search",
    seq,
    createdAt: "2026-01-01T00:00:00.000Z",
    item,
  }
}
