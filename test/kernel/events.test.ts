import { describe, expect, it } from "vitest"
import {
  createEventEnvelope,
  EventType,
  InputRole,
  isKernelEvent,
} from "../../src/index.ts"

describe("kernel facts", () => {
  it("contains exactly the coarse witness vocabulary", () => {
    expect(Object.values(EventType)).toEqual([
      "session.created",
      "input.admitted",
      "input.cancelled",
      "turn.started",
      "turn.completed",
      "turn.failed",
      "turn.cancelled",
      "turn.interrupted",
      "assistant.message",
      "tool.call",
      "tool.result",
      "permission.requested",
      "permission.resolved",
      "context.compacted",
    ])
  })

  it("creates a versioned envelope for a valid fact", () => {
    const envelope = createEventEnvelope({
      sessionId: "session_00000000-0000-4000-8000-000000000000",
      seq: 1,
      event: { type: EventType.SessionCreated, data: { title: "Witness" } },
    })

    expect(envelope).toMatchObject({
      sessionId: "session_00000000-0000-4000-8000-000000000000",
      seq: 1,
      version: 1,
      type: EventType.SessionCreated,
      data: { title: "Witness" },
    })
  })

  it("strictly rejects malformed known facts at write time", () => {
    expect(() =>
      createEventEnvelope({
        sessionId: "session_00000000-0000-4000-8000-000000000000",
        seq: 1,
        event: {
          type: EventType.InputAdmitted,
          data: {
            requestId: "request-1",
            inputId: "input_1",
            role: InputRole.User,
            content: { kind: "text", text: "hello" },
            extra: true,
          },
        } as never,
      }),
    ).toThrow("Invalid event data")
  })

  it("accepts modelSelection and rejects malformed ones", () => {
    const admitted = (modelSelection: unknown) =>
      isKernelEvent({
        type: EventType.InputAdmitted,
        data: {
          requestId: "request-1",
          inputId: "input_1",
          role: InputRole.User,
          content: { kind: "text", text: "hello" },
          modelSelection,
        },
      })

    expect(admitted({ provider: "openai", model: "gpt-5.1-codex" })).toBe(true)
    expect(admitted({ provider: "openai", model: "" })).toBe(false)
    expect(admitted({ provider: "", model: "gpt-5.1-codex" })).toBe(false)
    expect(
      admitted({ provider: "openai", model: "gpt-5.1-codex", extra: true }),
    ).toBe(false)
  })

  it("accepts turn.started execution contexts with or without promptId", () => {
    const started = (executionContext: Record<string, unknown>) =>
      isKernelEvent({
        type: EventType.TurnStarted,
        data: {
          turnId: "turn_1",
          inputId: "input_1",
          executionContext: {
            mateId: "mate_1",
            mateRevisionId: "revision_1",
            provider: "openai",
            model: "gpt-5.1-codex",
            workingDirectory: "/p/a",
            enabledTools: [],
            approvalPolicy: "on-request",
            limits: {
              modelCallsPerTurn: 1,
              toolCallsPerTurn: 1,
              modelVisibleMessageBlocks: 1,
              modelVisibleContextBytes: 1,
              modelVisibleToolResultBytes: 1,
              modelVisibleToolResultLines: 1,
              assistantResponseBytes: 1,
            },
            ...executionContext,
          },
        },
      })

    // Facts written before prompt attribution existed must still validate.
    expect(started({})).toBe(true)
    expect(started({ promptId: "gpt" })).toBe(true)
    expect(started({ promptId: 1 })).toBe(false)
  })

  it("recognizes valid tool facts", () => {
    expect(
      isKernelEvent({
        type: EventType.ToolCall,
        data: {
          toolCallId: "tool_1",
          itemId: "item_1",
          turnId: "turn_1",
          name: "read_file",
          input: { path: "README.md" },
          requiresPermission: false,
        },
      }),
    ).toBe(true)
  })

  it("recognizes a valid context.compacted fact", () => {
    expect(
      isKernelEvent({
        type: EventType.ContextCompacted,
        data: {
          compactionId: "compaction_1",
          turnId: "turn_1",
          throughSeq: 7,
          coveredTurnIds: ["turn_0"],
          summary: "Goal: ship it.",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      }),
    ).toBe(true)
  })

  it.each([
    {
      name: "an extra key",
      data: {
        compactionId: "compaction_1",
        turnId: "turn_1",
        throughSeq: 7,
        coveredTurnIds: ["turn_0"],
        summary: "Goal: ship it.",
        model: "faux-1",
      },
    },
    {
      name: "a missing key",
      data: {
        compactionId: "compaction_1",
        turnId: "turn_1",
        coveredTurnIds: ["turn_0"],
        summary: "Goal: ship it.",
      },
    },
    {
      name: "throughSeq of zero",
      data: {
        compactionId: "compaction_1",
        turnId: "turn_1",
        throughSeq: 0,
        coveredTurnIds: ["turn_0"],
        summary: "Goal: ship it.",
      },
    },
    {
      name: "a non-string covered turn id",
      data: {
        compactionId: "compaction_1",
        turnId: "turn_1",
        throughSeq: 7,
        coveredTurnIds: ["turn_0", 42],
        summary: "Goal: ship it.",
      },
    },
  ])("rejects context.compacted with $name", ({ data }) => {
    expect(
      isKernelEvent({
        type: EventType.ContextCompacted,
        data,
      }),
    ).toBe(false)
  })
})
