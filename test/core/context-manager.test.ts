import { describe, expect, it } from "vitest"
import { ContextManager } from "../../src/core/context-manager.ts"
import type {
  RolloutItem,
  StoredThread,
  ThreadMetadata,
} from "../../src/core/rollout.ts"

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
