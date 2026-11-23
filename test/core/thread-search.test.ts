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
  it("indexes hosted web results and plan steps only in tool activity search", async () => {
    const { root, store } = await setup()
    const threadId = "session_search_activity"
    const turnId = "turn_activity"
    const hostedUrl = "https://example.test/hosted-needle"
    const step = "Check the plan needle"
    await save(store, threadId, [
      { type: "turn_started", turnId, inputItemId: "input_activity" },
      {
        type: "item_completed",
        turnId,
        item: {
          type: "hosted_tool",
          itemId: "item_hosted",
          provider: "fixture",
          tool: {
            type: "hosted_tool",
            id: "search",
            kind: "web_search",
            status: "completed",
            detail: hostedUrl,
          },
        },
      },
      {
        type: "item_completed",
        turnId,
        item: {
          type: "dynamic_tool_call",
          itemId: "item_plan",
          toolCallId: "call_plan",
          name: "update_plan",
          input: {},
          requiresPermission: false,
          resultItemId: "result_plan",
          content: { kind: "text", text: "Plan updated" },
          output: { plan: [{ step, status: "pending" }] },
        },
      },
      completed(turnId),
    ])
    const reopened = new JsonlThreadStore({ root })
    for (const [searchTerm, itemId] of [
      [hostedUrl, "item_hosted"],
      [step, "item_plan"],
    ] as const) {
      const input = { searchTerm, limit: 5 }
      expect((await reopened.searchThreads(input)).matches).toEqual([])
      const { matches } = await reopened.searchThreads({
        ...input,
        toolActivity: true,
      })
      expect(matches.map(({ location }) => location)).toEqual([
        { rolloutId: threadId, turnId, itemId },
      ])
      const target = await reopened.readDisplayLocation(
        threadId,
        { rolloutId: threadId, turnId, itemId },
        {},
      )
      expect(
        target?.records.some(
          ({ item }) =>
            item.type === "item_completed" && item.item.itemId === itemId,
        ),
      ).toBe(true)
    }
  })
  it("finds tool metadata and opens its activity or exact result", async () => {
    const { root, store } = await setup()
    const threadId = "session_tool_history"
    const turnId = "turn_tool"
    const itemId = "item_tool_card"
    const result = envelope(turnId, "tool", "raw tool output marker")
    await save(store, threadId, [
      { type: "turn_started", turnId, inputItemId: "input_tool" },
      { type: "response_item", item: result },
      {
        type: "item_completed",
        turnId,
        item: {
          type: "file_read",
          itemId,
          toolCallId: `call_${turnId}`,
          name: "read_file",
          path: "src/retry.ts",
          input: { path: "src/retry.ts" },
          requiresPermission: false,
          resultItemId: result.id,
          content: { kind: "text", text: "raw tool output marker" },
          error: { code: "ETIMEDOUT", message: "Timed out" },
        },
      },
      completed(turnId),
    ])
    const reopened = new JsonlThreadStore({ root })
    const location = {
      rolloutId: threadId,
      turnId,
      itemId,
      resultItemId: result.id,
    }
    for (const searchTerm of ["read_file", "retry.ts", "ETIMEDOUT"]) {
      expect(
        (await reopened.searchThreads({ searchTerm, limit: 5 })).matches,
      ).toEqual([])
      expect(
        (
          await reopened.searchThreads({
            searchTerm,
            toolActivity: true,
            limit: 5,
          })
        ).matches,
      ).toMatchObject([{ location }])
    }
    expect(
      (
        await reopened.searchThreads({
          searchTerm: "raw tool output marker",
          toolActivity: true,
          limit: 5,
        })
      ).matches,
    ).toEqual([])
    expect(
      (
        await reopened.searchThreadOccurrences({
          threadId,
          searchTerm: "retry.ts",
          toolActivity: true,
          limit: 5,
        })
      )?.occurrences,
    ).toMatchObject([{ turnId, itemId, resultItemId: result.id }])
    const page = await reopened.readDisplayLocation(threadId, location, {})
    expect(
      page?.records.some(
        ({ item }) =>
          item.type === "item_completed" && item.item.itemId === itemId,
      ),
    ).toBe(true)
    expect(
      (await reopened.readTranscriptItem(threadId, result.id))?.record.item,
    ).toEqual({ type: "response_item", item: result })
  })

  it("opens a body match in the requested history version and preserves forked source records", async () => {
    const { root, store } = await setup()
    const threadId = "session_location"
    const turnId = "turn_first"
    const itemId = "input_located"
    await save(
      store,
      threadId,
      [
        { type: "turn_started", turnId, inputItemId: itemId },
        {
          type: "response_item",
          item: { ...envelope(turnId, "user", "unique needle 🧭"), id: itemId },
        },
        completed(turnId),
        {
          type: "turn_started",
          turnId: "turn_next",
          inputItemId: "input_next",
        },
        completed("turn_next"),
      ],
      { title: "title only" },
    )
    const reopened = new JsonlThreadStore({ root })
    const result = await reopened.searchThreads({
      searchTerm: "unique needle",
      limit: 5,
    })
    const location = result.matches[0]?.location
    expect(location).toEqual({ rolloutId: threadId, turnId, itemId })
    if (location === undefined) throw new Error("Missing search location.")
    const page = await reopened.readDisplayLocation(threadId, location, {})
    expect(page?.records.map(({ seq }) => seq)).toEqual([1, 2, 3])
    expect(page?.historyAfter).toBe(4)
    const later = await reopened.readDisplayLocation(threadId, location, {
      after: 4,
    })
    expect(later?.records.some(({ seq }) => seq === 5)).toBe(true)
    expect(later?.historyAfter).toBeUndefined()
    expect(
      (await reopened.searchThreads({ searchTerm: "title only", limit: 5 }))
        .matches[0]?.location,
    ).toBeUndefined()
    const prepared = await reopened.prepareFork({
      sourceThreadId: threadId,
      boundary: { type: "through_turn", turnId },
    })
    const forkId = "session_location_fork"
    await reopened.createFork({
      prepared,
      target: {
        id: forkId,
        conversationId: forkId,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    })
    await reopened.revertThread({
      threadId,
      beforeTurnId: turnId,
      expectedRolloutId: threadId,
    })
    expect(
      await reopened.readDisplayLocation(threadId, location, {}),
    ).toBeUndefined()
    const inherited = await reopened.readTranscriptItem(forkId, itemId)
    expect(inherited?.record).toMatchObject({
      rolloutId: threadId,
      item: {
        item: {
          id: itemId,
          item: { content: [{ type: "text", text: "unique needle 🧭" }] },
        },
      },
    })
    await reopened.shutdownThread(threadId)
    await reopened.shutdownThread(forkId)
  })

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
