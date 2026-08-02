import { describe, expect, it } from "vitest"
import {
  buildCompactionRequest,
  COMPACTION_SYSTEM_PROMPT,
  type DroppedTurn,
  type ModelRequest,
  type ModelStreamEvent,
  ModelStopReason,
  runCompaction,
  type StreamFn,
} from "../../src/index.ts"

describe("compaction request", () => {
  it("flattens source groups and appends the checkpoint instruction", () => {
    const request = buildCompactionRequest({
      source: [sourceTurn()],
      provider: "faux",
      model: "scripted",
    })

    expect(request.system).toBe(COMPACTION_SYSTEM_PROMPT)
    expect(request.tools).toEqual([])
    expect(request.provider).toBe("faux")
    expect(request.model).toBe("scripted")
    expect(request.messages).toEqual([
      ...sourceTurn().messages,
      {
        role: "user",
        content: [
          {
            type: "text",
            text: expect.stringContaining("Write the checkpoint"),
          },
        ],
      },
    ])
    const instruction = request.messages.at(-1)
    if (instruction?.role !== "user") throw new Error("missing instruction")
    expect(instruction.content[0]?.text).not.toContain("Previous checkpoint")
  })

  it("requires the fixed checkpoint sections in the system prompt", () => {
    for (const section of [
      "Goal",
      "Progress",
      "Files",
      "Errors",
      "Next steps",
    ]) {
      expect(COMPACTION_SYSTEM_PROMPT).toContain(section)
    }
  })

  it("folds a previous checkpoint into the instruction", () => {
    const request = buildCompactionRequest({
      source: [sourceTurn()],
      previousSummary: "Goal: old checkpoint.",
      provider: "faux",
      model: "scripted",
    })

    const instruction = request.messages.at(-1)
    if (instruction?.role !== "user") throw new Error("missing instruction")
    expect(instruction.content[0]?.text).toContain(
      "Previous checkpoint:\nGoal: old checkpoint.",
    )
    expect(instruction.content[0]?.text).toContain("supersede")
  })
})

describe("runCompaction", () => {
  it("returns the checkpoint text and usage, ignoring snapshots", async () => {
    const stream: StreamFn = async function* () {
      yield { type: "snapshot", text: "Goal" }
      yield { type: "snapshot", text: "Goal: x" }
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "Goal: x\nProgress: y" }],
          usage: { inputTokens: 10, outputTokens: 4 },
        },
      }
    }

    const result = await runCompaction({ stream, request: compactionRequest() })
    expect(result).toEqual({
      summary: "Goal: x\nProgress: y",
      usage: { inputTokens: 10, outputTokens: 4 },
    })
  })

  it("throws on an error stop reason", async () => {
    const stream: StreamFn = async function* () {
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.Error,
          content: [],
          error: { code: "rate_limit", message: "slow down" },
        },
      }
    }

    await expect(
      runCompaction({ stream, request: compactionRequest() }),
    ).rejects.toThrow("slow down")
  })

  it("throws an AbortError when the stream aborts", async () => {
    const signal = AbortSignal.abort()
    const stream: StreamFn = async function* () {
      yield {
        type: "response",
        response: { stopReason: ModelStopReason.Aborted, content: [] },
      }
    }

    await expect(
      runCompaction({ stream, request: compactionRequest(signal) }),
    ).rejects.toMatchObject({ name: "AbortError" })
  })

  it("throws an AbortError when the stream throws one", async () => {
    const stream: StreamFn = () => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<ModelStreamEvent>> {
            const error = new Error("aborted")
            error.name = "AbortError"
            throw error
          },
        }
      },
    })

    await expect(
      runCompaction({ stream, request: compactionRequest() }),
    ).rejects.toMatchObject({ name: "AbortError" })
  })

  it("throws on an empty checkpoint", async () => {
    const stream: StreamFn = async function* () {
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "  \n" }],
        },
      }
    }

    await expect(
      runCompaction({ stream, request: compactionRequest() }),
    ).rejects.toThrow("empty checkpoint")
  })

  it("throws when the stream ends without a terminal response", async () => {
    const stream: StreamFn = async function* () {
      yield { type: "snapshot", text: "partial" }
    }

    await expect(
      runCompaction({ stream, request: compactionRequest() }),
    ).rejects.toThrow("without a terminal response")
  })

  it("throws on a second terminal response", async () => {
    const terminal: ModelStreamEvent = {
      type: "response",
      response: {
        stopReason: ModelStopReason.EndTurn,
        content: [{ type: "text", text: "Goal: x" }],
      },
    }
    const stream: StreamFn = async function* () {
      yield terminal
      yield terminal
    }

    await expect(
      runCompaction({ stream, request: compactionRequest() }),
    ).rejects.toThrow("more than one terminal response")
  })
})

function sourceTurn(): DroppedTurn {
  return {
    turnId: "turn_1",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "first question" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "first answer" }],
      },
    ],
  }
}

function compactionRequest(signal?: AbortSignal): ModelRequest {
  return {
    system: "sys",
    messages: [],
    tools: [],
    provider: "faux",
    model: "scripted",
    ...(signal === undefined ? {} : { signal }),
  }
}
