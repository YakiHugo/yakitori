import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
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
  it("searches user source and rendered terminal answers while excluding internal and unfinished messages", async () => {
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
        turnId: "turn_final",
        itemId: "item_turn_final_assistant",
        snippet: "Final read docs.",
        snippetMatchRange: { start: 6, end: 15 },
      },
    ])
    await expect(
      reopened.searchThreadOccurrences({
        threadId: "session_search",
        searchTerm: "https://example.com",
        limit: 10,
      }),
    ).resolves.toEqual({
      occurrences: [
        {
          turnId: "turn_user",
          itemId: "item_turn_user_user",
          snippet: "Please [read](https://example.com) **docs**.",
          snippetMatchRange: { start: 14, end: 33 },
        },
      ],
    })
  })

  it.each([
    ["**literal** _syntax_ | <tag>", "**literal**", 0, 11],
    ["use \\_literal\\_ and \\*stars\\*", "\\_literal\\_", 4, 15],
    [
      "[label](https://example.com/path?q=a_b#anchor)",
      "https://example.com/path?q=a_b#anchor",
      8,
      45,
    ],
    ["```ts\nconst foo_bar = `**literal**`;\n```", "```ts", 0, 5],
    ["&copy; &#x1F600; &amp;", "&#x1F600;", 7, 16],
    ["😀 first  line\n\tsecond line", "first  line\n\tsecond", 3, 22],
  ])("preserves literal user text through append and reopen: %s", async (source, searchTerm, start, end) => {
    const { root, store } = await setup()
    const threadId = "session_user_source"
    await save(store, threadId, [])
    await store.resumeThread(threadId)
    await store.appendItems(threadId, [response("turn_source", "user", source)])
    await expect(
      store.searchThreads({ searchTerm, limit: 10 }),
    ).resolves.toMatchObject({
      matches: [{ summary: { id: threadId }, snippet: source }],
    })
    await store.shutdownThread(threadId)
    const reopened = new JsonlThreadStore({ root })
    await expect(
      reopened.searchThreadOccurrences({ threadId, searchTerm, limit: 10 }),
    ).resolves.toEqual({
      occurrences: [
        {
          turnId: "turn_source",
          itemId: "item_turn_source_user",
          snippet: source,
          snippetMatchRange: { start, end },
        },
      ],
    })
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

  it("indexes assistant numeric character references as rendered text across append and reopen", async () => {
    const { root, store } = await setup()
    const threadId = "session_entities"
    await save(store, threadId, [])
    await store.resumeThread(threadId)
    await store.appendItems(threadId, [
      response(
        "turn_entities",
        "assistant",
        "&#0; &#xD800; &#1114112; &#128; &#xFFFF; &#128512; &#x1F600;&#10;&#999999999999;",
      ),
      completed("turn_entities"),
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
          itemId: "item_turn_entities_assistant",
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

it("rebuilds old search text projections from unchanged authoritative rollouts", async () => {
  const { root, store } = await setup()
  const threadId = "session_old_projection"
  await save(store, threadId, [
    response("turn_source", "user", "Use `foo_bar | baz` now."),
    response("turn_literal", "assistant", "Use `foo_bar | baz` now."),
    completed("turn_literal"),
  ])
  const stored = await store.readThread(threadId)
  if (!stored) throw new Error("Missing persisted thread")
  const rolloutPath = join(
    root,
    "rollouts",
    stored.metadata.rolloutId,
    "rollout.jsonl",
  )
  const authoritative = await readFile(rolloutPath)
  const database = new DatabaseSync(join(root, "thread-search.sqlite"))
  try {
    // Version 3 parsed user source as Markdown. Keep the source stamps current:
    // only changing the disposable projection version can rebuild this cache.
    database
      .prepare(
        "UPDATE search_messages SET text = ? WHERE thread_id = ? AND kind = 'user'",
      )
      .run("Use foo_bar | baz now.", threadId)
    database.exec("PRAGMA user_version = 3")
  } finally {
    database.close()
  }
  const reopened = new JsonlThreadStore({ root })
  await expect(
    reopened.searchThreadOccurrences({
      threadId,
      searchTerm: "`foo_bar | baz`",
      limit: 10,
    }),
  ).resolves.toEqual({
    occurrences: [
      {
        turnId: "turn_source",
        itemId: "item_turn_source_user",
        snippet: "Use `foo_bar | baz` now.",
        snippetMatchRange: { start: 4, end: 19 },
      },
    ],
  })
  await expect(
    reopened.searchThreadOccurrences({
      threadId,
      searchTerm: "Use foo_bar | baz now.",
      limit: 10,
    }),
  ).resolves.toEqual({
    occurrences: [
      {
        turnId: "turn_literal",
        itemId: "item_turn_literal_assistant",
        snippet: "Use foo_bar | baz now.",
        snippetMatchRange: { start: 0, end: 22 },
      },
    ],
  })
  expect(await readFile(rolloutPath)).toEqual(authoritative)
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
        ? {
            role,
            toolCallId: `call_${turnId}`,
            content: [{ type: "text" as const, text }],
          }
        : { role, content: [{ type: "text" as const, text }] },
  }
}

function completed(turnId: string): RolloutItem {
  return { type: "turn_completed", turnId, outcome: "completed" }
}
