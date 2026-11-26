import { ActiveTurnDisplay } from "../../src/server/active-turn-display.ts"
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
  return { handlers, store }
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

function prompt(
  turnId: string,
  text: string,
  id = `input_${turnId}`,
): RolloutItem {
  return {
    type: "response_item",
    item: {
      id,
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

describe("active Turn transcript", () => {
  it("keeps steer input, an early reply and an image after the activity window fills", () => {
    const turnId = "long"
    const transcript: RolloutItem[] = [
      prompt(turnId, "Initial input"),
      start(turnId),
      prompt(turnId, "Additional input", "input_steer"),
      {
        type: "item_completed",
        turnId,
        item: {
          type: "agent_message",
          itemId: "early_reply",
          content: [{ type: "text", text: "The first check completed." }],
        },
      },
      {
        type: "item_completed",
        turnId,
        item: {
          type: "image_output",
          itemId: "early_image",
          image: {
            type: "image",
            mediaType: "image/png",
            file: { rolloutId: sessionId, path: "generated/image.png" },
            sizeBytes: 128,
          },
        },
      },
    ]
    const activity = Array.from(
      { length: 205 },
      (_, index): RolloutItem => ({
        type: "item_started",
        turnId,
        item: {
          type: "command_execution",
          itemId: `command_${index}`,
          toolCallId: `call_${index}`,
          name: "exec_command",
          input: { cmd: "test" },
          command: "test",
          requiresPermission: false,
        },
      }),
    )
    const display = new ActiveTurnDisplay()
    display.append(
      [...transcript, ...activity].map((item, index) => ({
        threadId: sessionId,
        rolloutId: sessionId,
        seq: index + 1,
        createdAt,
        item,
      })),
    )
    const active = display.capture(turnId)
    expect(
      active?.records.slice(0, transcript.length).map(({ item }) => item),
    ).toEqual(transcript)
    expect(
      active?.records.filter(({ item }) => item.type === "item_started"),
    ).toHaveLength(200)
    expect(active?.activityBefore).toBe(11)
    display.finish(turnId)
    expect(display.capture(turnId)).toBeUndefined()
    expect(display.capture("next")).toEqual({ turnId: "next", records: [] })
  })
})

describe("projected Turn reads after reopening storage", () => {
  it("pages older activity for a large active Turn without losing the prompt or start", async () => {
    const turnId = "large"
    const { handlers, store } = await createHandlers([
      prompt(turnId, "An ongoing turn with many tools"),
      start(turnId),
      ...Array.from(
        { length: 24 },
        (_, index): RolloutItem => ({
          type: "item_completed",
          turnId,
          item: {
            type: "command_execution",
            itemId: `command_${index}`,
            toolCallId: `call_${index}`,
            name: "exec_command",
            input: { cmd: "test" },
            command: "test",
            requiresPermission: false,
            resultItemId: `result_${index}`,
            content: { kind: "text", text: "x".repeat(16 * 1024) },
          },
        }),
      ),
    ])
    const display = new ActiveTurnDisplay()
    const persisted = await store.readThread(sessionId)
    display.append(persisted?.rollout ?? [])
    const active = display.capture(turnId)
    expect(active?.records.map(({ item }) => item.type).slice(0, 2)).toEqual([
      "response_item",
      "turn_started",
    ])
    const before = active?.activityBefore
    if (active === undefined || before === undefined)
      throw new Error("Expected a cursor for omitted activity")
    const earlier = await handlers.readDisplayActivity({
      sessionId,
      rolloutId: sessionId,
      turnId,
      before,
    })
    if (!earlier.ok) throw new Error(earlier.error.message)
    const oldIds = earlier.value.events.flatMap((event) =>
      event.type === "item.completed" ? [event.data.item.itemId] : [],
    )
    const liveIds = active.records.flatMap(({ item }) =>
      item.type === "item_completed" ? [item.item.itemId] : [],
    )
    expect([...oldIds, ...liveIds]).toEqual(
      Array.from({ length: 24 }, (_, index) => `command_${index}`),
    )

    const live = await handlers.readLiveSession({ sessionId })
    expect(live).toMatchObject({ ok: true, value: { watermarkSeq: 27 } })
    expect(live).not.toHaveProperty("value.activeTurn")
    const interrupted = await handlers.listCompletedTurns({
      sessionId,
      rolloutId: sessionId,
      through: 27,
      view: "summary",
    })
    expect(interrupted).toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            turnId,
            outcome: "interrupted",
            completionSeq: 27,
            activityCount: 24,
          },
        ],
      },
    })
    if (!interrupted.ok || interrupted.value.view !== "summary")
      throw new Error("Missing interrupted Turn")
    expect(interrupted.value.turns[0]?.events.map(({ type }) => type)).toEqual([
      "input.admitted",
      "turn.started",
    ])
    const duringTurn = await handlers.listCompletedTurns({
      sessionId,
      rolloutId: sessionId,
      through: 27,
      activeTurnId: turnId,
      view: "summary",
    })
    expect(duringTurn).toMatchObject({ ok: true, value: { turns: [] } })
  })

  it("hydrates the latest model and tokens while retaining the last successful turn's cache policy", async () => {
    const { handlers } = await createHandlers([
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

    const result = await handlers.listCompletedTurns({
      sessionId,
      view: "summary",
    })
    if (!result.ok) throw new Error(result.error.message)
    expect(result.value).toMatchObject({
      currentModel: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        effort: "high",
      },
      cacheExpiry: {
        provider: "openai",
        lastRequestStartedAt: "2026-11-11T00:02:00.000Z",
        expiresAt: "2026-11-11T00:32:00.000Z",
      },
      contextTokens: { activeContextTokens: 456 },
      turns: [
        { turnId: "latest", outcome: "interrupted" },
        { turnId: "failed", outcome: "failed" },
        { turnId: "success", outcome: "completed" },
      ],
    })
    const live = await handlers.readLiveSession({ sessionId })
    expect(live).toMatchObject({
      ok: true,
      value: { session: { counts: { turns: 3, inputs: 3 } } },
    })
  })
})
