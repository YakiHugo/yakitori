import { describe, expect, it } from "vitest"
import {
  createExecutionViewState,
  projectExecutionView,
  reduceExecutionView,
} from "../../src/gui/execution-view.ts"
import { presentTool } from "../../src/gui/tool-presentation.ts"
import {
  createEventEnvelope,
  EventType,
  HistoryRecordType,
  InputRole,
  type ItemContent,
  type JsonValue,
  type KernelError,
  type KernelFact,
  type ToolExecutionDescriptor,
} from "../../src/kernel/events.ts"

const sessionId = "session_00000000-0000-4000-8000-000000000000"

describe("execution view", () => {
  it("replaces a transient snapshot with an agent item completion", () => {
    let state = createExecutionViewState()
    state = reduceExecutionView(state, {
      type: "transient",
      event: {
        type: "assistant.snapshot",
        sessionId,
        turnId: "turn_1",
        streamId: "stream_1",
        text: "Hel",
        createdAt: "2026-07-24T00:00:00.000Z",
      },
    })
    state = reduceExecutionView(state, {
      type: "durable",
      event: createExecutionEnvelope({
        sessionId,
        seq: 1,
        event: agentCompleted({
          itemId: "item_1",
          turnId: "turn_1",
          text: "Hello",
          streamId: "stream_1",
        }),
      }),
    })

    expect(projectExecutionView(state).entries).toEqual([
      expect.objectContaining({
        kind: "assistant",
        itemId: "item_1",
        text: "Hello",
        status: "completed",
      }),
    ])
  })

  it("shows a live reasoning summary and replaces it with the durable block", () => {
    let state = reduceExecutionView(createExecutionViewState(), {
      type: "transient",
      event: {
        type: "reasoning.snapshot",
        sessionId,
        turnId: "turn_1",
        streamId: "stream_1",
        text: "Inspecting files",
        createdAt: "2026-07-24T00:00:00.000Z",
      },
    })

    expect(projectExecutionView(state).entries).toEqual([
      {
        kind: "reasoning",
        streamId: "stream_1",
        text: "Inspecting files",
        status: "streaming",
        at: "2026-07-24T00:00:00.000Z",
      },
    ])

    state = reduceExecutionView(state, {
      type: "durable",
      event: createExecutionEnvelope({
        sessionId,
        seq: 1,
        event: {
          type: EventType.ItemCompleted,
          data: {
            turnId: "turn_1",
            item: {
              type: "reasoning",
              itemId: "reasoning_1",
              text: "Inspecting files",
              streamId: "stream_1",
            },
          },
        },
      }),
    })
    state = reduceExecutionView(state, {
      type: "durable",
      event: createExecutionEnvelope({
        sessionId,
        seq: 2,
        event: {
          type: EventType.ItemCompleted,
          data: {
            turnId: "turn_1",
            item: {
              type: "agent_message",
              itemId: "item_1",
              content: [{ type: "text", text: "Done." }],
              streamId: "stream_1",
            },
          },
        },
      }),
    })

    expect(projectExecutionView(state).entries).toEqual([
      expect.objectContaining({
        kind: "reasoning",
        text: "Inspecting files",
        status: "completed",
      }),
      expect.objectContaining({
        kind: "assistant",
        text: "Done.",
        status: "completed",
      }),
    ])
  })

  it("projects public reasoning separately from the assistant answer", () => {
    const state = [
      {
        type: EventType.ItemCompleted,
        data: {
          turnId: "turn_1",
          item: {
            type: "reasoning" as const,
            itemId: "reasoning_1",
            text: "Inspect the event ordering.",
          },
        },
      },
      {
        type: EventType.ItemCompleted,
        data: {
          turnId: "turn_1",
          item: {
            type: "agent_message" as const,
            itemId: "item_1",
            content: [
              { type: "text" as const, text: "The ordering is correct." },
            ],
          },
        },
      },
    ].reduce(
      (current, event, index) =>
        reduceExecutionView(current, {
          type: "durable",
          event: createExecutionEnvelope({
            sessionId,
            seq: index + 1,
            createdAt: `2026-07-24T00:00:0${index}.000Z`,
            event,
          }),
        }),
      createExecutionViewState(),
    )

    expect(projectExecutionView(state).entries).toEqual([
      {
        kind: "reasoning",
        itemId: "reasoning_1",
        text: "Inspect the event ordering.",
        status: "completed",
        at: "2026-07-24T00:00:00.000Z",
      },
      expect.objectContaining({
        kind: "assistant",
        itemId: "item_1",
        text: "The ordering is correct.",
      }),
    ])
  })

  it("projects durable tool facts and a transient pending permission", () => {
    const facts: KernelFact[] = [
      {
        type: EventType.InputAdmitted,
        data: {
          requestId: "request:1",
          inputId: "input_1",
          role: InputRole.User,
          content: { kind: "text" as const, text: "run" },
        },
      },
      toolStarted({
        toolCallId: "tool_1",
        itemId: "item_call",
        turnId: "turn_1",
        name: "run_command",
        input: { command: "pwd" },
        requiresPermission: true,
      }),
      toolCompleted({
        resultItemId: "item_result",
        toolCallId: "tool_1",
        turnId: "turn_1",
        content: { kind: "text", text: "/workspace" },
      }),
    ]
    let state = facts.reduce(
      (current, event, index) =>
        reduceExecutionView(current, {
          type: "durable",
          event: createExecutionEnvelope({ sessionId, seq: index + 1, event }),
        }),
      createExecutionViewState(),
    )
    state = reduceExecutionView(state, {
      type: "transient",
      event: {
        type: "permission.requested",
        sessionId,
        permissionRequestId: "permission_1",
        turnId: "turn_1",
        toolCallId: "tool_1",
        action: "run_command",
        subject: "pnpm test",
        reason: "Command runs with host authority.",
        createdAt: "2026-08-25T00:00:00.000Z",
      },
    })

    expect(projectExecutionView(state).entries).toEqual([
      expect.objectContaining({ kind: "user_input", text: "run" }),
      expect.objectContaining({
        kind: "tool",
        toolCallId: "tool_1",
        state: "completed",
        resultText: "/workspace",
      }),
      expect.objectContaining({
        kind: "permission",
        permissionRequestId: "permission_1",
        subject: "pnpm test",
        reason: "Command runs with host authority.",
        state: "requested",
      }),
    ])
  })

  it("drops transient permissions when their Turn reaches a durable terminal state", () => {
    let state = reduceExecutionView(createExecutionViewState(), {
      type: "transient",
      event: {
        type: "permission.requested",
        sessionId,
        permissionRequestId: "permission_terminal",
        turnId: "turn_terminal",
        toolCallId: "tool_terminal",
        action: "run_command",
        createdAt: "2026-08-25T00:00:00.000Z",
      },
    })
    state = reduceExecutionView(state, {
      type: "durable",
      event: createExecutionEnvelope({
        sessionId,
        seq: 1,
        event: {
          type: EventType.TurnCompleted,
          data: {
            turnId: "turn_terminal",
            outcome: { status: "cancelled" },
          },
        },
      }),
    })

    expect(
      projectExecutionView(state).entries.some(
        (entry) => entry.kind === "permission",
      ),
    ).toBe(false)
  })

  it("extracts structured diff and command results from tool output", () => {
    const facts: KernelFact[] = [
      toolStarted({
        toolCallId: "tool_1",
        itemId: "item_call_1",
        turnId: "turn_1",
        name: "edit_file",
        input: { path: "src/index.ts" },
        requiresPermission: false,
      }),
      toolCompleted({
        resultItemId: "item_result_1",
        toolCallId: "tool_1",
        turnId: "turn_1",
        content: { kind: "text", text: "edited src/index.ts" },
        output: {
          path: "src/index.ts",
          sha256: "abc",
          diff: {
            format: "unified",
            text: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new",
            truncated: false,
          },
        },
        execution: {
          type: "file_change",
          request: { operation: "edit", paths: ["src/index.ts"] },
          changes: [
            {
              path: "src/index.ts",
              kind: "update",
              diff: {
                format: "unified",
                text: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new",
                truncated: false,
              },
            },
          ],
        },
      }),
      toolStarted({
        toolCallId: "tool_2",
        itemId: "item_call_2",
        turnId: "turn_1",
        name: "run_command",
        input: { command: "pnpm test", description: "Run the test suite" },
        requiresPermission: true,
      }),
      toolCompleted({
        resultItemId: "item_result_2",
        toolCallId: "tool_2",
        turnId: "turn_1",
        content: { kind: "text", text: "all green" },
        output: {
          exitCode: 0,
          signal: null,
          stdout: "all green",
          stderr: "",
          truncated: false,
          timedOut: false,
          durationMs: 4100,
          cwd: "/workspace/packages/gui",
          shell: "/bin/zsh",
          blocked: { rule: "rm_root" },
          binary: {
            stdout: false,
            stderr: true,
            stdoutBytes: 9,
            stderrBytes: 3,
          },
        },
        execution: {
          type: "command_execution",
          command: "pnpm test",
          description: "Run the test suite",
          result: {
            exitCode: 0,
            signal: null,
            stdout: "all green",
            stderr: "",
            truncated: false,
            timedOut: false,
            durationMs: 4100,
            cwd: "/workspace/packages/gui",
            shell: "/bin/zsh",
            blocked: { rule: "rm_root" },
            binary: {
              stdout: false,
              stderr: true,
              stdoutBytes: 9,
              stderrBytes: 3,
            },
          },
        },
      }),
    ]
    const state = facts.reduce(
      (current, event, index) =>
        reduceExecutionView(current, {
          type: "durable",
          event: createExecutionEnvelope({ sessionId, seq: index + 1, event }),
        }),
      createExecutionViewState(),
    )

    const entries = projectExecutionView(state).entries
    expect(entries).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCallId: "tool_1",
        output: expect.objectContaining({ path: "src/index.ts" }),
      }),
      expect.objectContaining({
        kind: "tool",
        toolCallId: "tool_2",
        output: expect.objectContaining({ exitCode: 0, stdout: "all green" }),
      }),
    ])
    const presentations = entries.flatMap((entry) =>
      entry.kind === "tool" ? [presentTool(entry)] : [],
    )
    expect(presentations).toEqual([
      expect.objectContaining({
        detail: {
          kind: "diff",
          path: "src/index.ts",
          diff: {
            format: "unified",
            text: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new",
            truncated: false,
          },
        },
      }),
      expect.objectContaining({
        subject: "Run the test suite",
        detail: expect.objectContaining({
          kind: "command",
          result: {
            exitCode: 0,
            signal: null,
            stdout: "all green",
            stderr: "",
            truncated: false,
            timedOut: false,
            durationMs: 4100,
            cwd: "/workspace/packages/gui",
            shell: "/bin/zsh",
            blocked: { rule: "rm_root" },
            binary: {
              stdout: false,
              stderr: true,
              stdoutBytes: 9,
              stderrBytes: 3,
            },
          },
        }),
      }),
    ])
  })

  it("projects a timed-out command result with partial output and no exit code", () => {
    const facts = [
      toolStarted({
        toolCallId: "tool_1",
        itemId: "item_call_1",
        turnId: "turn_1",
        name: "run_command",
        input: { command: "sleep 60" },
        requiresPermission: true,
      }),
      toolCompleted({
        resultItemId: "item_result_1",
        toolCallId: "tool_1",
        turnId: "turn_1",
        content: {
          kind: "text",
          text: "Command timed out after 30s.",
        },
        output: {
          timedOut: true,
          stdout: "partial",
          stderr: "",
          truncated: false,
        },
        execution: {
          type: "command_execution",
          command: "sleep 60",
          result: {
            exitCode: null,
            signal: null,
            stdout: "partial",
            stderr: "",
            truncated: false,
            timedOut: true,
          },
        },
        error: { code: "command_timeout", message: "Command timed out." },
      }),
    ]
    const state = facts.reduce(
      (current, event, index) =>
        reduceExecutionView(current, {
          type: "durable",
          event: createExecutionEnvelope({ sessionId, seq: index + 1, event }),
        }),
      createExecutionViewState(),
    )

    const entry = projectExecutionView(state).entries[0]
    expect(entry).toMatchObject({
      kind: "tool",
      toolCallId: "tool_1",
      state: "failed",
      resultError: true,
      resultErrorMessage: "Command timed out.",
    })
    if (entry?.kind !== "tool") throw new Error("Expected a tool entry.")
    expect(presentTool(entry)).toMatchObject({
      detail: {
        kind: "command",
        result: {
          exitCode: null,
          signal: null,
          stdout: "partial",
          stderr: "",
          truncated: false,
          timedOut: true,
        },
      },
    })
  })

  it("renders interruption separately from failure", () => {
    const facts: KernelFact[] = [
      toolStarted({
        toolCallId: "tool_1",
        itemId: "item_call",
        turnId: "turn_1",
        name: "run_command",
        input: { command: "sleep 30" },
        requiresPermission: true,
      }),
      {
        type: EventType.TurnCompleted,
        data: {
          turnId: "turn_1",
          outcome: { status: "interrupted", reason: "runtime restart" },
        },
      },
    ]
    const state = facts.reduce(
      (current, event, index) =>
        reduceExecutionView(current, {
          type: "durable",
          event: createExecutionEnvelope({ sessionId, seq: index + 1, event }),
        }),
      createExecutionViewState(),
    )
    expect(projectExecutionView(state).entries).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCallId: "tool_1",
        state: "interrupted",
        resultText:
          "Interrupted before a result was recorded. Side effects may be unknown.",
      }),
      {
        kind: "turn_terminal",
        turnId: "turn_1",
        state: "interrupted",
        message: "runtime restart",
      },
    ])
  })

  it("keeps unknown facts in catch-up state without rendering or throwing", () => {
    const state = reduceExecutionView(createExecutionViewState(), {
      type: "durable",
      event: {
        id: "event_future",
        sessionId,
        seq: 1,
        version: 5,
        createdAt: "2026-07-24T00:00:00.000Z",
        type: "provider.future_fact",
        data: { payload: true },
      },
    })

    expect(state.durableEvents).toHaveLength(1)
    expect(projectExecutionView(state).entries).toEqual([])
  })

  it("projects a compaction marker in seq order with its summary", () => {
    const facts = [
      {
        type: EventType.InputAdmitted,
        data: {
          requestId: "request:1",
          inputId: "input_1",
          role: InputRole.User,
          content: { kind: "text" as const, text: "earlier work" },
        },
      },
      {
        type: EventType.ContextCompacted,
        data: {
          compactionId: "compaction_1",
          turnId: "turn_2",
          throughSeq: 5,
          coveredTurnIds: ["turn_1"],
          summary: "Goal: ship the feature.",
          replacement: {
            windowId: "context_window_2",
            firstWindowId: "context_window_1",
            previousWindowId: "context_window_1",
            windowNumber: 2,
            history: [],
            worldStateBaseline: {},
          },
        },
      },
      agentCompleted({
        itemId: "item_1",
        turnId: "turn_2",
        text: "Continuing.",
      }),
    ]
    const state = facts.reduce(
      (current, event, index) =>
        reduceExecutionView(current, {
          type: "durable",
          event: createExecutionEnvelope({
            sessionId,
            seq: index + 1,
            createdAt: `2026-07-24T00:00:0${index}.000Z`,
            event,
          }),
        }),
      createExecutionViewState(),
    )

    expect(projectExecutionView(state).entries).toEqual([
      expect.objectContaining({ kind: "user_input", text: "earlier work" }),
      {
        kind: "context_compacted",
        compactionId: "compaction_1",
        summary: "Goal: ship the feature.",
        createdAt: "2026-07-24T00:00:01.000Z",
      },
      expect.objectContaining({ kind: "assistant", text: "Continuing." }),
    ])
  })

  it("summarizes tool entries and tracks model, usage, and queued inputs", () => {
    const facts: KernelFact[] = [
      {
        type: EventType.InputAdmitted,
        data: {
          requestId: "request:1",
          inputId: "input_1",
          role: InputRole.User,
          content: { kind: "text" as const, text: "run" },
        },
      },
      {
        type: EventType.InputAdmitted,
        data: {
          requestId: "request:2",
          inputId: "input_2",
          role: InputRole.User,
          content: { kind: "text" as const, text: "queued" },
        },
      },
      {
        type: HistoryRecordType.TurnContext,
        data: {
          turnId: "turn_1",
          context: {
            mateId: "mate_1",
            mateRevisionId: "revision_1",
            provider: "faux",
            model: "faux-1",
            instructionProfileId: "default",
            baseInstructionsRevision: "base_test",
            modelInstructionsRevision: "model_test",
            workingDirectory: "/workspace",
            enabledTools: ["run_command"],
            approvalPolicy: "host",
            executionPolicy: {
              modelCallsPerTurn: 4,
              toolCallsPerTurn: 8,
              modelVisibleMessageBlocks: 16,
              modelVisibleContextBytes: 1024,
              compactionTriggerContextBytes: 800,
              compactionRetainContextBytes: 160,
              modelVisibleToolResultBytes: 512,
              modelVisibleToolResultLines: 32,
              assistantResponseBytes: 2048,
            },
          },
        },
      },
      {
        type: EventType.TurnStarted,
        data: { turnId: "turn_1", inputId: "input_1" },
      },
      toolStarted({
        toolCallId: "tool_1",
        itemId: "item_call_1",
        turnId: "turn_1",
        name: "run_command",
        input: {
          command:
            "pnpm test -- --run some/very/long/command/that/keeps/going/and/going/and/going/past/limit",
        },
        requiresPermission: true,
      }),
      toolStarted({
        toolCallId: "tool_2",
        itemId: "item_call_2",
        turnId: "turn_1",
        name: "read_file",
        input: { path: "src/index.ts" },
        requiresPermission: false,
      }),
      {
        type: EventType.TurnCompleted,
        data: {
          turnId: "turn_1",
          outcome: { status: "completed" },
          usage: {
            inputTokens: 120,
            outputTokens: 45,
            cacheReadInputTokens: 90,
            cacheWriteInputTokens: 10,
          },
          metrics: {
            modelCalls: 2,
            toolCalls: 2,
            modelDurationMs: 4_000,
            toolDurationMs: 1_000,
            averageTimeToFirstTokenMs: 250,
          },
        },
      },
    ]
    const state = facts.reduce(
      (current, event, index) =>
        reduceExecutionView(current, {
          type: "durable",
          event: createExecutionEnvelope({ sessionId, seq: index + 1, event }),
        }),
      createExecutionViewState(),
    )
    const view = projectExecutionView(state, {
      id: sessionId,
      conversationId: "conversation_1",
      seq: facts.length,
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
      pendingPermissions: [],
      currentModel: { provider: "faux", model: "faux-1" },
      counts: {
        inputs: 2,
        pendingInputs: 1,
        turns: 1,
        items: 0,
        permissions: 0,
        tools: 2,
      },
    })

    expect(view.queuedInputIds).toEqual(["input_2"])
    expect(view.lastModel).toEqual({ provider: "faux", model: "faux-1" })
    expect(view.lastTurnUsage).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cacheReadInputTokens: 90,
      cacheWriteInputTokens: 10,
    })
    expect(view.telemetry).toEqual({
      turns: 1,
      steps: 4,
      modelDurationMs: 4_000,
      toolDurationMs: 1_000,
      averageTimeToFirstTokenMs: 250,
      inputTokens: 120,
      outputTokens: 45,
      cacheReadInputTokens: 90,
      cacheWriteInputTokens: 10,
    })
    expect(view.entries).toEqual([
      expect.objectContaining({ kind: "user_input", inputId: "input_1" }),
      expect.objectContaining({ kind: "user_input", inputId: "input_2" }),
      expect.objectContaining({ kind: "tool", toolCallId: "tool_1" }),
      expect.objectContaining({ kind: "tool", toolCallId: "tool_2" }),
    ])

    const toolExecutions = view.entries.flatMap((entry) =>
      entry.kind === "tool" ? [entry.execution] : [],
    )
    expect(toolExecutions).toHaveLength(2)
    expect(toolExecutions[1]).toMatchObject({
      type: "file_read",
      path: "src/index.ts",
    })
    expect(toolExecutions[0]).toMatchObject({
      type: "command_execution",
      command: expect.stringContaining("pnpm test -- --run"),
    })
  })

  it("drops cancelled inputs from the queue and reports the active turn start", () => {
    let state = createExecutionViewState()
    state = [
      {
        type: EventType.InputAdmitted,
        data: {
          requestId: "request:1",
          inputId: "input_1",
          role: InputRole.User,
          content: { kind: "text" as const, text: "first" },
        },
      },
      {
        type: EventType.InputAdmitted,
        data: {
          requestId: "request:2",
          inputId: "input_2",
          role: InputRole.User,
          content: { kind: "text" as const, text: "cancelled" },
        },
      },
      {
        type: EventType.InputCancelled,
        data: { inputId: "input_2" },
      },
    ].reduce(
      (current, event, index) =>
        reduceExecutionView(current, {
          type: "durable",
          event: createExecutionEnvelope({
            sessionId,
            seq: index + 1,
            event,
            createdAt: `2026-07-24T00:00:0${index}.000Z`,
          }),
        }),
      state,
    )
    const session = {
      id: sessionId,
      conversationId: "conversation_1",
      seq: 3,
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:02.000Z",
      activeTurnId: "turn_9",
      pendingPermissions: [],
      counts: {
        inputs: 2,
        pendingInputs: 1,
        turns: 0,
        items: 0,
        permissions: 0,
        tools: 0,
      },
    }

    const view = projectExecutionView(state, session)
    expect(view.queuedInputIds).toEqual(["input_1"])
    expect(view.activeTurnId).toBe("turn_9")
    expect(view.activeTurnStartedAt).toBeUndefined()

    state = reduceExecutionView(state, {
      type: "durable",
      event: createExecutionEnvelope({
        sessionId,
        seq: 4,
        createdAt: "2026-07-24T00:00:03.000Z",
        event: {
          type: EventType.TurnStarted,
          data: { turnId: "turn_9", inputId: "input_1" },
        },
      }),
    })

    const next = projectExecutionView(state, session)
    expect(next.queuedInputIds).toEqual([])
    expect(next.activeTurnStartedAt).toBe("2026-07-24T00:00:03.000Z")
  })

  it("derives the active activity from snapshots, tools, and permissions", () => {
    let state = reduceExecutionView(createExecutionViewState(), {
      type: "durable",
      event: createExecutionEnvelope({
        sessionId,
        seq: 1,
        event: {
          type: EventType.TurnStarted,
          data: { turnId: "turn_1", inputId: "input_1" },
        },
      }),
    })
    const session = activeSession("turn_1", 1)
    expect(projectExecutionView(state, session).activeActivity).toEqual({
      kind: "reasoning",
    })

    state = reduceExecutionView(state, {
      type: "transient",
      event: {
        type: "assistant.snapshot",
        sessionId,
        turnId: "turn_1",
        streamId: "stream_1",
        text: "Writing",
        createdAt: "2026-07-24T00:00:01.000Z",
      },
    })
    expect(projectExecutionView(state, session).activeActivity).toEqual({
      kind: "responding",
    })

    state = reduceExecutionView(state, {
      type: "durable",
      event: createExecutionEnvelope({
        sessionId,
        seq: 2,
        event: toolStarted({
          toolCallId: "tool_1",
          itemId: "item_1",
          turnId: "turn_1",
          name: "run_command",
          input: { command: "pnpm test" },
          requiresPermission: true,
        }),
      }),
    })
    expect(projectExecutionView(state, session).activeActivity).toEqual({
      kind: "running_tool",
      name: "run_command",
    })

    state = reduceExecutionView(state, {
      type: "transient",
      event: {
        type: "permission.requested",
        sessionId,
        permissionRequestId: "permission_1",
        turnId: "turn_1",
        toolCallId: "tool_1",
        action: "run_command",
        createdAt: "2026-08-25T00:00:00.000Z",
      },
    })
    expect(projectExecutionView(state, session).activeActivity).toEqual({
      kind: "waiting_permission",
      action: "run_command",
    })
  })
})

