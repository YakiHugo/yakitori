import { describe, expect, it } from "vitest"
import type { ResponseItemEnvelope } from "../../src/core/rollout.ts"
import {
  canCompactPrefix,
  createBackgroundCompaction,
} from "../../src/runtime/background-compaction.ts"

const entry = (
  id: string,
  item: ResponseItemEnvelope["item"],
): ResponseItemEnvelope => ({
  id,
  item,
  turnId: "turn",
  createdAt: "2026-10-04T00:00:00.000Z",
})
const call = entry("call", {
  role: "assistant",
  content: [{ type: "tool_call", id: "tool", name: "work", input: {} }],
})
const result = entry("result", {
  role: "tool",
  toolCallId: "tool",
  content: "old output ".repeat(10_000),
})

describe("background checkpoint boundary", () => {
  it("requires a complete tool-call pair and rejects encrypted checkpoints", () => {
    expect(canCompactPrefix([call, result])).toBe(true)
    expect(canCompactPrefix([call])).toBe(false)
    expect(canCompactPrefix([result])).toBe(false)
    expect(canCompactPrefix([call, call, result])).toBe(false)
    expect(
      canCompactPrefix([
        call,
        result,
        entry("opaque", {
          role: "assistant",
          content: [
            {
              type: "compaction",
              provider: "codex",
              model: "model",
              scope: "account",
              encryptedContent: "secret",
            },
          ],
        }),
      ]),
    ).toBe(false)
  })

  it("keeps every user constraint and developer instruction exactly, without foreground retention truncation", () => {
    const user = entry("user", {
      role: "user",
      content: [{ type: "text", text: "constraint ".repeat(9_000) }],
    })
    const developer = entry("developer", {
      role: "developer",
      content: [{ type: "text", text: "never remove this" }],
    })
    const checkpoint = entry("checkpoint", {
      role: "user",
      content: [{ type: "text", text: "summary" }],
    })
    const prefix = [user, developer, call, result]
    const candidate = createBackgroundCompaction({
      prefix,
      checkpoint,
      summary: "summary",
      epoch: "one",
    })
    expect(candidate?.replacement).toEqual([user, developer, checkpoint])
    expect(prefix).toEqual([user, developer, call, result])
    expect(
      createBackgroundCompaction({
        prefix: [user, developer],
        checkpoint,
        summary: "summary",
        epoch: "one",
      }),
    ).toBeUndefined()
  })
})
