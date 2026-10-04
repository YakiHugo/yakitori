import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import type { RolloutItem } from "../../src/core/rollout.ts"
import {
  type CreateThreadMetadata,
  PersistContext,
} from "../../src/core/thread-store.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("persisted thread search", () => {
  it("searches rendered user text and terminal answers while excluding internal and unfinished messages", async () => {
    const { root, store } = await setup()
    await save(store, "session_search", [
      response(
        "turn_user",
        "user",
        "Please [read](https://example.com) **docs**.",
      ),
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

    const reopened = new JsonlThreadStore({ root })
    for (const searchTerm of [
      "internal-only",
      "draft-only",
      "unfinished-only",
    ]) {
      await expect(
        reopened.searchThreads({ searchTerm, limit: 10 }),
      ).resolves.toEqual({ matches: [] })
    }
    const result = await reopened.searchThreadOccurrences({
      threadId: "session_search",
      searchTerm: "read docs",
      limit: 10,
    })
    expect(result?.occurrences).toEqual([
      {
        turnId: "turn_user",
        itemId: "item_turn_user_user",
        snippet: "Please read docs.",
        snippetMatchRange: { start: 7, end: 16 },
      },
      {
        turnId: "turn_final",
        itemId: "item_turn_final_assistant",
        snippet: "Final read docs.",
        snippetMatchRange: { start: 6, end: 15 },
      },
    ])
  })

  it("returns rendered line breaks and Unicode offsets after reopening", async () => {
    const { root, store } = await setup()
    await save(store, "session_rendered", [
      response("turn_rendered", "assistant", "😀 **Final**  \nneedle"),
      completed("turn_rendered"),
    ])
    const reopened = new JsonlThreadStore({ root })
    await expect(
      reopened.searchThreadOccurrences({
        threadId: "session_rendered",
        searchTerm: "Final needle",
        limit: 10,
      }),
    ).resolves.toEqual({
      occurrences: [
        {
          turnId: "turn_rendered",
          itemId: "item_turn_rendered_assistant",
          snippet: "😀 Final needle",
          snippetMatchRange: { start: 3, end: 15 },
        },
      ],
    })
  })

  it("indexes numeric character references as rendered text across append and reopen", async () => {
    const { root, store } = await setup()
    const threadId = "session_entities"
    await save(store, threadId, [])
    await store.resumeThread(threadId)
    await store.appendItems(threadId, [
      response(
        "turn_entities",
        "user",
        "&#0; &#xD800; &#1114112; &#128; &#xFFFF; &#128512; &#x1F600;&#10;&#999999999999;",
      ),
    ])
    const visible = "� � � � � 😀 😀 &#999999999999;"
    await expect(
      store.searchThreads({ searchTerm: visible, limit: 10 }),
    ).resolves.toMatchObject({
      matches: [{ summary: { id: threadId }, snippet: visible }],
    })
    await store.shutdownThread(threadId)
    const reopened = new JsonlThreadStore({ root })
    await expect(
      reopened.searchThreads({ searchTerm: visible, limit: 10 }),
    ).resolves.toMatchObject({
      matches: [{ summary: { id: threadId }, snippet: visible }],
    })
    await expect(
      reopened.searchThreadOccurrences({
        threadId,
        searchTerm: "😀 😀",
        limit: 10,
      }),
    ).resolves.toEqual({
      occurrences: [
        {
          turnId: "turn_entities",
          itemId: "item_turn_entities_user",
          snippet: visible,
          snippetMatchRange: { start: 10, end: 15 },
        },
      ],
    })
  })

  it("uses explicitly selected answers and excludes an explicitly empty answer", async () => {
    const { root, store } = await setup()
    await save(store, "session_answers", [
      {
        type: "response_item",
        item: {
          ...envelope("turn_selected", "assistant", "**Selected** answer"),
          id: "selected_answer",
        },
      },
      response("turn_selected", "assistant", "excluded progress"),
      {
        type: "turn_completed",
        turnId: "turn_selected",
        outcome: "completed",
        completion: { answerItemIds: ["selected_answer"] },
      },
      response("turn_empty", "assistant", "stale answer"),
      {
        type: "turn_completed",
        turnId: "turn_empty",
        outcome: "completed",
        completion: { answerItemIds: [] },
      },
    ])
    const reopened = new JsonlThreadStore({ root })
    await expect(
      reopened.searchThreadOccurrences({
        threadId: "session_answers",
        searchTerm: "Selected answer",
        limit: 10,
      }),
    ).resolves.toEqual({
      occurrences: [
        {
          turnId: "turn_selected",
          itemId: "selected_answer",
          snippet: "Selected answer",
          snippetMatchRange: { start: 0, end: 15 },
        },
      ],
    })
    for (const searchTerm of ["excluded progress", "stale answer"]) {
      await expect(
        reopened.searchThreads({ searchTerm, limit: 10 }),
      ).resolves.toEqual({ matches: [] })
    }
  })

  it("continues after a deleted cursor anchor when reopened", async () => {
    const { root, store } = await setup()
    for (const id of ["session_a_old", "session_m_middle", "session_z_new"]) {
      await save(store, id, [], { title: "needle" })
    }
    const first = await store.searchThreads({ searchTerm: "needle", limit: 1 })
    expect(first.matches.map(({ summary }) => summary.id)).toEqual([
      "session_z_new",
    ])
    if (first.nextCursor === undefined) throw new Error("missing cursor")
    await store.deleteThread("session_z_new")
    const reopened = new JsonlThreadStore({ root })
    const second = await reopened.searchThreads({
      searchTerm: "needle",
      limit: 1,
      cursor: first.nextCursor,
    })
    expect(second.matches.map(({ summary }) => summary.id)).toEqual([
      "session_m_middle",
    ])
  })
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "yakitori-search-"))
  roots.push(root)
  const store = new JsonlThreadStore({ root })
  await store.initialize()
  return { root, store }
}

async function save(
  store: JsonlThreadStore,
  id: string,
  items: readonly RolloutItem[],
  extra: Partial<CreateThreadMetadata> = {},
) {
  await store.createThread({
    id,
    conversationId: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  })
  await store.persistThread(id, PersistContext.TurnStart)
  if (items.length > 0) await store.appendItems(id, items)
  await store.shutdownThread(id)
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