function createExecutionEnvelope(
  input: Parameters<typeof createEventEnvelope>[0],
) {
  return createEventEnvelope(input)
}

function agentCompleted(input: {
  readonly itemId: string
  readonly turnId: string
  readonly text: string
  readonly streamId?: string
}): KernelFact {
  return {
    type: EventType.ItemCompleted,
    data: {
      turnId: input.turnId,
      item: {
        type: "agent_message",
        itemId: input.itemId,
        content: [{ type: "text", text: input.text }],
        ...(input.streamId === undefined ? {} : { streamId: input.streamId }),
      },
    },
  }
}

function toolStarted(input: {
  readonly toolCallId: string
  readonly itemId: string
  readonly turnId: string
  readonly name: string
  readonly input: JsonValue
  readonly requiresPermission: boolean
}): KernelFact {
  return {
    type: EventType.ItemStarted,
    data: {
      turnId: input.turnId,
      item: {
        ...executionDescriptor(input.name, input.input),
        itemId: input.itemId,
        toolCallId: input.toolCallId,
        name: input.name,
        input: input.input,
        requiresPermission: input.requiresPermission,
      },
    },
  }
}

function toolCompleted(input: {
  readonly resultItemId: string
  readonly toolCallId: string
  readonly turnId: string
  readonly content: ItemContent
  readonly output?: JsonValue
  readonly error?: KernelError
  readonly execution?: ToolExecutionDescriptor
}): KernelFact {
  return {
    type: EventType.ItemCompleted,
    data: {
      turnId: input.turnId,
      item: {
        ...(input.execution ?? { type: "dynamic_tool_call" as const }),
        itemId: `call:${input.toolCallId}`,
        toolCallId: input.toolCallId,
        name: "tool",
        input: {},
        requiresPermission: false,
        resultItemId: input.resultItemId,
        content: input.content,
        ...(input.output === undefined ? {} : { output: input.output }),
        ...(input.error === undefined ? {} : { error: input.error }),
      },
    },
  }
}

