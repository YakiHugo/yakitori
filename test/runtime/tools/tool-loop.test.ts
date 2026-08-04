import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createFauxProvider,
  createMateKernel,
  createRuntimeLimits,
  createSessionKernel,
  createSessionRunner,
  createJsonlEventStore,
  createSqliteMateStore,
  createToolRegistry,
  EventType,
  ModelStopReason,
} from "../../../src/index.ts"

describe("tool loop", () => {
  it("reads a file, continues the model, and completes with final text", async () => {
    await withToolRuntime(async (runtime) => {
      await writeFile(join(runtime.workspace, "hello.txt"), "world")
      const provider = createFauxProvider([
        {
          stopReason: ModelStopReason.ToolUse,
          usage: { inputTokens: 10, outputTokens: 2 },
          content: [
            {
              type: "tool_call",
              id: "tool_1",
              name: "read_file",
              input: { path: "hello.txt" },
            },
          ],
        },
        {
          usage: { inputTokens: 20, outputTokens: 5 },
          content: [{ type: "text", text: "I read the file." }],
        },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        toolRegistry: createToolRegistry(),
      })
      const session = await createSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "read hello.txt" },
      })
      await runner.wake(session.sessionId)

      const replayed = await runtime.kernel.replaySession({
        sessionId: session.sessionId,
      })
      expect(replayed.events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          EventType.ToolCall,
          EventType.ToolResult,
          EventType.AssistantMessage,
          EventType.TurnCompleted,
        ]),
      )
      expect(replayed.session?.completedTurns).toHaveLength(1)
      expect(replayed.session?.completedTurns[0]?.usage).toEqual({
        inputTokens: 30,
        outputTokens: 7,
      })
      expect(replayed.session?.usage).toEqual({
        inputTokens: 30,
        outputTokens: 7,
      })
      expect(
        replayed.session?.items.some(
          (item) =>
            item.kind === "assistant_message" &&
            item.content.kind === "text" &&
            item.content.text === "I read the file.",
        ),
      ).toBe(true)
      expect(provider.callCount).toBe(2)
      expect(
        provider.requests[1]?.messages.some(
          (message) => message.role === "tool",
        ),
      ).toBe(true)
    })
  })

  it("executes two tool calls in provider order", async () => {
    await withToolRuntime(async (runtime) => {
      await writeFile(join(runtime.workspace, "a.txt"), "A")
      await writeFile(join(runtime.workspace, "b.txt"), "B")
      const order: string[] = []
      const provider = createFauxProvider([
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_a",
              name: "read_file",
              input: { path: "a.txt" },
            },
            {
              type: "tool_call",
              id: "tool_b",
              name: "read_file",
              input: { path: "b.txt" },
            },
          ],
        },
        {
          assertRequest: (request) => {
            const toolMessages = request.messages.filter(
              (message) => message.role === "tool",
            )
            order.push(
              ...toolMessages.map((message) =>
                message.role === "tool" ? message.toolCallId : "",
              ),
            )
          },
          content: [{ type: "text", text: "done" }],
        },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
      })
      const session = await createSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "read both" },
      })
      await runner.wake(session.sessionId)
      expect(order).toEqual(["tool_a", "tool_b"])
    })
  })

  it("lets a later model call edit a file observed in its context", async () => {
    await withToolRuntime(async (runtime) => {
      await writeFile(join(runtime.workspace, "value.txt"), "value = 1\n")
      const provider = createFauxProvider([
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_read_value",
              name: "read_file",
              input: { path: "value.txt" },
            },
          ],
        },
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_edit_value",
              name: "edit_file",
              input: {
                path: "value.txt",
                oldString: "value = 1",
                newString: "value = 2",
              },
            },
          ],
        },
        { content: [{ type: "text", text: "updated" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
      })
      const session = await createSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "update value.txt" },
      })

      await runner.wake(session.sessionId)

      expect(await readFile(join(runtime.workspace, "value.txt"), "utf8")).toBe(
        "value = 2\n",
      )
      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(read.session?.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            toolCallId: "tool_edit_value",
            state: "completed",
          }),
        ]),
      )
    })
  })

  it("requires read_file between grep and edit_file", async () => {
    await withToolRuntime(async (runtime) => {
      await writeFile(join(runtime.workspace, "grep-only.txt"), "value = 1\n")
      const provider = createFauxProvider([
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_grep_value",
              name: "grep",
              input: {
                pattern: "value = 1",
                path: "grep-only.txt",
                output_mode: "content",
              },
            },
          ],
        },
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_edit_after_grep",
              name: "edit_file",
              input: {
                path: "grep-only.txt",
                oldString: "value = 1",
                newString: "value = 2",
              },
            },
          ],
        },
        { content: [{ type: "text", text: "read required" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
      })
      const session = await createSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "update grep-only.txt" },
      })

      await runner.wake(session.sessionId)

      expect(
        await readFile(join(runtime.workspace, "grep-only.txt"), "utf8"),
      ).toBe("value = 1\n")
      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(read.session?.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            toolCallId: "tool_edit_after_grep",
            state: "failed",
            error: expect.objectContaining({ code: "file_not_observed" }),
          }),
        ]),
      )
    })
  })

  it("derives a whole-file write revision from a later model call's context", async () => {
    await withToolRuntime(async (runtime) => {
      await writeFile(join(runtime.workspace, "replace.txt"), "before\n")
      const provider = createFauxProvider([
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_read_replace",
              name: "read_file",
              input: { path: "replace.txt" },
            },
          ],
        },
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_write_replace",
              name: "write_file",
              input: { path: "replace.txt", content: "after\n" },
            },
          ],
        },
        { content: [{ type: "text", text: "replaced" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
      })
      const session = await createSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "replace the file" },
      })

      await runner.wake(session.sessionId)

      expect(
        await readFile(join(runtime.workspace, "replace.txt"), "utf8"),
      ).toBe("after\n")
    })
  })

  it("does not let a read retroactively authorize an edit from the same model call", async () => {
    await withToolRuntime(async (runtime) => {
      await writeFile(join(runtime.workspace, "same-call.txt"), "value = 1\n")
      const provider = createFauxProvider([
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_same_read",
              name: "read_file",
              input: { path: "same-call.txt" },
            },
            {
              type: "tool_call",
              id: "tool_same_edit",
              name: "edit_file",
              input: {
                path: "same-call.txt",
                oldString: "value = 1",
                newString: "value = 2",
              },
            },
          ],
        },
        {
          assertRequest: (request) => {
            expect(request.messages).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  role: "tool",
                  toolCallId: "tool_same_edit",
                  isError: true,
                  content: expect.stringContaining("file_not_observed"),
                }),
              ]),
            )
          },
          content: [{ type: "text", text: "will retry later" }],
        },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
      })
      const session = await createSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "read and edit immediately" },
      })

      await runner.wake(session.sessionId)

      expect(
        await readFile(join(runtime.workspace, "same-call.txt"), "utf8"),
      ).toBe("value = 1\n")
    })
  })

  it("does not authorize edits from a context-truncated read result", async () => {
    await withToolRuntime(async (runtime) => {
      await writeFile(join(runtime.workspace, "truncated.txt"), "one\ntwo\n")
      const provider = createFauxProvider([
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_truncated_read",
              name: "read_file",
              input: { path: "truncated.txt" },
            },
          ],
        },
        {
          assertRequest: (request) => {
            expect(request.messages).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  role: "tool",
                  toolCallId: "tool_truncated_read",
                  content: expect.stringContaining("...[truncated"),
                }),
              ]),
            )
          },
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_after_truncation",
              name: "edit_file",
              input: {
                path: "truncated.txt",
                oldString: "one",
                newString: "changed",
              },
            },
          ],
        },
        { content: [{ type: "text", text: "handled" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        limits: createRuntimeLimits({ modelVisibleToolResultLines: 1 }),
      })
      const session = await createSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "read then edit" },
      })

      await runner.wake(session.sessionId)

      expect(
        await readFile(join(runtime.workspace, "truncated.txt"), "utf8"),
      ).toBe("one\ntwo\n")
      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(read.session?.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            toolCallId: "tool_after_truncation",
            state: "failed",
            error: expect.objectContaining({ code: "file_not_observed" }),
          }),
        ]),
      )
    })
  })

  it("turns unknown tools into bounded ToolResult errors for the next model call", async () => {
    await withToolRuntime(async (runtime) => {
      const provider = createFauxProvider([
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_x",
              name: "not_a_tool",
              input: {},
            },
          ],
        },
        {
          assertRequest: (request) => {
            const tool = request.messages.find(
              (message) => message.role === "tool",
            )
            expect(tool).toMatchObject({
              role: "tool",
              toolCallId: "tool_x",
              isError: true,
            })
          },
          content: [{ type: "text", text: "handled" }],
        },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
      })
      const session = await createSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "unknown" },
      })
      await runner.wake(session.sessionId)
      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(read.session?.tools[0]?.state).toBe("failed")
      expect(read.session?.completedTurns).toHaveLength(1)
    })
  })

  it("writes through compare-and-write in the tool loop", async () => {
    await withToolRuntime(async (runtime) => {
      const provider = createFauxProvider([
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_w",
              name: "write_file",
              input: {
                path: "out.txt",
                content: "written by tool",
              },
            },
          ],
        },
        { content: [{ type: "text", text: "wrote" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
      })
      const session = await createSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "write" },
      })
      await runner.wake(session.sessionId)
      expect(await readFile(join(runtime.workspace, "out.txt"), "utf8")).toBe(
        "written by tool",
      )
    })
  })

  it("rejects a registered tool that is not enabled for the Turn", async () => {
    await withToolRuntime(async (runtime) => {
      const provider = createFauxProvider([
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_disabled",
              name: "write_file",
              input: {
                path: "disabled.txt",
                content: "must not be written",
              },
            },
          ],
        },
        { content: [{ type: "text", text: "handled" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        enabledTools: [],
      })
      const session = await createSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "write" },
      })

      await runner.wake(session.sessionId)

      await expect(
        readFile(join(runtime.workspace, "disabled.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" })
      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(read.session?.tools[0]).toMatchObject({ state: "failed" })
      expect(read.session?.completedTurns).toHaveLength(1)
    })
  })

  it("enforces the tool budget across every model call in one Turn", async () => {
    await withToolRuntime(async (runtime) => {
      await writeFile(join(runtime.workspace, "a.txt"), "A")
      await writeFile(join(runtime.workspace, "b.txt"), "B")
      const provider = createFauxProvider([
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_a",
              name: "read_file",
              input: { path: "a.txt" },
            },
          ],
        },
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_b",
              name: "read_file",
              input: { path: "b.txt" },
            },
          ],
        },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        limits: createRuntimeLimits({ toolCallsPerTurn: 1 }),
      })
      const session = await createSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "read twice" },
      })

      await runner.wake(session.sessionId)

      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(read.session?.tools).toHaveLength(1)
      expect(read.session?.failedTurns[0]?.error?.code).toBe(
        "tool_budget_exhausted",
      )
    })
  })
})

