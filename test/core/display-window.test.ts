import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  displayTailReady,
  readJsonlTail,
  selectDisplayWindow,
} from "../../src/core/display-window.ts"
import type { StoredRolloutItem } from "../../src/core/rollout.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

function record(
  seq: number,
  item: StoredRolloutItem["item"],
): StoredRolloutItem {
  return {
    threadId: "thread_1",
    rolloutId: "rollout_1",
    seq,
    createdAt: "2026-11-11T00:00:00.000Z",
    item,
  }
}

function userInput(seq: number, id: string, text: string): StoredRolloutItem {
  return record(seq, {
    type: "response_item",
    item: {
      id,
      turnId: id,
      createdAt: "2026-11-11T00:00:00.000Z",
      item: { role: "user", content: [{ type: "text", text }] },
    },
  })
}

function turnStart(seq: number, turnId: string): StoredRolloutItem {
  return record(seq, { type: "turn_started", turnId })
}

function turnContext(seq: number, turnId: string): StoredRolloutItem {
  const selection = { provider: "faux", model: "scripted" }
  return record(seq, {
    type: "turn_context",
    context: {
      turnId,
      selection,
      configuration: SessionConfiguration.create({
        selection,
        workspaceRoot: "/workspace",
        enabledTools: [],
        approvalPolicy: "always_approve",
        promptCacheKey: turnId,
      }).snapshot,
    },
  })
}

describe("selectDisplayWindow", () => {
  it("keeps the latest user prompt and the replies after it", () => {
    const early = userInput(1, "input_early", "earlier")
    const latest = userInput(4, "input_latest", "current")
    const reply = record(5, {
      type: "turn_completed",
      turnId: "turn_latest",
      outcome: "completed",
    })
    const window = selectDisplayWindow([
      record(0, {
        type: "session_meta",
        metadata: {
          id: "thread_1",
          rolloutId: "rollout_1",
          conversationId: "thread_1",
          createdAt: "2026-11-11T00:00:00.000Z",
          updatedAt: "2026-11-11T00:00:00.000Z",
        },
      }),
      early,
      record(2, {
        type: "token_count",
        turnId: "turn_early",
        activeContextTokens: 12,
      }),
      record(3, {
        type: "turn_completed",
        turnId: "turn_early",
        outcome: "completed",
      }),
      latest,
      reply,
    ])
    expect(window.records.map((entry) => entry.seq)).toEqual([4, 5])
    expect(window.lookbehind.map((entry) => entry.item.type)).toEqual([
      "token_count",
    ])
    expect(window.hasEarlier).toBe(true)
  })

  it("reports no earlier conversation when the latest prompt is the first one", () => {
    const window = selectDisplayWindow([
      userInput(1, "input_only", "only"),
      record(2, {
        type: "token_count",
        turnId: "turn_only",
        activeContextTokens: 4,
      }),
    ])
    expect(window.hasEarlier).toBe(false)
    expect(window.records.map((entry) => entry.seq)).toEqual([1, 2])
  })

  it("partitions complete Turn records without moving coverage to supplemental state", () => {
    const records = [
      turnStart(1, "input_early"),
      turnContext(2, "input_early"),
      userInput(3, "input_early", "earlier"),
      record(4, {
        type: "token_count",
        turnId: "input_early",
        activeContextTokens: 12,
      }),
      record(5, {
        type: "turn_completed",
        turnId: "input_early",
        outcome: "completed",
      }),
      turnStart(6, "input_latest"),
      turnContext(7, "input_latest"),
      userInput(8, "input_latest", "current"),
    ]
    const latest = selectDisplayWindow(records)
    expect(latest.records.map((entry) => entry.seq)).toEqual([6, 7, 8])
    expect(latest.lookbehind.map((entry) => entry.seq)).toEqual([2, 4, 5])
    const earlier = selectDisplayWindow(records, latest.records[0]?.seq)
    expect(earlier.records.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5])
    expect(earlier.hasEarlier).toBe(false)
    expect([...earlier.records, ...latest.records]).toEqual(records)
  })

  it("keeps successful cache context across a later failed Turn", () => {
    const records = [
      turnContext(1, "input_cached"),
      userInput(2, "input_cached", "cached"),
      record(3, {
        type: "token_count",
        turnId: "input_cached",
        activeContextTokens: 12,
      }),
      record(4, {
        type: "turn_completed",
        turnId: "input_cached",
        outcome: "completed",
      }),
      turnContext(5, "input_failed"),
      userInput(6, "input_failed", "failed"),
      record(7, {
        type: "turn_completed",
        turnId: "input_failed",
        outcome: "failed",
      }),
      turnStart(8, "input_latest"),
      userInput(9, "input_latest", "current"),
    ]
    const latest = selectDisplayWindow(records)
    expect(latest.lookbehind.map((entry) => entry.seq)).toEqual([1, 3, 4, 5])
    expect(latest.records.map((entry) => entry.seq)).toEqual([8, 9])
  })
})

