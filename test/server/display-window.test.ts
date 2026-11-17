import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import type { RolloutItem } from "../../src/core/rollout.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import type { ModelSelection } from "../../src/kernel/events.ts"
import { createThreadServerHandlers } from "../../src/server/handlers.ts"
import { InputQueue } from "../../src/server/input-queue.ts"
import {
  createExecutionViewState,
  projectExecutionView,
  reduceExecutionView,
} from "../../src/shared/execution-view.ts"

const sessionId = "session_00000000-0000-4000-8000-000000000001"
const createdAt = "2026-11-11T00:00:00.000Z"
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.useRealTimers()
})

async function createHandlers(
  items: readonly RolloutItem[],
  later?: Readonly<{ at: string; items: readonly RolloutItem[] }>,
) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-display-handlers-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const writer = new JsonlThreadStore({ root })
  await writer.createThread({
    id: sessionId,
    conversationId: sessionId,
    createdAt,
    updatedAt: createdAt,
  })
  await writer.persistThread(sessionId, "turn_start")
  await writer.appendItems(sessionId, items)
  if (later !== undefined) {
    vi.setSystemTime(new Date(later.at))
    await writer.appendItems(sessionId, later.items)
  }
  await writer.shutdownThread(sessionId)

  // Reopen the real persisted store without installing a live Session actor.
  const store = new JsonlThreadStore({ root })
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () => {
      throw new Error("Display reads must not start a Turn.")
    },
  })
  const inputQueue = new InputQueue(":memory:")
  const handlers = createThreadServerHandlers({ store, manager, inputQueue })
  cleanups.push(async () => {
    await handlers.close()
    await manager.shutdown()
    inputQueue.close()
  })
  return handlers
}

function context(
  turnId: string,
  selection: ModelSelection,
  modelChoice = selection,
): RolloutItem {
  return {
    type: "turn_context",
    context: {
      turnId,
      selection,
      configuration: {
        schemaVersion: 5,
        workspaceRoot: "/workspace",
        promptCacheKey: "display-window-test",
        defaultTarget: selection,
        modelChoice,
        serviceId: selection.provider,
        baseInstructions: {
          text: "",
          revision: "test",
          provenance: { type: "custom" },
        },
        enabledTools: [],
        approvalPolicy: "always_approve",
        executionPolicyDefaults: {
          modelVisibleToolResultBytes: 1024,
          modelVisibleToolResultLines: 100,
          assistantResponseBytes: 1024,
        },
        modelAutoCompactTokenLimitScope: "total",
      },
    },
  }
}

function prompt(turnId: string, text: string): RolloutItem {
  return {
    type: "response_item",
    item: {
      id: `input_${turnId}`,
      turnId,
      createdAt,
      item: { role: "user", content: [{ type: "text", text }] },
    },
  }
}

function start(turnId: string): RolloutItem {
  return {
    type: "turn_started",
    turnId,
    inputItemId: `input_${turnId}`,
    source: "human",
    purpose: "message",
  }
}

