import { expect, it } from "vitest"
import type { StoredRolloutItem } from "../../src/core/rollout.ts"
import type { ModelCitation } from "../../src/protocol/conversation.ts"
import type { JsonObject } from "../../src/protocol/events.ts"
import { mapRolloutEvent } from "../../src/server/session-event-projection.ts"

const url = "https://example.test/source"
const web = {
  type: "url_citation",
  url,
  title: "Source",
  start_index: 2,
  end_index: 6,
}
const expectedWeb: ModelCitation = {
  kind: "url",
  title: "Source",
  url,
  responseSpan: { start: 3, end: 7 },
}

it.each<{ providerMetadata: JsonObject; expected: ModelCitation }>([
  {
    providerMetadata: { openai: { part: { annotations: [web] } } },
    expected: expectedWeb,
  },
  {
    providerMetadata: {
      chatCompletions: {
        annotations: [null, { type: "url_citation", url_citation: web }],
      },
    },
    expected: expectedWeb,
  },
  {
    providerMetadata: {
      anthropic: {
        citations: [
          {
            type: "char_location",
            document_title: "Report",
            cited_text: "Quote from the document",
            start_char_index: 340,
            end_char_index: 363,
          },
        ],
      },
    },
    expected: {
      kind: "document",
      title: "Report",
      citedText: "Quote from the document",
      sourceLocation: { unit: "character", start: 340, end: 363 },
    },
  },
])("restores citations from a historical completion when replaying the transcript", ({
  providerMetadata,
  expected,
}) => {
  const block = { type: "text", text: "前😀Text", providerMetadata } as const
  const stored: StoredRolloutItem = {
    threadId: "session_citations",
    rolloutId: "rollout_citations",
    seq: 7,
    createdAt: "2026-11-22T00:00:00.000Z",
    item: {
      type: "item_completed",
      turnId: "turn_citations",
      item: { type: "agent_message", itemId: "answer", content: [block] },
    },
  }

  const event = mapRolloutEvent(stored, stored.threadId)
  expect(event).toMatchObject({
    type: "item.completed",
    data: {
      item: {
        type: "agent_message",
        content: [{ annotations: [expected] }],
      },
    },
  })
  expect(block).not.toHaveProperty("annotations")
})