type ToolRuntime = {
  readonly kernel: ReturnType<typeof createSessionKernel>
  readonly mateKernel: ReturnType<typeof createMateKernel>
  readonly workspace: string
}

async function createSession(runtime: ToolRuntime) {
  const mate = await runtime.mateKernel.createMate({
    instructions: "Use tools carefully.",
    name: "ToolMate",
    role: "Assistant",
  })
  return runtime.kernel.createSession({
    workingDirectory: runtime.workspace,
    mateId: mate.mate.id,
    mateRevisionId: mate.mate.currentRevision.id,
  })
}

async function withToolRuntime(run: (runtime: ToolRuntime) => Promise<void>) {
  const rootDir = await mkdtemp(join(tmpdir(), "yakitori-tool-loop-"))
  const workspace = await mkdtemp(join(tmpdir(), "yakitori-tool-ws-"))
  const eventStore = createJsonlEventStore({
    sessionsDir: join(rootDir, "sessions"),
  })
  const mateStore = createSqliteMateStore({
    databasePath: join(rootDir, "mates.sqlite"),
  })
  try {
    await run({
      kernel: createSessionKernel(eventStore),
      mateKernel: createMateKernel(mateStore),
      workspace,
    })
  } finally {
    mateStore.close()
    await eventStore.close()
    await rm(rootDir, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
}
