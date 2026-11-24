import { describe, expect, it } from "vitest"
import { ContextManager } from "../../src/core/context-manager.ts"
import type {
  ResponseItemEnvelope,
  RolloutItem,
  StoredThread,
  ThreadMetadata,
} from "../../src/core/rollout.ts"
import { toolContentText } from "../../src/runtime/model-tool-content.ts"
import { messageContent } from "../fixtures/model-history.ts"

it("preserves agent provenance in live and restored model history without changing stored text", () => {
  const envelope: ResponseItemEnvelope = {
    id: "agent_message",
    turnId: "turn",
    createdAt: "2026-11-17T00:00:00Z",
    submissionMetadata: { source: "agent", purpose: "message" },
    item: { role: "user", content: [{ type: "text", text: "Agent progress" }] },
  }
  const live = new ContextManager()
  live.record([envelope])
  const restored = ContextManager.fromStoredThread(
    storedThread([
      { type: "agent_message", messageId: "agent_message", item: envelope },
    ]),
  )
  expect(live.snapshot().history).toEqual(restored.snapshot().history)
  expect(live.snapshot().history[0]?.item).toEqual({
    role: "user",
    context: { type: "agent_message" },
    content: [{ type: "text", text: "Agent progress" }],
  })
  expect(envelope.item).not.toHaveProperty("context")
})

it("keeps assigned agent tasks as task input in live and restored history", () => {
  const envelope: ResponseItemEnvelope = {
    id: "agent_task",
    turnId: "turn",
    createdAt: "2026-11-17T00:00:00Z",
    submissionMetadata: { source: "agent", purpose: "task" },
    item: {
      role: "user",
      content: [{ type: "text", text: "Inspect the child task" }],
    },
  }
  const live = new ContextManager()
  live.record([envelope])
  const restored = ContextManager.fromStoredThread(
    storedThread([{ type: "response_item", item: envelope }]),
  )
  expect(live.snapshot().history[0]?.item).toEqual(envelope.item)
  expect(restored.snapshot().history[0]?.item).toEqual(envelope.item)
})

describe("ContextManager tool history", () => {
  it("shares a UTF-8 budget across text blocks while retaining media order", () => {
    const image = {
      type: "image" as const,
      mediaType: "image/png" as const,
      data: "cGl4ZWxz",
    }
    const envelope: ResponseItemEnvelope = {
      id: "result",
      turnId: "turn",
      createdAt: "2026-10-07T00:00:00Z",
      historyOutputBudget: { maxBytes: 64, maxLines: 4 },
      toolContentBlockCount: 5,
      item: {
        role: "tool",
        toolCallId: "call",
        content: [
          { type: "text", text: "start" },
          image,
          { type: "text", text: "正文🙂\n".repeat(100) },
          image,
          { type: "text", text: "end" },
        ],
      },
    }
    const manager = new ContextManager()
    manager.record([envelope])
    const result = manager.snapshot().history[0]?.item
    if (result?.role !== "tool") throw new Error("Missing tool history")
    const text = toolContentText(result.content)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64)
    expect(text.split("\n").length).toBeLessThanOrEqual(4)
    expect(text).toContain("[Output truncated.]")
    expect(text).not.toContain("�")
    expect(result.content.filter((block) => block.type === "image")).toEqual([
      image,
      image,
    ])
    expect(result.content[0]).toEqual({ type: "text", text: "start" })
    expect(messageContent(envelope.item)).toHaveLength(5)
    const projected = manager.snapshot().history
    expect(projected[0]?.toolContentBlockCount).toBe(result.content.length)
    manager.replace(projected)
    expect(manager.snapshot().history).toEqual(projected)
  })
})

describe("ContextManager world-state reconstruction", () => {
  it("applies patches to the last full baseline in rollout order", () => {
    const manager = ContextManager.fromStoredThread(
      storedThread([
        {
          type: "world_state",
          turnId: "turn_one",
          full: true,
          state: {
            model: "faux/model-a",
            environment: { cwd: "/workspace", date: "2026-08-30" },
          },
        },
        {
          type: "world_state",
          turnId: "turn_two",
          full: false,
          state: {
            model: "faux/model-b",
            environment: { date: "2026-08-31" },
          },
        },
      ]),
    )

    expect(manager.snapshot().worldStateBaseline).toEqual({
      model: "faux/model-b",
      environment: { cwd: "/workspace", date: "2026-08-31" },
    })
  })

  it("requires a new full baseline after compaction", () => {
    const compactedHistory: RolloutItem[] = [
      {
        type: "world_state",
        turnId: "turn_one",
        full: true,
        state: { environment: { cwd: "/old" } },
      },
      {
        type: "compacted",
        turnId: "turn_two",
        replacement: [],
        summary: "checkpoint",
      },
      {
        type: "world_state",
        turnId: "turn_two",
        full: false,
        state: { environment: { cwd: "/orphan" } },
      },
    ]
    const orphan = ContextManager.fromStoredThread(
      storedThread(compactedHistory),
    )
    expect(orphan.snapshot().worldStateBaseline).toBeUndefined()

    const manager = ContextManager.fromStoredThread(
      storedThread([
        ...compactedHistory,
        {
          type: "world_state",
          turnId: "turn_two",
          full: true,
          state: { environment: { cwd: "/new" } },
        },
      ]),
    )

    expect(manager.snapshot().worldStateBaseline).toEqual({
      environment: { cwd: "/new" },
    })
  })
})

function storedThread(items: readonly RolloutItem[]): StoredThread {
  const now = "2026-08-30T00:00:00.000Z"
  const metadata: ThreadMetadata = {
    id: "thread_test",
    rolloutId: "rollout_test",
    conversationId: "conversation_test",
    createdAt: now,
    updatedAt: now,
  }
  return {
    metadata,
    rollout: [
      {
        threadId: metadata.id,
        rolloutId: metadata.rolloutId,
        seq: 0,
        createdAt: now,
        item: { type: "session_meta", metadata },
      },
      ...items.map((item, index) => ({
        threadId: metadata.id,
        rolloutId: metadata.rolloutId,
        seq: index + 1,
        createdAt: now,
        item,
      })),
    ],
  }
}
