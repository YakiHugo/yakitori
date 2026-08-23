import { describe, expect, it } from "vitest"
import {
  createExecutionViewState,
  projectExecutionView,
  reduceExecutionView,
} from "../../src/gui/execution-view.ts"
import {
  createEventEnvelope,
  EventType,
  HistoryRecordType,
  InputRole,
  toolExecutionType,
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
        event: {
          type: HistoryRecordType.AgentMessage,
          data: {
            messageId: "item_1",
            turnId: "turn_1",
            content: [{ type: "text", text: "Hello" }],
            providerMetadata: { streamId: "stream_1" },
          },
        },
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
          type: HistoryRecordType.AgentMessage,
          data: {
            messageId: "item_1",
            turnId: "turn_1",
            content: [
              { type: "reasoning", text: "Inspecting files" },
              { type: "text", text: "Done." },
            ],
            providerMetadata: { streamId: "stream_1" },
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
    const state = reduceExecutionView(createExecutionViewState(), {
      type: "durable",
      event: createExecutionEnvelope({
        sessionId,
        seq: 1,
        createdAt: "2026-07-24T00:00:00.000Z",
        event: {
          type: HistoryRecordType.AgentMessage,
          data: {
            messageId: "item_1",
            turnId: "turn_1",
            content: [
              { type: "reasoning", text: "Inspect the event ordering." },
              { type: "text", text: "The ordering is correct." },
            ],
          },
        },
      }),
    })

    expect(projectExecutionView(state).entries).toEqual([
      {
        kind: "reasoning",
        itemId: "item_1:reasoning:0",
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

  it("projects coarse input, tool, result, and permission facts", () => {
    const facts = [
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
        type: HistoryRecordType.ModelToolCall,
        data: {
          toolCallId: "tool_1",
          itemId: "item_call",
          turnId: "turn_1",
          name: "run_command",
          input: { command: "pwd" },
          requiresPermission: true,
        },
      },
      {
        type: EventType.PermissionRequested,
        data: {
          permissionRequestId: "permission_1",
          turnId: "turn_1",
          toolCallId: "tool_1",
          action: "run_command",
        },
      },
      {
        type: EventType.PermissionResolved,
        data: {
          permissionRequestId: "permission_1",
          turnId: "turn_1",
          behavior: "allow" as const,
        },
      },
      {
        type: HistoryRecordType.ModelToolResult,
        data: {
          toolResultId: "item_result",
          toolCallId: "tool_1",
          turnId: "turn_1",
          content: { kind: "text" as const, text: "/workspace" },
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
        state: "resolved",
        behavior: "allow",
      }),
    ])
  })

  it("extracts structured diff and command results from tool output", () => {
    const facts = [
      {
        type: HistoryRecordType.ModelToolCall,
        data: {
          toolCallId: "tool_1",
          itemId: "item_call_1",
          turnId: "turn_1",
          name: "edit_file",
          input: { path: "src/index.ts" },
          requiresPermission: false,
        },
      },
      {
        type: HistoryRecordType.ModelToolResult,
        data: {
          toolResultId: "item_result_1",
          toolCallId: "tool_1",
          turnId: "turn_1",
          content: { kind: "text" as const, text: "edited src/index.ts" },
          output: {
            path: "src/index.ts",
            sha256: "abc",
            diff: {
              format: "unified",
              text: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new",
              truncated: false,
            },
          },
        },
      },
      {
        type: HistoryRecordType.ModelToolCall,
        data: {
          toolCallId: "tool_2",
          itemId: "item_call_2",
          turnId: "turn_1",
          name: "run_command",
          input: { command: "pnpm test", description: "Run the test suite" },
          requiresPermission: true,
        },
      },
      {
        type: HistoryRecordType.ModelToolResult,
        data: {
          toolResultId: "item_result_2",
          toolCallId: "tool_2",
          turnId: "turn_1",
          content: { kind: "text" as const, text: "all green" },
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
        output: expect.objectContaining({ path: "src/index.ts" }),
        diff: {
          text: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new",
          truncated: false,
        },
      }),
      expect.objectContaining({
        kind: "tool",
        toolCallId: "tool_2",
        summary: "Run the test suite",
        output: expect.objectContaining({ exitCode: 0, stdout: "all green" }),
        commandResult: {
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
    ])
  })

  it("projects a timed-out command result with partial output and no exit code", () => {
    const facts = [
      {
        type: HistoryRecordType.ModelToolCall,
        data: {
          toolCallId: "tool_1",
          itemId: "item_call_1",
          turnId: "turn_1",
          name: "run_command",
          input: { command: "sleep 60" },
          requiresPermission: true,
        },
      },
      {
        type: HistoryRecordType.ModelToolResult,
        data: {
          toolResultId: "item_result_1",
          toolCallId: "tool_1",
          turnId: "turn_1",
          content: {
            kind: "text" as const,
            text: "Command timed out after 30s.",
          },
          output: {
            timedOut: true,
            stdout: "partial",
            stderr: "",
            truncated: false,
          },
          error: { code: "command_timeout", message: "Command timed out." },
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
        state: "failed",
        resultError: true,
        resultErrorMessage: "Command timed out.",
        commandResult: {
          exitCode: null,
          signal: null,
          stdout: "partial",
          stderr: "",
          truncated: false,
          timedOut: true,
        },
      }),
    ])
  })

  it("renders interruption separately from failure", () => {
    const facts = [
      {
        type: HistoryRecordType.ModelToolCall,
        data: {
          toolCallId: "tool_1",
          itemId: "item_call",
          turnId: "turn_1",
          name: "run_command",
          input: { command: "sleep 30" },
          requiresPermission: true,
        },
      },
      {
        type: EventType.PermissionRequested,
        data: {
          permissionRequestId: "permission_1",
          turnId: "turn_1",
          toolCallId: "tool_1",
          action: "run_command",
        },
      },
      {
        type: EventType.TurnInterrupted,
        data: { turnId: "turn_1", reason: "runtime restart" },
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
      expect.objectContaining({
        kind: "permission",
        permissionRequestId: "permission_1",
        state: "stale",
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
        version: 2,
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
        },
      },
      {
        type: HistoryRecordType.AgentMessage,
        data: {
          messageId: "item_1",
          turnId: "turn_2",
          content: [{ type: "text" as const, text: "Continuing." }],
        },
      },
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
    const facts = [
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
            promptId: "default",
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
      {
        type: HistoryRecordType.ModelToolCall,
        data: {
          toolCallId: "tool_1",
          itemId: "item_call_1",
          turnId: "turn_1",
          name: "run_command",
          input: {
            command:
              "pnpm test -- --run some/very/long/command/that/keeps/going/and/going/and/going/past/limit",
          },
          requiresPermission: true,
        },
      },
      {
        type: HistoryRecordType.ModelToolCall,
        data: {
          toolCallId: "tool_2",
          itemId: "item_call_2",
          turnId: "turn_1",
          name: "read_file",
          input: { path: "src/index.ts" },
          requiresPermission: false,
        },
      },
      {
        type: EventType.TurnCompleted,
        data: {
          turnId: "turn_1",
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

    const toolSummaries = view.entries.flatMap((entry) =>
      entry.kind === "tool" ? [entry.summary] : [],
    )
    expect(toolSummaries).toHaveLength(2)
    expect(toolSummaries[1]).toBe("src/index.ts")
    const commandSummary = toolSummaries[0] ?? ""
    expect(commandSummary.startsWith("pnpm test -- --run")).toBe(true)
    expect(commandSummary).toHaveLength(80)
    expect(commandSummary.endsWith("…")).toBe(true)
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
        event: {
          type: HistoryRecordType.ModelToolCall,
          data: {
            toolCallId: "tool_1",
            itemId: "item_1",
            turnId: "turn_1",
            name: "run_command",
            input: { command: "pnpm test" },
            requiresPermission: true,
          },
        },
      }),
    })
    expect(projectExecutionView(state, session).activeActivity).toEqual({
      kind: "running_tool",
      name: "run_command",
    })

    state = reduceExecutionView(state, {
      type: "durable",
      event: createExecutionEnvelope({
        sessionId,
        seq: 3,
        event: {
          type: EventType.PermissionRequested,
          data: {
            permissionRequestId: "permission_1",
            turnId: "turn_1",
            toolCallId: "tool_1",
            action: "run_command",
          },
        },
      }),
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
  const { event } = input
  if (event.type === HistoryRecordType.AgentMessage) {
    return createEventEnvelope({
      ...input,
      event: {
        type: EventType.ItemCompleted,
        data: {
          turnId: event.data.turnId,
          item: {
            type: "agent_message",
            itemId: event.data.messageId,
            content: event.data.content,
            ...(typeof event.data.providerMetadata?.streamId === "string"
              ? { streamId: event.data.providerMetadata.streamId }
              : {}),
          },
        },
      },
    })
  }
  if (event.type === HistoryRecordType.ModelToolCall) {
    return createEventEnvelope({
      ...input,
      event: {
        type: EventType.ItemStarted,
        data: {
          turnId: event.data.turnId,
          item: {
            type: toolExecutionType(event.data.name),
            itemId: event.data.itemId,
            toolCallId: event.data.toolCallId,
            name: event.data.name,
            input: event.data.input,
            requiresPermission: event.data.requiresPermission,
          },
        },
      },
    })
  }
  if (event.type === HistoryRecordType.ModelToolResult) {
    return createEventEnvelope({
      ...input,
      event: {
        type: EventType.ItemCompleted,
        data: {
          turnId: event.data.turnId,
          item: {
            type: "tool_execution",
            itemId: `call:${event.data.toolCallId}`,
            toolCallId: event.data.toolCallId,
            name: "tool",
            input: {},
            requiresPermission: false,
            resultItemId: event.data.toolResultId,
            content: event.data.content,
            ...(event.data.output === undefined
              ? {}
              : { output: event.data.output }),
            ...(event.data.error === undefined
              ? {}
              : { error: event.data.error }),
          },
        },
      },
    })
  }
  return createEventEnvelope(input)
}

function activeSession(activeTurnId: string, seq: number) {
  return {
    id: sessionId,
    conversationId: "conversation_1",
    seq,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    activeTurnId,
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