describe("display window handlers with persisted history", () => {
  it.each([
    "active",
    "completed",
  ] as const)("retains the original start outside a bounded %s turn without moving history coverage", async (status) => {
    const startedAt = "2026-11-11T00:00:00.000Z"
    const finishedAt = "2026-11-11T00:00:45.000Z"
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(startedAt))
    const tail: RolloutItem[] = Array.from({ length: 220 }, (_, index) => ({
      type: "item_completed",
      turnId: "large",
      item: {
        type: "agent_message",
        itemId: `answer_large_${index}`,
        content: [{ type: "text", text: `Reply ${index}` }],
      },
    }))
    if (status === "completed") {
      tail.push({
        type: "turn_completed",
        turnId: "large",
        outcome: "completed",
      })
    }
    const handlers = await createHandlers(
      [
        start("large"),
        context("large", { provider: "openai", model: "gpt-6-sol" }),
        prompt("large", "A turn larger than one display page"),
        {
          type: "token_count",
          turnId: "large",
          activeContextTokens: 123,
          capacityTokens: 10_000,
        },
      ],
      { at: finishedAt, items: tail },
    )
    const result = await handlers.readDisplayWindow({ sessionId })
    if (!result.ok) throw new Error(result.error.message)
    const { events, historyBefore, session } = result.value
    expect(events[0]).toMatchObject({
      type: "turn.started",
      seq: 2,
      createdAt: startedAt,
      data: { turnId: "large", inputId: "input_large" },
    })
    expect(events[1]).toMatchObject({
      type: "context.tokens",
      seq: 5,
      data: { turnId: "large", activeContextTokens: 123 },
    })
    // The initial records plus 220 replies exceed the 200-record page.
    // Supplemental start/tokens precede coverage and must not skip that gap.
    expect(historyBefore).toBe(status === "completed" ? 26 : 25)
    expect(events[2]).toMatchObject({
      type: "item.completed",
      seq: status === "completed" ? 27 : 26,
      createdAt: finishedAt,
      data: {
        item: {
          itemId:
            status === "completed" ? "answer_large_21" : "answer_large_20",
        },
      },
    })
    expect(events).toHaveLength(202)
    expect(
      events.every(
        (event, index) =>
          index === 0 || event.seq > (events[index - 1]?.seq ?? 0),
      ),
    ).toBe(true)

    const replayed = events.reduce(
      (state, event) =>
        reduceExecutionView(state, { type: "durable", event, replay: true }),
      createExecutionViewState(),
    )
    const view = projectExecutionView(
      reduceExecutionView(replayed, { type: "replay_completed", session }),
    )
    expect(view.turnTimings.large).toMatchObject({
      inputId: "input_large",
      startedAt,
    })
    expect(view.contextTokens).toMatchObject({ activeContextTokens: 123 })
    if (status === "active") {
      // A cold store has no live actor; the authoritative snapshot is idle.
      // Retaining the start still permits a later resident snapshot to show
      // elapsed time from the original request rather than the first reply.
      const resident = projectExecutionView(
        reduceExecutionView(replayed, {
          type: "replay_completed",
          session: { ...session, activeTurnId: "large" },
        }),
      )
      expect(resident.activeTurnId).toBe("large")
      expect(resident.activeTurnStartedAt).toBe(startedAt)
      expect(
        Date.parse(finishedAt) - Date.parse(resident.activeTurnStartedAt ?? ""),
      ).toBe(45_000)
    } else {
      expect(view.turnTimings.large).toMatchObject({
        completedAt: finishedAt,
        outcome: { status: "completed" },
      })
      expect(
        Date.parse(view.turnTimings.large?.completedAt ?? "") -
          Date.parse(view.turnTimings.large?.startedAt ?? ""),
      ).toBe(45_000)
      expect(view.activeTurnId).toBeUndefined()
      expect(
        reduceExecutionView(replayed, {
          type: "replay_completed",
          session: { ...session, activeTurnId: "large" },
        }).activeTurnId,
      ).toBeUndefined()
    }
  })

  it("pages from contiguous history coverage when a supplemental token precedes unseen replies", async () => {
    const handlers = await createHandlers([
      start("old"),
      context("old", { provider: "openai", model: "gpt-6-sol" }),
      prompt("old", "earlier prompt"),
      {
        type: "token_count",
        turnId: "old",
        activeContextTokens: 321,
        capacityTokens: 10_000,
      },
      {
        type: "item_completed",
        turnId: "old",
        item: {
          type: "agent_message",
          itemId: "answer_old",
          content: [{ type: "text", text: "earlier answer" }],
        },
      },
      {
        type: "turn_completed",
        turnId: "old",
        outcome: "completed",
        lastRequestStartedAt: "2026-11-11T00:01:00.000Z",
      },
      start("latest"),
      context("latest", { provider: "anthropic", model: "claude-sonnet-4-6" }),
      prompt("latest", "latest prompt"),
    ])

    const latest = await handlers.readDisplayWindow({ sessionId })
    if (!latest.ok) throw new Error(latest.error.message)
    expect(latest.value.historyBefore).toBe(7)
    expect(latest.value.events[0]).toMatchObject({
      seq: 5,
      type: "context.tokens",
      data: { activeContextTokens: 321, capacityTokens: 10_000 },
    })
    expect(latest.value.session).toMatchObject({
      seq: 10,
      currentModel: { provider: "anthropic", model: "claude-sonnet-4-6" },
      counts: { inputs: 1, turns: 1 },
      cacheExpiry: {
        provider: "openai",
        lastRequestStartedAt: "2026-11-11T00:01:00.000Z",
        expiresAt: "2026-11-11T00:31:00.000Z",
      },
    })
    expect(
      latest.value.events.some((event) => event.type === "item.completed"),
    ).toBe(false)

    const earlier = await handlers.readDisplayWindow({
      sessionId,
      before: latest.value.historyBefore,
    })
    if (!earlier.ok) throw new Error(earlier.error.message)
    expect(earlier.value.events).toContainEqual(
      expect.objectContaining({
        seq: 6,
        type: "item.completed",
        data: {
          turnId: "old",
          item: {
            type: "agent_message",
            itemId: "answer_old",
            content: [{ type: "text", text: "earlier answer" }],
          },
        },
      }),
    )
    expect(earlier.value.events).toContainEqual(
      expect.objectContaining({
        seq: 7,
        type: "turn.completed",
      }),
    )
    expect(earlier.value.events).toContainEqual(
      expect.objectContaining({
        seq: 2,
        type: "turn.started",
      }),
    )
    expect(earlier.value.historyBefore).toBeUndefined()
    expect(earlier.value.session.seq).toBe(10)
  })

  it("hydrates the latest model and tokens while retaining the last successful turn's cache policy", async () => {
    const handlers = await createHandlers([
      start("success"),
      context("success", { provider: "openai", model: "gpt-6-sol" }),
      prompt("success", "successful prompt"),
      {
        type: "token_count",
        turnId: "success",
        activeContextTokens: 456,
      },
      {
        type: "turn_completed",
        turnId: "success",
        outcome: "completed",
        lastRequestStartedAt: "2026-11-11T00:02:00.000Z",
      },
      start("failed"),
      context(
        "failed",
        { provider: "account_anthropic", model: "claude-sonnet-4-6" },
        { provider: "anthropic", model: "claude-sonnet-4-6", effort: "high" },
      ),
      prompt("failed", "failed prompt"),
      { type: "turn_completed", turnId: "failed", outcome: "failed" },
      start("latest"),
      prompt("latest", "pending model resolution"),
    ])

    const result = await handlers.readDisplayWindow({ sessionId })
    if (!result.ok) throw new Error(result.error.message)
    expect(result.value.session.currentModel).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      effort: "high",
    })
    expect(result.value.session.cacheExpiry).toMatchObject({
      provider: "openai",
      lastRequestStartedAt: "2026-11-11T00:02:00.000Z",
      expiresAt: "2026-11-11T00:32:00.000Z",
    })
    expect(result.value.events).toHaveLength(3)
    expect(result.value.events[0]).toMatchObject({
      type: "context.tokens",
      data: { turnId: "success", activeContextTokens: 456 },
    })
    expect(result.value.session.counts).toMatchObject({ inputs: 1, turns: 1 })
  })
})
