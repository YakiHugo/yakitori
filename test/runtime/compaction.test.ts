import { describe, expect, it } from "vitest"
import {
  buildCompactionRequest,
  COMPACTION_SYSTEM_PROMPT,
  isContextOverflowError,
  runCompaction,
  runTwoPassCompaction,
} from "../../src/runtime/compaction.ts"
import {
  type ModelRequest,
  ModelStopReason,
  type ModelStreamEvent,
  type StreamFn,
} from "../../src/runtime/model.ts"
import type { DroppedTurn } from "../../src/runtime/model-context.ts"
import { estimateModelRequestBudget } from "../../src/runtime/model-request-budget.ts"

describe("compaction request", () => {
  it("flattens source groups and appends the checkpoint instruction", () => {
    const request = buildCompactionRequest({
      source: [sourceTurn()],
      target: {
        provider: "faux",
        model: "scripted",
        instructionProfileId: "codex",
        effort: "high",
        speed: "fast",
      },
      baseInstructions: {
        id: "base.instructions",
        revision: "base-1",
        text: "coding agent instructions",
      },
    })

    expect(request.system).toEqual([
      {
        id: "base.instructions",
        revision: "base-1",
        text: "coding agent instructions",
      },
      {
        id: "compaction.instructions",
        revision: "1",
        text: COMPACTION_SYSTEM_PROMPT,
      },
    ])
    expect(request.tools).toEqual([])
    expect(request.target).toEqual({
      provider: "faux",
      model: "scripted",
      instructionProfileId: "codex",
      effort: "high",
      speed: "fast",
    })
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

  it("folds a previous checkpoint from the replacement history", () => {
    const checkpoint = {
      messages: [
        {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: "<context_compacted>Goal: old checkpoint.</context_compacted>",
            },
          ],
        },
      ],
    }
    const request = buildCompactionRequest({
      source: [checkpoint, sourceTurn()],
      target: {
        provider: "faux",
        model: "scripted",
        instructionProfileId: "codex",
      },
      baseInstructions: {
        id: "base.instructions",
        revision: "base-1",
        text: "coding agent instructions",
      },
    })

    const instruction = request.messages.at(-1)
    if (instruction?.role !== "user") throw new Error("missing instruction")
    expect(request.messages).toContainEqual(checkpoint.messages[0])
    expect(instruction.content[0]?.text).toContain("supersede")
  })
})

describe("two-pass compaction", () => {
  it("chooses the largest complete prefix that fits the model capacity", async () => {
    const source = ["first", "second", "third"].map((text) => ({
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: text.repeat(500) }],
        },
      ],
    }))
    const target = {
      provider: "faux",
      model: "scripted",
      instructionProfileId: "codex" as const,
    }
    const baseInstructions = {
      id: "base.instructions",
      revision: "base-1",
      text: "coding agent instructions",
    }
    const capacityTokens = estimateModelRequestBudget(
      buildCompactionRequest({
        source: source.slice(0, 2),
        target,
        baseInstructions,
      }),
    ).requiredContextTokens
    const requests: ModelRequest[] = []

    const result = await runTwoPassCompaction({
      source,
      target,
      baseInstructions,
      capacityTokens,
      async compact(request) {
        requests.push(request)
        return {
          summary: requests.length === 1 ? "NOTE_UNIQUE_CONTENT" : "final",
        }
      },
    })

    expect(result?.summary).toBe("final")
    expect(JSON.stringify(requests[0]?.messages)).toContain("secondsecond")
    expect(JSON.stringify(requests[0]?.messages)).not.toContain("thirdthird")
    expect(JSON.stringify(requests[1]?.messages)).toContain(
      "NOTE_UNIQUE_CONTENT",
    )
    expect(JSON.stringify(requests[1]?.messages)).toContain("thirdthird")
    const finalInstruction = requests[1]?.messages.at(-1)
    if (finalInstruction?.role !== "user") {
      throw new Error("missing final two-pass instruction")
    }
    expect(finalInstruction.content[0]?.text).toContain(
      "preceding <intermediate_compaction>",
    )
    expect(finalInstruction.content[0]?.text).toContain(
      "do not omit the earlier prefix",
    )
    expect(
      JSON.stringify(requests[1]?.messages).match(/NOTE_UNIQUE_CONTENT/g),
    ).toHaveLength(1)
  })

  it("marks a truncated intermediate checkpoint in the final instruction", async () => {
    const requests: ModelRequest[] = []
    await runTwoPassCompaction({
      source: [sourceTurn(), sourceTurn()],
      target: {
        provider: "faux",
        model: "scripted",
        instructionProfileId: "codex",
      },
      baseInstructions: {
        id: "base.instructions",
        revision: "base-1",
        text: "coding agent instructions",
      },
      async compact(request) {
        requests.push(request)
        return { summary: requests.length === 1 ? "x".repeat(13_000) : "final" }
      },
    })

    expect(JSON.stringify(requests[1]?.messages)).toContain(
      "NOTE_1 truncated at the intermediate checkpoint limit",
    )
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
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            cacheReadInputTokens: 8,
            cacheWriteInputTokens: 2,
          },
        },
      }
    }

    const result = await runCompaction({ stream, request: compactionRequest() })
    expect(result).toEqual({
      summary: "Goal: x\nProgress: y",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadInputTokens: 8,
        cacheWriteInputTokens: 2,
      },
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

  it("rejects a checkpoint truncated at the model output limit", async () => {
    const stream: StreamFn = async function* () {
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.Length,
          content: [{ type: "text", text: "Goal: incomplete" }],
        },
      }
    }

    await expect(
      runCompaction({ stream, request: compactionRequest() }),
    ).rejects.toThrow("truncated at the model output limit")
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
    target: {
      provider: "faux",
      model: "scripted",
      instructionProfileId: "compaction",
    },
    system: [{ id: "compaction", revision: "1", text: "sys" }],
    messages: [],
    tools: [],
    ...(signal === undefined ? {} : { signal }),
  }
}

describe("isContextOverflowError", () => {
  it.each([
    "prompt is too long: 250000 tokens > 200000 maximum",
    "This model's maximum context length is 200000 tokens",
    "context_length_exceeded",
    "Request too large for model",
    "HTTP 413",
  ])("recognizes %s", (message) => {
    expect(isContextOverflowError(new Error(message))).toBe(true)
  })

  it.each([
    "summarizer down",
    "HTTP 500",
    "rate limit exceeded",
  ])("rejects %s", (message) => {
    expect(isContextOverflowError(new Error(message))).toBe(false)
  })
})
