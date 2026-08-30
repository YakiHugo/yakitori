import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { SessionEvent } from "../../src/core/session-io.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createFauxProvider } from "../../src/runtime/faux-provider.ts"
import { createSessionExecutionPolicy } from "../../src/runtime/limits.ts"
import type { ModelStreamEvent, StreamFn } from "../../src/runtime/model.ts"
import { ModelStopReason } from "../../src/runtime/model.ts"
import { createPermissionGate } from "../../src/runtime/permission-gate.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import {
  createTurnProcessor,
  type TurnProcessorOptions,
} from "../../src/runtime/turn-processor.ts"
import { MemoryThreadStore } from "../core/memory-thread-store.ts"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe("Turn processor", () => {
  it("runs against actor-owned context and persists usage with the terminal Turn", async () => {
    const provider = createFauxProvider([
      {
        assertRequest(request) {
          expect(request.system).toHaveLength(1)
        },
        content: [
          { type: "reasoning", text: "Think", providerMetadata: { id: "r" } },
          { type: "text", text: "Hello" },
        ],
        usage: { inputTokens: 12, outputTokens: 3 },
      },
    ])
    const runtime = await createRuntime(provider.stream)
    const thread = await runtime.createThread()

    await expect(
      thread.startIfIdle({ content: { kind: "text", text: "hi" } }),
    ).resolves.toMatchObject({ type: "started" })
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.started")
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.completed")

    expect(
      thread.snapshot().context.history.map((item) => item.item.role),
    ).toEqual(["user", "user", "assistant"])
    expect(thread.snapshot().configuration?.defaultTarget).toEqual({
      provider: "faux",
      model: "scripted",
    })
    const stored = await runtime.store.readThread(thread.id)
    expect(
      stored?.rollout.find(
        (entry) =>
          entry.item.type === "turn_completed" &&
          entry.item.outcome === "completed",
      )?.item,
    ).toMatchObject({
      usage: { inputTokens: 12, outputTokens: 3 },
    })
    expect(
      stored?.rollout.flatMap((entry) =>
        entry.item.type === "item_completed" ? [entry.item.item.type] : [],
      ),
    ).toEqual(["reasoning", "agent_message"])
  })

  it("records assistant tool calls and tool results before the next model call", async () => {
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "tool_echo",
            name: "echo",
            input: { text: "hello" },
          },
        ],
      },
      {
        assertRequest(request) {
          expect(
            request.messages.slice(-2).map((message) => message.role),
          ).toEqual(["assistant", "tool"])
        },
        content: [{ type: "text", text: "done" }],
      },
    ])
    const tools = createToolRegistry([
      {
        name: "echo",
        description: "Echo text",
        inputSchema: { type: "object" },
        effect: "observe",
        approvalRequirement: { kind: "none" },
        async execute(value) {
          return { ok: true, output: value as never, content: "hello" }
        },
      },
    ])
    const runtime = await createRuntime(provider.stream, tools)
    const thread = await runtime.createThread()

    await thread.startIfIdle({ content: { kind: "text", text: "use echo" } })
    await nextLifecycleEvent(thread)
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.completed")
    expect(provider.callCount).toBe(2)
    expect(
      thread.snapshot().context.history.map((item) => item.item.role),
    ).toEqual(["user", "user", "assistant", "tool", "assistant"])
    const rollout = (await runtime.store.readThread(thread.id))?.rollout ?? []
    expect(
      rollout.flatMap((entry) =>
        entry.item.type === "item_completed" ? [entry.item.item.type] : [],
      ),
    ).toEqual(["dynamic_tool_call", "agent_message"])
    expect(rollout.map((entry) => String(entry.item.type))).not.toContain(
      "item_started",
    )
  })

  it("passes the physical rollout ID to tool asset storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-rollout-identity-"))
    const store = new MemoryThreadStore()
    const threadId = "session_logical"
    const rolloutId = "rollout_physical"
    const now = new Date().toISOString()
    await store.createThread({
      id: threadId,
      conversationId: threadId,
      createdAt: now,
      updatedAt: now,
      workingDirectory: root,
      mateId: "mate_live",
      mateRevisionId: "mate_revision_live",
    })
    await store.shutdownThread(threadId)
    store.reidentifyRollout(threadId, rolloutId)

    let toolRolloutId: string | undefined
    const tools = createToolRegistry([
      {
        name: "capture_rollout",
        description: "Capture the rollout asset owner.",
        inputSchema: { type: "object" },
        effect: "observe",
        approvalRequirement: { kind: "none" },
        async execute(_value, context) {
          toolRolloutId = context.rolloutId
          return { ok: true, output: {}, content: "captured" }
        },
      },
    ])
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "tool_capture_rollout",
            name: "capture_rollout",
            input: {},
          },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ])
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: provider.stream,
          toolRegistry: tools,
          loadProjectInstructions: async () => undefined,
        }),
    })
    cleanups.push(async () => {
      await manager.shutdown()
      await rm(root, { recursive: true, force: true })
    })

    const thread = await manager.resumeThread(threadId)
    if (thread === undefined) throw new Error("Thread was not resumed.")
    await thread.startIfIdle({ content: { kind: "text", text: "capture" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)

    expect(toolRolloutId).toBe(rolloutId)
  })

  it("persists a visible read so a later model call can edit the file", async () => {
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
      { content: [{ type: "text", text: "done" }] },
    ])
    const runtime = await createRuntime(provider.stream, createToolRegistry())
    const thread = await runtime.createThread()
    const path = join(runtime.root, "value.txt")
    await writeFile(path, "value = 1\n")

    await thread.startIfIdle({ content: { kind: "text", text: "update" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)

    expect(await readFile(path, "utf8")).toBe("value = 2\n")
    expect(
      thread
        .snapshot()
        .context.history.find(
          (item) =>
            item.item.role === "tool" &&
            item.item.toolCallId === "tool_read_value",
        )?.item,
    ).toMatchObject({
      fileObservation: {
        path: "value.txt",
        kind: "whole_file_read",
        complete: true,
      },
    })
    const completedItems =
      (await runtime.store.readThread(thread.id))?.rollout.flatMap((entry) =>
        entry.item.type === "item_completed" ? [entry.item.item] : [],
      ) ?? []
    expect(
      completedItems.find(
        (item) => "toolCallId" in item && item.toolCallId === "tool_read_value",
      ),
    ).toMatchObject({
      type: "file_read",
      result: { path: "value.txt", kind: "file" },
    })
    expect(
      completedItems.find(
        (item) => "toolCallId" in item && item.toolCallId === "tool_edit_value",
      ),
    ).toMatchObject({
      type: "file_change",
      changes: [{ path: "value.txt", kind: "update" }],
    })
  })

  it("restores file observations after resume and rejects a stale edit", async () => {
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "tool_read_before_resume",
            name: "read_file",
            input: { path: "resume.txt" },
          },
        ],
      },
      { content: [{ type: "text", text: "read" }] },
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "tool_stale_edit",
            name: "edit_file",
            input: {
              path: "resume.txt",
              oldString: "before",
              newString: "after",
            },
          },
        ],
      },
      {
        assertRequest(request) {
          expect(request.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                role: "tool",
                toolCallId: "tool_stale_edit",
                isError: true,
                content: expect.stringContaining(
                  "file_changed_since_observation",
                ),
              }),
            ]),
          )
        },
        content: [{ type: "text", text: "stale" }],
      },
    ])
    const tools = createToolRegistry()
    const runtime = await createRuntime(provider.stream, tools)
    const thread = await runtime.createThread()
    const path = join(runtime.root, "resume.txt")
    await writeFile(path, "before\n")
    await thread.startIfIdle({ content: { kind: "text", text: "read" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    await runtime.manager.shutdown()
    await writeFile(path, "changed externally\n")

    const resumedManager = new ThreadManager({
      store: runtime.store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: provider.stream,
          toolRegistry: tools,
          loadProjectInstructions: async () => undefined,
        }),
    })
    cleanups.push(() => resumedManager.shutdown())
    const resumed = await resumedManager.resumeThread(thread.id)
    if (resumed === undefined) throw new Error("Thread was not resumed.")
    await resumed.startIfIdle({ content: { kind: "text", text: "edit" } })
    await nextLifecycleEvent(resumed)
    await nextLifecycleEvent(resumed)

    expect(await readFile(path, "utf8")).toBe("changed externally\n")
  })

  it("does not let a read authorize an edit from the same model call", async () => {
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
              oldString: "one",
              newString: "two",
            },
          },
        ],
      },
      {
        assertRequest(request) {
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
        content: [{ type: "text", text: "done" }],
      },
    ])
    const runtime = await createRuntime(provider.stream, createToolRegistry())
    const thread = await runtime.createThread()
    const path = join(runtime.root, "same-call.txt")
    await writeFile(path, "one\n")

    await thread.startIfIdle({ content: { kind: "text", text: "update" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)

    expect(await readFile(path, "utf8")).toBe("one\n")
  })

  it("removes observation grants when a tool result is context-truncated", async () => {
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
        assertRequest(request) {
          expect(request.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                role: "tool",
                toolCallId: "tool_truncated_read",
                content: expect.stringContaining("...[truncated"),
                fileObservation: undefined,
              }),
            ]),
          )
        },
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "tool_edit_after_truncation",
            name: "edit_file",
            input: {
              path: "truncated.txt",
              oldString: "one",
              newString: "changed",
            },
          },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ])
    const runtime = await createRuntime(provider.stream, createToolRegistry(), {
      executionPolicy: createSessionExecutionPolicy({
        modelVisibleToolResultLines: 1,
      }),
    })
    const thread = await runtime.createThread()
    const path = join(runtime.root, "truncated.txt")
    await writeFile(path, "one\ntwo\n")

    await thread.startIfIdle({ content: { kind: "text", text: "update" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)

    expect(await readFile(path, "utf8")).toBe("one\ntwo\n")
  })

  it("delivers committed tool history before the next model stream", async () => {
    const provider = createFauxProvider([
      {
        snapshots: ["calling tool"],
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "tool_order",
            name: "echo",
            input: { text: "hello" },
          },
        ],
      },
      {
        snapshots: ["final answer"],
        content: [{ type: "text", text: "final answer" }],
      },
    ])
    const runtime = await createRuntime(
      provider.stream,
      createToolRegistry([
        {
          name: "echo",
          description: "Echo text",
          inputSchema: { type: "object" },
          effect: "observe",
          approvalRequirement: { kind: "none" },
          async execute(value) {
            return { ok: true, output: value as never, content: "hello" }
          },
        },
      ]),
    )
    const thread = await runtime.createThread()

    await thread.startIfIdle({ content: { kind: "text", text: "use echo" } })
    const events: SessionEvent[] = []
    for (;;) {
      const event = await thread.nextEvent()
      if (event === undefined) throw new Error("Session ended before the Turn.")
      events.push(event)
      if (event.type === "turn.completed") break
    }

    const toolResultAt = events.findIndex(
      (event) =>
        event.type === "rollout.appended" &&
        event.items.some(
          (item) =>
            item.type === "response_item" && item.item.item.role === "tool",
        ),
    )
    const finalStreamAt = events.findIndex(
      (event) => event.type === "model.stream" && event.text === "final answer",
    )
    expect(toolResultAt).toBeGreaterThan(-1)
    expect(finalStreamAt).toBeGreaterThan(toolResultAt)
  })

  it("delivers permission events between the tool call and its result", async () => {
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "tool_permission_order",
            name: "approved",
            input: {},
          },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ])
    const permissionGate = createPermissionGate()
    const runtime = await createRuntime(
      provider.stream,
      createToolRegistry([
        {
          name: "approved",
          description: "Requires approval",
          inputSchema: { type: "object" },
          effect: "mutate",
          approvalRequirement: {
            kind: "approval",
            action: "command_execution",
          },
          async execute() {
            return { ok: true, output: {}, content: "approved" }
          },
        },
      ]),
      { permissionGate, approvalPolicy: "auto_file_tools" },
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "run" } })
    const pending = await waitForValue(() => permissionGate.list(thread.id)[0])
    permissionGate.resolve({
      sessionId: thread.id,
      turnId: pending.turnId,
      permissionRequestId: pending.permissionRequestId,
      behavior: "allow",
    })

    const events: SessionEvent[] = []
    for (;;) {
      const event = await thread.nextEvent()
      if (event === undefined) throw new Error("Session ended before the Turn.")
      events.push(event)
      if (event.type === "turn.completed") break
    }
    const toolCallAt = events.findIndex(
      (event) =>
        event.type === "rollout.appended" &&
        event.items.some(
          (item) =>
            item.type === "response_item" &&
            item.item.item.role === "assistant" &&
            item.item.item.content.some(
              (block) =>
                block.type === "tool_call" &&
                block.id === "tool_permission_order",
            ),
        ),
    )
    const requestedAt = events.findIndex(
      (event) =>
        event.type === "permission" &&
        event.event.type === "permission.requested",
    )
    const resolvedAt = events.findIndex(
      (event) =>
        event.type === "permission" &&
        event.event.type === "permission.resolved",
    )
    const toolResultAt = events.findIndex(
      (event) =>
        event.type === "rollout.appended" &&
        event.items.some(
          (item) =>
            item.type === "response_item" && item.item.item.role === "tool",
        ),
    )
    expect(toolCallAt).toBeGreaterThan(-1)
    expect(requestedAt).toBeGreaterThan(toolCallAt)
    expect(resolvedAt).toBeGreaterThan(requestedAt)
    expect(toolResultAt).toBeGreaterThan(resolvedAt)
  })

  it("executes the permission-free observe prefix concurrently", async () => {
    const firstEntered = deferred<void>()
    const secondEntered = deferred<void>()
    const releaseFirst = deferred<void>()
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          { type: "tool_call", id: "tool_first", name: "first", input: {} },
          { type: "tool_call", id: "tool_second", name: "second", input: {} },
        ],
      },
      {
        assertRequest(request) {
          expect(
            request.messages
              .filter((message) => message.role === "tool")
              .map((message) => message.toolCallId),
          ).toEqual(["tool_first", "tool_second"])
        },
        content: [{ type: "text", text: "done" }],
      },
    ])
    const tools = createToolRegistry([
      {
        name: "first",
        description: "First observation",
        inputSchema: { type: "object" },
        effect: "observe",
        approvalRequirement: { kind: "none" },
        async execute() {
          firstEntered.resolve()
          await releaseFirst.promise
          return { ok: true, output: "first", content: "first" }
        },
      },
      {
        name: "second",
        description: "Second observation",
        inputSchema: { type: "object" },
        effect: "observe",
        approvalRequirement: { kind: "none" },
        async execute() {
          secondEntered.resolve()
          return { ok: true, output: "second", content: "second" }
        },
      },
    ])
    const runtime = await createRuntime(provider.stream, tools)
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "observe" } })
    await firstEntered.promise
    await secondEntered.promise
    releaseFirst.resolve()
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    expect(provider.callCount).toBe(2)
  })

  it("consumes steering in the active task and aborts the underlying stream", async () => {
    const firstCallEntered = deferred<void>()
    const releaseFirst = deferred<void>()
    let calls = 0
    const stream: StreamFn = async function* (request) {
      calls += 1
      if (calls === 1) {
        firstCallEntered.resolve()
        await releaseFirst.promise
        yield responseEvent("first")
        return
      }
      expect(
        request.messages.some(
          (message) =>
            message.role === "user" &&
            message.content.some(
              (block) => block.text === "steer while running",
            ),
        ),
      ).toBe(true)
      yield responseEvent("after steering")
    }
    const runtime = await createRuntime(stream)
    const thread = await runtime.createThread()
    const started = await thread.startIfIdle({
      content: { kind: "text", text: "start" },
    })
    if (started.type !== "started") throw new Error("Turn did not start.")
    await firstCallEntered.promise
    await expect(
      thread.steer(
        { content: { kind: "text", text: "steer while running" } },
        started.turnId,
      ),
    ).resolves.toMatchObject({ type: "steered" })
    releaseFirst.resolve()
    await nextLifecycleEvent(thread)
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.completed")
    expect(calls).toBe(2)

    const aborting = createFauxProvider([{ waitForAbort: true }])
    const abortRuntime = await createRuntime(aborting.stream)
    const abortThread = await abortRuntime.createThread()
    await abortThread.startIfIdle({
      content: { kind: "text", text: "wait" },
    })
    await abortThread.interrupt("test")
    expect((await nextLifecycleEvent(abortThread))?.type).toBe("turn.started")
    expect((await nextLifecycleEvent(abortThread))?.type).toBe(
      "turn.interrupted",
    )
    expect(
      (await abortRuntime.store.readThread(abortThread.id))?.rollout.some(
        (entry) =>
          entry.item.type === "turn_completed" &&
          entry.item.outcome === "interrupted",
      ),
    ).toBe(true)
  })

  it("applies a steered model to later Turns while the active Turn stays frozen", async () => {
    const firstCallEntered = deferred<void>()
    const releaseFirst = deferred<void>()
    let call = 0
    const stream: StreamFn = async function* (request) {
      call += 1
      if (call === 1) {
        expect(request.target.model).toBe("model-a")
        firstCallEntered.resolve()
        await releaseFirst.promise
      } else if (call === 2) {
        expect(request.target.model).toBe("model-a")
      } else {
        expect(request.target.model).toBe("model-b")
      }
      yield responseEvent(`response ${String(call)}`)
    }
    const runtime = await createRuntime(stream, createToolRegistry([]), {
      model: "model-a",
    })
    const thread = await runtime.createThread()
    const started = await thread.startIfIdle({
      content: { kind: "text", text: "start" },
    })
    if (started.type !== "started") throw new Error("Turn did not start.")
    await firstCallEntered.promise
    await expect(
      thread.steer(
        {
          content: { kind: "text", text: "use B later" },
          modelSelection: { provider: "faux", model: "model-b" },
        },
        started.turnId,
      ),
    ).resolves.toMatchObject({ type: "steered" })
    releaseFirst.resolve()
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)

    await thread.startIfIdle({ content: { kind: "text", text: "next" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    expect(thread.snapshot().configuration?.defaultTarget.model).toBe("model-b")

    await thread.shutdownAndWait()
    const resumed = await runtime.manager.resumeThread(thread.id)
    if (resumed === undefined) throw new Error("Thread did not resume.")
    await resumed.startIfIdle({ content: { kind: "text", text: "resumed" } })
    await nextLifecycleEvent(resumed)
    await nextLifecycleEvent(resumed)
    expect(call).toBe(4)
  })

  it("persists usage on failure and completes dangling tool calls on the next Turn", async () => {
    const toolEntered = deferred<void>()
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        usage: { inputTokens: 9, outputTokens: 2 },
        content: [
          {
            type: "tool_call",
            id: "tool_wait",
            name: "wait",
            input: {},
          },
        ],
      },
      {
        assertRequest(request) {
          const callIndex = request.messages.findIndex(
            (message) =>
              message.role === "assistant" &&
              message.content.some(
                (block) =>
                  block.type === "tool_call" && block.id === "tool_wait",
              ),
          )
          expect(request.messages[callIndex + 1]).toMatchObject({
            role: "tool",
            toolCallId: "tool_wait",
            isError: true,
          })
        },
        content: [{ type: "text", text: "recovered" }],
      },
      {
        stopReason: ModelStopReason.Error,
        error: { code: "provider_failed", message: "provider failed" },
        usage: { inputTokens: 4, outputTokens: 1 },
      },
    ])
    const tools = createToolRegistry([
      {
        name: "wait",
        description: "Wait until interrupted",
        inputSchema: { type: "object" },
        effect: "observe",
        approvalRequirement: { kind: "none" },
        execute(_value, context) {
          toolEntered.resolve()
          return new Promise((_resolve, reject) => {
            context.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            )
          })
        },
      },
    ])
    const runtime = await createRuntime(provider.stream, tools)
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "wait" } })
    await toolEntered.promise
    await thread.interrupt("stop tool")
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)

    let stored = await runtime.store.readThread(thread.id)
    expect(
      stored?.rollout.find(
        (entry) =>
          entry.item.type === "turn_completed" &&
          entry.item.outcome === "interrupted",
      )?.item,
    ).toMatchObject({ usage: { inputTokens: 9, outputTokens: 2 } })

    await thread.startIfIdle({ content: { kind: "text", text: "continue" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    await thread.startIfIdle({ content: { kind: "text", text: "fail" } })
    await nextLifecycleEvent(thread)
    expect((await nextLifecycleEvent(thread))?.type).toBe("session.error")
    stored = await runtime.store.readThread(thread.id)
    expect(
      stored?.rollout.find(
        (entry) =>
          entry.item.type === "turn_completed" &&
          entry.item.outcome === "failed",
      )?.item,
    ).toMatchObject({ usage: { inputTokens: 4, outputTokens: 1 } })
  })

  it("keeps terminal usage when interruption wins before the stream closes", async () => {
    const terminalYielded = deferred<void>()
    const streamMayClose = deferred<void>()
    const stream: StreamFn = async function* () {
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "complete" }],
          usage: { inputTokens: 7, outputTokens: 2 },
        },
      }
      terminalYielded.resolve()
      await streamMayClose.promise
    }
    const runtime = await createRuntime(stream)
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "run" } })
    await terminalYielded.promise
    await thread.interrupt("after terminal")
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)

    expect(
      (await runtime.store.readThread(thread.id))?.rollout.find(
        (entry) =>
          entry.item.type === "turn_completed" &&
          entry.item.outcome === "interrupted",
      )?.item,
    ).toMatchObject({ usage: { inputTokens: 7, outputTokens: 2 } })
    streamMayClose.resolve()
  })

  it("stops late stream publications and observes iterator cleanup failures", async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    const runtimeErrors: unknown[] = []
    let nextCalls = 0
    const iterator: AsyncIterableIterator<ModelStreamEvent> = {
      [Symbol.asyncIterator]() {
        return iterator
      },
      async next() {
        nextCalls += 1
        entered.resolve()
        await release.promise
        return {
          done: false as const,
          value: { type: "snapshot" as const, text: "too late" },
        }
      },
      async return() {
        throw new Error("iterator cleanup failed")
      },
    }
    const stream: StreamFn = () => iterator
    const runtime = await createRuntime(stream, createToolRegistry([]), {
      onRuntimeError: (error) => runtimeErrors.push(error),
    })
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "start" } })
    await entered.promise
    await thread.interrupt("hard stop")
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    release.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runtimeErrors).toEqual([
      expect.objectContaining({ message: "iterator cleanup failed" }),
      expect.objectContaining({ message: "iterator cleanup failed" }),
    ])
    expect(nextCalls).toBe(1)
  })

  it("compacts actor-owned history before sending an over-budget request", async () => {
    const oldText = "old context ".repeat(3_000)
    const provider = createFauxProvider([
      {
        assertRequest(request) {
          expect(request.target.model).toBe("model-a")
        },
        content: [{ type: "text", text: "first response" }],
      },
      {
        assertRequest(request) {
          expect(request.target.model).toBe("model-b")
        },
        content: [{ type: "text", text: oldText }],
      },
      {
        assertRequest(request) {
          expect(request.target.model).toBe("model-b")
        },
        content: [{ type: "text", text: "summary checkpoint" }],
      },
      {
        assertRequest(request) {
          const serialized = JSON.stringify(request.messages)
          expect(request.target.model).toBe("model-b")
          expect(serialized).toContain("<context_compacted>")
          expect(serialized).toContain("<model_switch>")
          expect(serialized).not.toContain(oldText)
        },
        content: [{ type: "text", text: "after compaction" }],
      },
    ])
    const runtime = await createRuntime(
      provider.stream,
      createToolRegistry([]),
      {
        executionPolicy: createSessionExecutionPolicy({
          modelVisibleContextBytes: 60_000,
          compactionTriggerRatio: 0.5,
          compactionRetainRatio: 0,
        }),
        model: "model-a",
      },
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "first" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)

    await thread.startIfIdle({
      content: { kind: "text", text: "second" },
      modelSelection: { provider: "faux", model: "model-b" },
    })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    await thread.startIfIdle({ content: { kind: "text", text: "third" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    expect(provider.callCount).toBe(4)
    const stored = await runtime.store.readThread(thread.id)
    const compactedAt =
      stored?.rollout.findIndex((entry) => entry.item.type === "compacted") ??
      -1
    expect(compactedAt).toBeGreaterThan(-1)
    expect(stored?.rollout[compactedAt + 1]?.item).toMatchObject({
      type: "world_state",
      full: true,
    })
    expect(stored?.rollout[compactedAt + 2]?.item).toMatchObject({
      type: "item_completed",
      item: { type: "context_compaction", status: "completed" },
    })
  })

  it("applies tool-result visibility limits to compaction sources", async () => {
    const hiddenTail = "hidden tool output ".repeat(2_000)
    const oldText = "old context ".repeat(3_000)
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "tool_large_result",
            name: "large_result",
            input: {},
          },
        ],
      },
      {
        assertRequest(request) {
          const result = request.messages.find(
            (message) =>
              message.role === "tool" &&
              message.toolCallId === "tool_large_result",
          )
          expect(result?.content).toContain("...[truncated")
          expect(result?.content).not.toContain(hiddenTail)
        },
        content: [{ type: "text", text: oldText }],
      },
      {
        assertRequest(request) {
          expect(
            request.system.some(
              (section) => section.id === "compaction.instructions",
            ),
          ).toBe(true)
          const serialized = JSON.stringify(request.messages)
          expect(serialized).toContain("...[truncated")
          expect(serialized).not.toContain(hiddenTail)
        },
        content: [{ type: "text", text: "summary" }],
      },
      { content: [{ type: "text", text: "after compaction" }] },
    ])
    const tools = createToolRegistry([
      {
        name: "large_result",
        description: "Return a large result",
        inputSchema: { type: "object" },
        effect: "observe",
        approvalRequirement: { kind: "none" },
        async execute() {
          return {
            ok: true,
            output: {},
            content: `visible first line\n${hiddenTail}`,
          }
        },
      },
    ])
    const runtime = await createRuntime(provider.stream, tools, {
      executionPolicy: createSessionExecutionPolicy({
        modelVisibleContextBytes: 60_000,
        compactionTriggerRatio: 0.5,
        compactionRetainRatio: 0,
        modelVisibleToolResultLines: 1,
      }),
    })
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "first" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    await thread.startIfIdle({ content: { kind: "text", text: "second" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)

    expect(provider.callCount).toBe(4)
  })

  it("rejects a complete request that cannot fit before calling the provider", async () => {
    const provider = createFauxProvider([])
    const runtime = await createRuntime(
      provider.stream,
      createToolRegistry([]),
      {
        modelContextWindowTokens: 100,
      },
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "too large" } })
    await nextLifecycleEvent(thread)
    expect((await nextLifecycleEvent(thread))?.type).toBe("session.error")
    expect(provider.callCount).toBe(0)
  })

  it("retries provider-overflowed compaction with an older prefix", async () => {
    let normalCalls = 0
    let compactionCalls = 0
    const stream: StreamFn = async function* (request) {
      const compacting = request.system.some(
        (section) => section.id === "compaction.instructions",
      )
      if (compacting) {
        compactionCalls += 1
        if (compactionCalls === 1) {
          throw new Error("provider context length exceeded")
        }
        yield responseEvent("short checkpoint")
        return
      }
      normalCalls += 1
      const text = normalCalls <= 2 ? "a".repeat(15_000) : "b".repeat(35_000)
      yield responseEvent(normalCalls === 4 ? "done" : text)
    }
    const runtime = await createRuntime(stream, createToolRegistry([]), {
      executionPolicy: createSessionExecutionPolicy({
        modelVisibleContextBytes: 100_000,
        compactionTriggerRatio: 0.6,
        compactionRetainRatio: 0,
      }),
    })
    const thread = await runtime.createThread()
    for (const text of ["one", "two", "three", "four"]) {
      await thread.startIfIdle({ content: { kind: "text", text } })
      await nextLifecycleEvent(thread)
      await nextLifecycleEvent(thread)
    }

    expect(compactionCalls).toBe(2)
    expect(normalCalls).toBe(4)
    expect(
      (await runtime.store.readThread(thread.id))?.rollout.some(
        (entry) => entry.item.type === "compacted",
      ),
    ).toBe(true)
  })

  it("hard-aborts a stalled compaction stream and keeps observed usage", async () => {
    const compactionStalled = deferred<void>()
    const never = deferred<void>()
    let normalCalls = 0
    let returnCalls = 0
    const stream: StreamFn = (request) => {
      const compacting = request.system.some(
        (section) => section.id === "compaction.instructions",
      )
      if (!compacting) {
        return (async function* () {
          normalCalls += 1
          yield responseEvent("old".repeat(12_000))
        })()
      }
      let nextCalls = 0
      const iterator: AsyncIterableIterator<ModelStreamEvent> = {
        [Symbol.asyncIterator]() {
          return iterator
        },
        async next() {
          nextCalls += 1
          if (nextCalls === 1) {
            return {
              done: false as const,
              value: {
                type: "response" as const,
                response: {
                  stopReason: ModelStopReason.EndTurn,
                  content: [{ type: "text" as const, text: "checkpoint" }],
                  usage: { inputTokens: 6, outputTokens: 1 },
                },
              },
            }
          }
          compactionStalled.resolve()
          await never.promise
          return { done: true as const, value: undefined }
        },
        async return() {
          returnCalls += 1
          return { done: true as const, value: undefined }
        },
      }
      return iterator
    }
    const runtime = await createRuntime(stream, createToolRegistry([]), {
      executionPolicy: createSessionExecutionPolicy({
        modelVisibleContextBytes: 60_000,
        compactionTriggerRatio: 0.5,
        compactionRetainRatio: 0,
      }),
    })
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "first" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    await thread.startIfIdle({ content: { kind: "text", text: "second" } })
    await compactionStalled.promise
    await thread.interrupt("stop compaction")
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)

    expect(returnCalls).toBeGreaterThanOrEqual(1)
    expect(normalCalls).toBe(1)
    expect(
      (await runtime.store.readThread(thread.id))?.rollout.find(
        (entry) =>
          entry.item.type === "turn_completed" &&
          entry.item.outcome === "interrupted",
      )?.item,
    ).toMatchObject({ usage: { inputTokens: 6, outputTokens: 1 } })
  })
})

