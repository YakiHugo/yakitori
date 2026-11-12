import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import type { RolloutItem } from "../../src/core/rollout.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import type { ModelSelection } from "../../src/kernel/events.ts"
import { createThreadServerHandlers } from "../../src/server/handlers.ts"
import { InputQueue } from "../../src/server/input-queue.ts"

const sessionId = "session_00000000-0000-4000-8000-000000000001"
const createdAt = "2026-11-11T00:00:00.000Z"
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function createHandlers(items: readonly RolloutItem[]) {
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
