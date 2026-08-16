import { describe, expect, it } from "vitest"
import {
  boundCommandContent,
  buildModelContext,
  createMateKernel,
  createSessionKernel,
  ItemKind,
  ItemStatus,
} from "../../src/index.ts"
import { createMemoryEventStore } from "../kernel/memory-event-store.ts"
import { createMemoryMateStore } from "../mates/memory-mate-store.ts"

describe("model context", () => {
  it("includes prior completed history and the current input", async () => {
    const context = await withAttributedSession(
      async ({ kernel, sessionId }) => {
        await completeTextTurn(
          kernel,
          sessionId,
          "first question",
          "first answer",
        )
        const second = await kernel.admitInput({
          sessionId,
          content: { kind: "text", text: "second question" },
        })
        const read = await kernel.readSession({ sessionId })
        if (!read.session) throw new Error("missing session")
        return buildModelContext({
          session: read.session,
          currentInputId: second.inputId,
          limits: generousLimits(),
        })
      },
    )

    expect(context.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "first question" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "first answer" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "second question" }],
      },
    ])
    expect(context.droppedTurnCount).toBe(0)
  })

  it("drops oldest complete Turn groups when caps are exceeded", async () => {
    const context = await withAttributedSession(
      async ({ kernel, sessionId }) => {
        await completeTextTurn(kernel, sessionId, "old question", "old answer")
        await completeTextTurn(kernel, sessionId, "mid question", "mid answer")
        const current = await kernel.admitInput({
          sessionId,
          content: { kind: "text", text: "current" },
        })
        const read = await kernel.readSession({ sessionId })
        if (!read.session) throw new Error("missing session")
        return buildModelContext({
          session: read.session,
          currentInputId: current.inputId,
          limits: {
            modelVisibleMessageBlocks: 3,
            modelVisibleContextBytes: 10_000,
            modelVisibleToolResultBytes: 1_000,
            modelVisibleToolResultLines: 100,
          },
        })
      },
    )

    expect(context.droppedTurnCount).toBeGreaterThan(0)
    expect(context.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "current" }],
    })
    expect(
      context.messages.some(
        (message) =>
          message.role === "user" &&
          message.content[0]?.type === "text" &&
          message.content[0].text === "old question",
      ),
    ).toBe(false)
  })

  it("synthesizes a view-only error for a completed Turn with an open tool", async () => {
    const context = await withAttributedSession(
      async ({ kernel, sessionId }) => {
        const first = await kernel.admitInput({
          sessionId,
          content: { kind: "text", text: "start background work" },
        })
        const turn = await kernel.startTurn({
          sessionId,
          inputId: first.inputId,
        })
        await kernel.recordAssistantOutput({
          sessionId,
          turnId: turn.turnId,
          toolCalls: [
            {
              id: "tool_background",
              name: "background",
              input: {},
              requiresPermission: false,
            },
          ],
        })
        await kernel.completeTurn({ sessionId, turnId: turn.turnId })
        const next = await kernel.admitInput({
          sessionId,
          content: { kind: "text", text: "what happened?" },
        })
        const read = await kernel.readSession({ sessionId })
        if (!read.session) throw new Error("missing session")
        return buildModelContext({
          session: read.session,
          currentInputId: next.inputId,
          limits: generousLimits(),
        })
      },
    )

    expect(context.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "start background work" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "tool_background",
            name: "background",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "tool_background",
        content:
          "No tool result was recorded. Execution status and side effects are unknown. Inspect the current state before retrying.",
        isError: true,
      },
      {
        role: "user",
        content: [{ type: "text", text: "what happened?" }],
      },
    ])
  })

  it.each([
    {
      state: "failed",
      end: async (
        kernel: ReturnType<typeof createSessionKernel>,
        sessionId: string,
        turnId: string,
      ) =>
        kernel.failTurn({
          sessionId,
          turnId,
          error: { message: "provider disconnected", code: "provider_error" },
        }),
      marker: "<turn_failed>",
      detail: "provider disconnected",
    },
    {
      state: "cancelled",
      end: async (
        kernel: ReturnType<typeof createSessionKernel>,
        sessionId: string,
        turnId: string,
      ) => kernel.cancelTurn({ sessionId, turnId, reason: "user stopped" }),
      marker: "<turn_cancelled>",
      detail: "user stopped",
    },
    {
      state: "interrupted",
      end: async (
        kernel: ReturnType<typeof createSessionKernel>,
        sessionId: string,
        turnId: string,
      ) =>
        kernel.interruptTurn({
          sessionId,
          turnId,
          reason: "runtime disappeared",
        }),
      marker: "<turn_interrupted>",
      detail: "runtime disappeared",
    },
  ])("keeps $state Turn history model-visible", async ({
    end,
    marker,
    detail,
  }) => {
    const context = await withAttributedSession(
      async ({ kernel, sessionId }) => {
        const admitted = await kernel.admitInput({
          sessionId,
          content: { kind: "text", text: "do the work" },
        })
        const turn = await kernel.startTurn({
          sessionId,
          inputId: admitted.inputId,
        })
        await kernel.recordAssistantOutput({
          sessionId,
          turnId: turn.turnId,
          content: [{ type: "text", text: "partial answer" }],
          toolCalls: [],
        })
        await end(kernel, sessionId, turn.turnId)
        const next = await kernel.admitInput({
          sessionId,
          content: { kind: "text", text: "continue" },
        })
        const read = await kernel.readSession({ sessionId })
        if (!read.session) throw new Error("missing session")
        return buildModelContext({
          session: read.session,
          currentInputId: next.inputId,
          limits: generousLimits(),
        })
      },
    )

    expect(context.messages.slice(0, 2)).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "do the work" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "partial answer" }],
      },
    ])
    const notice = context.messages.at(-2)
    expect(notice?.role).toBe("user")
    if (notice?.role !== "user") throw new Error("missing terminal notice")
    expect(notice.content[0]?.text).toContain(marker)
    expect(notice.content[0]?.text).toContain(detail)
  })

  it("never returns a current Turn context above the hard cap", async () => {
    await withAttributedSession(async ({ kernel, sessionId }) => {
      const current = await kernel.admitInput({
        sessionId,
        content: { kind: "text", text: "x".repeat(1_000) },
      })
      const read = await kernel.readSession({ sessionId })
      if (!read.session) throw new Error("missing session")
      const session = read.session

      expect(() =>
        buildModelContext({
          session,
          currentInputId: current.inputId,
          limits: {
            ...generousLimits(),
            modelVisibleContextBytes: 100,
          },
        }),
      ).toThrow("exceeds the configured hard cap")
    })
  })

  it("replaces covered Turns with the compaction checkpoint", async () => {
    const context = await withAttributedSession(
      async ({ kernel, sessionId }) => {
        const firstTurnId = await completeTextTurn(
          kernel,
          sessionId,
          "old question",
          "old answer",
        )
        const secondTurnId = await completeTextTurn(
          kernel,
          sessionId,
          "mid question",
          "mid answer",
        )
        const current = await admitAndStartTurn(kernel, sessionId, "current")
        await kernel.recordCompaction({
          sessionId,
          turnId: current.turnId,
          throughSeq: 1,
          coveredTurnIds: [firstTurnId, secondTurnId],
          summary: "Goal: answer questions.",
        })
        const read = await kernel.readSession({ sessionId })
        if (!read.session) throw new Error("missing session")
        return buildModelContext({
          session: read.session,
          currentInputId: current.inputId,
          limits: generousLimits(),
        })
      },
    )

    expect(context.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<context_compacted>\nEarlier turns in this session were summarized into this checkpoint. The complete history is preserved on disk.\nGoal: answer questions.\n</context_compacted>",
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "current" }],
      },
    ])
    expect(context.droppedTurnCount).toBe(0)
    expect(context.droppedTurns).toEqual([])
  })

  it("drops the compaction checkpoint last-resort when still over cap", async () => {
    const context = await withAttributedSession(
      async ({ kernel, sessionId }) => {
        const firstTurnId = await completeTextTurn(
          kernel,
          sessionId,
          "old question",
          "old answer",
        )
        const current = await admitAndStartTurn(kernel, sessionId, "current")
        await kernel.recordCompaction({
          sessionId,
          turnId: current.turnId,
          throughSeq: 1,
          coveredTurnIds: [firstTurnId],
          summary: "Goal: answer questions.",
        })
        const read = await kernel.readSession({ sessionId })
        if (!read.session) throw new Error("missing session")
        return buildModelContext({
          session: read.session,
          currentInputId: current.inputId,
          limits: {
            ...generousLimits(),
            modelVisibleMessageBlocks: 1,
          },
        })
      },
    )

    expect(context.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "current" }],
      },
    ])
    expect(context.droppedTurnCount).toBe(0)
    expect(context.droppedTurns).toEqual([])
    expect(context.droppedCompactionCheckpoint).toBe(true)
  })

  it("returns dropped Turns with tool-result truncation applied", async () => {
    const { context, droppedTurnId } = await withAttributedSession(
      async ({ kernel, sessionId }) => {
        const coveredTurnId = await completeTextTurn(
          kernel,
          sessionId,
          "covered question",
          "covered answer",
        )
        const admitted = await kernel.admitInput({
          sessionId,
          content: { kind: "text", text: "use a tool" },
        })
        const toolTurn = await kernel.startTurn({
          sessionId,
          inputId: admitted.inputId,
        })
        await kernel.recordAssistantOutput({
          sessionId,
          turnId: toolTurn.turnId,
          toolCalls: [
            {
              id: "tool_long",
              name: "run_command",
              input: { command: "seq" },
              requiresPermission: false,
            },
          ],
        })
        await kernel.recordToolResult({
          sessionId,
          turnId: toolTurn.turnId,
          toolCallId: "tool_long",
          content: {
            kind: "text",
            text: Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"),
          },
        })
        await kernel.completeTurn({ sessionId, turnId: toolTurn.turnId })
        const current = await admitAndStartTurn(kernel, sessionId, "current")
        await kernel.recordCompaction({
          sessionId,
          turnId: current.turnId,
          throughSeq: 1,
          coveredTurnIds: [coveredTurnId],
          summary: "checkpoint",
        })
        const read = await kernel.readSession({ sessionId })
        if (!read.session) throw new Error("missing session")
        const context = buildModelContext({
          session: read.session,
          currentInputId: current.inputId,
          limits: {
            modelVisibleMessageBlocks: 2,
            modelVisibleContextBytes: 100_000,
            modelVisibleToolResultBytes: 10_000,
            modelVisibleToolResultLines: 5,
          },
        })
        return { context, droppedTurnId: toolTurn.turnId }
      },
    )

    // The tool Turn drops first; the pinned checkpoint survives next to the
    // current input. The dropped Turn is reported with truncation applied.
    expect(context.droppedTurnCount).toBe(1)
    expect(context.droppedCompactionCheckpoint).toBe(false)
    expect(context.droppedTurns).toEqual([
      {
        turnId: droppedTurnId,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "use a tool" }],
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool_call",
                id: "tool_long",
                name: "run_command",
                input: { command: "seq" },
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "tool_long",
            content:
              "line 0\nline 1\nline 2\nline 3\nline 4\n...[truncated 45 lines]",
          },
        ],
      },
    ])
    expect(context.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<context_compacted>\nEarlier turns in this session were summarized into this checkpoint. The complete history is preserved on disk.\ncheckpoint\n</context_compacted>",
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "current" }],
      },
    ])
  })

  it("shows one body for duplicate self-contained read results", async () => {
    const { context, firstResultItemId } = await withAttributedSession(
      async ({ kernel, sessionId }) => {
        const active = await admitAndStartTurn(kernel, sessionId, "read twice")
        const calls = ["tool_read_first", "tool_read_second"]
        await kernel.recordAssistantOutput({
          sessionId,
          turnId: active.turnId,
          toolCalls: calls.map((id) => ({
            id,
            name: "read_file",
            input: { path: "src/value.ts", offset: 1, limit: 2 },
            requiresPermission: false,
          })),
        })
        let firstResultItemId = ""
        for (const toolCallId of calls) {
          await kernel.requireToolExecutionAllowed({
            sessionId,
            turnId: active.turnId,
            toolCallId,
          })
          const result = await kernel.recordToolResult({
            sessionId,
            turnId: active.turnId,
            toolCallId,
            content: { kind: "text", text: "1\talpha\n2\tbeta" },
            output: {
              path: "src/value.ts",
              sha256: "a".repeat(64),
              lineCharacterLimit: 2_000,
              range: { offset: 1, limit: 2, requestedLimit: 2 },
              content: "1\talpha\n2\tbeta",
            },
          })
          if (firstResultItemId.length === 0) {
            firstResultItemId = result.itemId
          }
        }
        const read = await kernel.readSession({ sessionId })
        if (!read.session) throw new Error("missing session")
        return {
          context: buildModelContext({
            session: read.session,
            currentInputId: active.inputId,
            limits: generousLimits(),
          }),
          firstResultItemId,
        }
      },
    )

    const results = context.messages.filter(
      (message) => message.role === "tool",
    )
    expect(results).toEqual([
      {
        role: "tool",
        toolCallId: "tool_read_first",
        content: "1\talpha\n2\tbeta",
      },
      {
        role: "tool",
        toolCallId: "tool_read_second",
        content: "Duplicate read; same content as tool call tool_read_first.",
      },
    ])
    expect(context.observationEligibleToolResultItemIds).toEqual([
      firstResultItemId,
    ])
  })

  it("does not mark a context-truncated tool result as fully visible", async () => {
    const { context, resultItemId } = await withAttributedSession(
      async ({ kernel, sessionId }) => {
        const active = await admitAndStartTurn(kernel, sessionId, "read file")
        await kernel.recordAssistantOutput({
          sessionId,
          turnId: active.turnId,
          toolCalls: [
            {
              id: "tool_read_truncated",
              name: "read_file",
              input: { path: "src/value.ts" },
              requiresPermission: false,
            },
          ],
        })
        await kernel.requireToolExecutionAllowed({
          sessionId,
          turnId: active.turnId,
          toolCallId: "tool_read_truncated",
        })
        const result = await kernel.recordToolResult({
          sessionId,
          turnId: active.turnId,
          toolCallId: "tool_read_truncated",
          content: { kind: "text", text: "1\talpha\n2\tbeta" },
          output: {
            path: "src/value.ts",
            sha256: "a".repeat(64),
            range: { offset: 1, limit: 2, requestedLimit: 2 },
            content: "1\talpha\n2\tbeta",
          },
        })
        const read = await kernel.readSession({ sessionId })
        if (!read.session) throw new Error("missing session")
        return {
          context: buildModelContext({
            session: read.session,
            currentInputId: active.inputId,
            limits: {
              ...generousLimits(),
              modelVisibleToolResultLines: 1,
            },
          }),
          resultItemId: result.itemId,
        }
      },
    )

    expect(context.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          toolCallId: "tool_read_truncated",
          content: "1\talpha\n...[truncated 1 lines]",
        }),
      ]),
    )
    expect(context.selectedItemIds).toContain(resultItemId)
    expect(context.observationEligibleToolResultItemIds).not.toContain(
      resultItemId,
    )
  })

  it("keeps the run_command tail after generic context truncation", async () => {
    const context = await withAttributedSession(
      async ({ kernel, sessionId }) => {
        const active = await admitAndStartTurn(kernel, sessionId, "run tests")
        await kernel.recordAssistantOutput({
          sessionId,
          turnId: active.turnId,
          toolCalls: [
            {
              id: "tool_command_tail",
              name: "run_command",
              input: { command: "long-output" },
              requiresPermission: false,
            },
          ],
        })
        const content = boundCommandContent(
          `${Array.from({ length: 3_000 }, (_, index) => `line-${index}`).join("\n")}\n(exit 1, 4.1s)`,
        )
        await kernel.recordToolResult({
          sessionId,
          turnId: active.turnId,
          toolCallId: "tool_command_tail",
          content: { kind: "text", text: content },
        })
        const read = await kernel.readSession({ sessionId })
        if (!read.session) throw new Error("missing session")
        return buildModelContext({
          session: read.session,
          currentInputId: active.inputId,
          limits: {
            ...generousLimits(),
            modelVisibleToolResultBytes: 50 * 1024,
          },
        })
      },
    )

    const result = context.messages.find(
      (message) =>
        message.role === "tool" && message.toolCallId === "tool_command_tail",
    )
    expect(result).toMatchObject({ role: "tool" })
    if (result?.role !== "tool") throw new Error("missing command result")
    expect(result.content).toContain("line-2999")
    expect(result.content).toContain("(exit 1, 4.1s)")
    expect(result.content).toContain("cmd > out.log 2>&1")
    expect(context.truncatedToolResultCount).toBe(0)
  })
})