function executionDescriptor(
  name: string,
  input: unknown,
): ToolExecutionDescriptor {
  const fields = recordOf(input)
  if (name === "run_command") {
    return {
      type: "command_execution",
      command: stringOf(fields?.command) ?? "",
      ...(stringOf(fields?.description) === undefined
        ? {}
        : { description: stringOf(fields?.description) as string }),
    }
  }
  if (name === "read_file") {
    return {
      type: "file_read",
      path: stringOf(fields?.path) ?? "",
      ...(numberOf(fields?.offset) === undefined
        ? {}
        : { offset: numberOf(fields?.offset) as number }),
      ...(numberOf(fields?.limit) === undefined
        ? {}
        : { limit: numberOf(fields?.limit) as number }),
    }
  }
  if (name === "edit_file" || name === "write_file") {
    const path = stringOf(fields?.path) ?? ""
    return {
      type: "file_change",
      request: {
        operation: name === "write_file" ? "write" : "edit",
        paths: [path],
      },
      changes: [],
    }
  }
  return { type: "dynamic_tool_call" }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}

function activeSession(activeTurnId: string, seq: number) {
  return {
    id: sessionId,
    conversationId: "conversation_1",
    seq,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    activeTurnId,
    pendingPermissions: [],
    counts: {
      inputs: 1,
      pendingInputs: 0,
      turns: 1,
      items: 0,
      permissions: 0,
      tools: 0,
    },
  }
}
