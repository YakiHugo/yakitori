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
  createSqliteEventStore,
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
                expectedSha256: null,
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
                expectedSha256: null,
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
  const eventStore = createSqliteEventStore({ rootDir })
  const mateStore = createSqliteMateStore({
    databasePath: join(rootDir, "events.sqlite"),
  })
  try {
    await run({
      kernel: createSessionKernel(eventStore),
      mateKernel: createMateKernel(mateStore),
      workspace,
    })
  } finally {
    mateStore.close()
    eventStore.close()
    await rm(rootDir, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
}