function generousLimits() {
  return {
    modelVisibleMessageBlocks: 200,
    modelVisibleContextBytes: 256_000,
    modelVisibleToolResultBytes: 50_000,
    modelVisibleToolResultLines: 2_000,
  }
}

async function completeTextTurn(
  kernel: ReturnType<typeof createSessionKernel>,
  sessionId: string,
  userText: string,
  assistantText: string,
): Promise<string> {
  const admitted = await kernel.admitInput({
    sessionId,
    content: { kind: "text", text: userText },
  })
  const started = await kernel.startTurn({
    sessionId,
    inputId: admitted.inputId,
    executionContext: {
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
      provider: "faux",
      model: "scripted",
      workingDirectory: "/tmp",
      enabledTools: [],
      approvalPolicy: "auto_file_tools",
      limits: {
        modelCallsPerTurn: 16,
        toolCallsPerTurn: 32,
        modelVisibleMessageBlocks: 200,
        modelVisibleContextBytes: 256_000,
        modelVisibleToolResultBytes: 50_000,
        modelVisibleToolResultLines: 2_000,
        assistantResponseBytes: 256_000,
      },
    },
  })
  await kernel.completeTurnWithAssistantOutput({
    sessionId,
    turnId: started.turnId,
    content: { kind: "text", text: assistantText },
    providerMetadata: {
      streamId: "stream_test",
      kind: ItemKind.AssistantMessage,
      status: ItemStatus.Completed,
    },
  })
  return started.turnId
}

async function admitAndStartTurn(
  kernel: ReturnType<typeof createSessionKernel>,
  sessionId: string,
  userText: string,
): Promise<{ readonly inputId: string; readonly turnId: string }> {
  const admitted = await kernel.admitInput({
    sessionId,
    content: { kind: "text", text: userText },
  })
  const started = await kernel.startTurn({
    sessionId,
    inputId: admitted.inputId,
  })
  return { inputId: admitted.inputId, turnId: started.turnId }
}

async function withAttributedSession<T>(
  run: (input: {
    readonly kernel: ReturnType<typeof createSessionKernel>
    readonly sessionId: string
  }) => Promise<T>,
): Promise<T> {
  const kernel = createSessionKernel(createMemoryEventStore())
  const mateKernel = createMateKernel(createMemoryMateStore())
  const mate = await mateKernel.createMate({
    instructions: "test",
    name: "Test",
    role: "Tester",
  })
  const session = await kernel.createSession({
    workingDirectory: "/tmp",
    mateId: mate.mate.id,
    mateRevisionId: mate.mate.currentRevision.id,
  })
  return run({ kernel, sessionId: session.sessionId })
}
