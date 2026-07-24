import { describe, expect, it } from "vitest"
import {
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
): Promise<void> {
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
