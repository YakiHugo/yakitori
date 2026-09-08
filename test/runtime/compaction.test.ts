import { describe, expect, it } from "vitest"
import {
  buildCompactionRequest,
  isContextOverflowError,
  trimRemoteCompactionToolTail,
} from "../../src/runtime/compaction.ts"
import type { ModelMessage } from "../../src/runtime/model.ts"

describe("compaction request", () => {
  it("shrinks only consecutive trailing tool outputs for remote compaction", () => {
    const earlier = {
      role: "tool" as const,
      toolCallId: "older",
      content: "keep earlier output",
    }
    const user = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "keep exact user request" }],
    }
    const trailing = {
      role: "tool" as const,
      toolCallId: "last",
      content: "result".repeat(10_000),
      toolSearch: {
        tools: [
          { name: "large", description: "x".repeat(10_000), inputSchema: {} },
        ],
      },
    }
    const result = trimRemoteCompactionToolTail(
      [earlier, user, trailing],
      "base",
      1,
    )
    expect(result.slice(0, 2)).toEqual([earlier, user])
    expect(result[2]).toEqual({
      ...trailing,
      content: "Tool output omitted to fit the context window.",
      toolSearch: { tools: [] },
    })
    expect(trailing.content).toHaveLength(60_000)
  })
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
            text: expect.stringContaining("checkpoint"),
          },
        ],
      },
    ])
    const instruction = request.messages.at(-1)
    if (instruction?.role !== "user") throw new Error("missing instruction")
    expect(instruction.content[0]?.text).not.toContain("Previous checkpoint")
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
    expect(request.compaction).toBe("local")
  })
})

function sourceTurn(): { messages: readonly ModelMessage[] } {
  return {
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