describe("displayTailReady", () => {
  it("requires owning Turn state and matching cache context before stopping", () => {
    const prompt = userInput(8, "input_latest", "current")
    expect(
      displayTailReady(
        [
          userInput(1, "input_old", "old"),
          userInput(2, "input_other", "other"),
          turnStart(6, "input_latest"),
          prompt,
          record(9, {
            type: "token_count",
            turnId: "input_latest",
            activeContextTokens: 12,
          }),
        ],
        false,
      ),
    ).toBe(false)
    const state = [
      turnContext(1, "input_cached"),
      record(2, {
        type: "turn_completed",
        turnId: "input_cached",
        outcome: "completed",
      }),
      turnStart(6, "input_latest"),
      turnContext(7, "input_latest"),
      prompt,
      record(9, {
        type: "token_count",
        turnId: "input_latest",
        activeContextTokens: 12,
      }),
    ]
    expect(displayTailReady(state.slice(1), false)).toBe(false)
    expect(displayTailReady(state, false)).toBe(true)
    expect(displayTailReady([prompt], true)).toBe(true)
  })
})

describe("readJsonlTail", () => {
  it("stops before a corrupt prefix once the latest prompt is in hand", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-display-window-"))
    roots.push(root)
    const path = join(root, "rollout.jsonl")
    const latest = userInput(9, "input_latest", "current")
    const reply = record(10, {
      type: "token_count",
      turnId: "turn_latest",
      activeContextTokens: 20,
    })
    const padding =
      `${JSON.stringify(userInput(1, "input_old", "old"))}\n`.repeat(2_000)
    const lines = [
      "{not-json",
      padding.trimEnd(),
      JSON.stringify(turnStart(7, "input_latest")),
      JSON.stringify(turnContext(8, "input_latest")),
      JSON.stringify(latest),
      JSON.stringify(reply),
      JSON.stringify(
        record(11, {
          type: "turn_completed",
          turnId: "input_latest",
          outcome: "completed",
        }),
      ),
    ]
    await writeFile(path, `${lines.join("\n")}\n`)
    const parsed: number[] = []
    const tail = await readJsonlTail(path, {
      parse(line) {
        if (line.startsWith("{not-json")) {
          throw new Error("tail read reached the corrupt prefix")
        }
        const value = JSON.parse(line) as StoredRolloutItem
        parsed.push(value.seq)
        return value
      },
      enough: (records, reachedStart) =>
        displayTailReady(records, reachedStart),
    })
    expect(tail.reachedStart).toBe(false)
    expect(parsed.length).toBeGreaterThan(0)
    expect(tail.records.at(-1)?.seq).toBe(11)
    expect(tail.records.some((entry) => entry.seq === 9)).toBe(true)
  })

  it("seeks earlier pages without replaying the newer suffix", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-display-window-"))
    roots.push(root)
    const path = join(root, "rollout.jsonl")
    const rows = Array.from({ length: 2_000 }, (_, index) =>
      userInput(index + 1, `input_${index + 1}`, "多字节".repeat(100)),
    )
    await writeFile(
      path,
      `${rows.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    )
    const parsed: number[] = []
    const tail = await readJsonlTail(path, {
      beforeSeqExclusive: 11,
      parse(line) {
        const value = JSON.parse(line) as StoredRolloutItem
        parsed.push(value.seq)
        return value
      },
      enough: (_records, reachedStart) => reachedStart,
    })
    expect(tail.records.map((entry) => entry.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ])
    expect(tail.records[0]?.item).toEqual(rows[0]?.item)
    expect(tail.endSeq).toBe(2_000)
    // Sequence probes may inspect newer anchors; newer history is not replayed.
    expect(parsed.filter((seq) => seq >= 11).length).toBeLessThan(40)
  })

  it("preserves records spanning chunks while ignoring an incomplete file tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-display-window-"))
    roots.push(root)
    const path = join(root, "rollout.jsonl")
    const rows = [
      userInput(1, "input_first", "你好".repeat(50_000)),
      userInput(2, "input_second", "second"),
    ]
    await writeFile(
      path,
      `${rows.map((entry) => JSON.stringify(entry)).join("\n")}\n{"seq":`,
    )
    const tail = await readJsonlTail(path, {
      parse: (line) => JSON.parse(line) as StoredRolloutItem,
      enough: (_records, reachedStart) => reachedStart,
    })
    expect(tail.records).toEqual(rows)
    expect(tail.endSeq).toBe(2)
  })
})