async function createRuntime(
  stream: StreamFn,
  toolRegistry = createToolRegistry([]),
  options: Omit<Partial<TurnProcessorOptions>, "stream" | "toolRegistry"> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-live-turn-"))
  const store = new MemoryThreadStore()
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () =>
      createTurnProcessor({
        stream,
        toolRegistry,
        loadProjectInstructions: async () => undefined,
        ...options,
      }),
  })
  cleanups.push(async () => {
    await manager.shutdown()
    await rm(root, { recursive: true, force: true })
  })
  return {
    manager,
    root,
    store,
    createThread: () =>
      manager.createThread({
        workingDirectory: root,
        mateId: "mate_live",
        mateRevisionId: "mate_revision_live",
      }),
  }
}

async function nextLifecycleEvent(thread: {
  nextEvent(): Promise<SessionEvent | undefined>
}): Promise<SessionEvent | undefined> {
  for (;;) {
    const event = await thread.nextEvent()
    if (
      event === undefined ||
      (event.type !== "rollout.appended" &&
        event.type !== "model.stream" &&
        event.type !== "item.started" &&
        event.type !== "permission")
    ) {
      return event
    }
  }
}

function responseEvent(text: string): ModelStreamEvent {
  return {
    type: "response",
    response: {
      stopReason: ModelStopReason.EndTurn,
      content: [{ type: "text", text }],
    },
  }
}

async function waitForValue<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Timed out waiting for a value.")
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
