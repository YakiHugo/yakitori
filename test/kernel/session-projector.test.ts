import { describe, expect, it } from "vitest"
import { parseStoredEventEnvelope } from "../../src/kernel/event-store.ts"
import {
  createEventEnvelope,
  EventType,
  HistoryRecordType,
  InputRole,
} from "../../src/kernel/events.ts"
import {
  applySessionFacts,
  projectSession,
} from "../../src/kernel/session-projector.ts"
import { ToolState, TurnState } from "../../src/kernel/session-states.ts"

describe("session fact projection", () => {
  it("returns no projection without a session.created fact", () => {
    expect(projectSession([])).toBeUndefined()
  })

  it("derives Items and Tools from execution-item facts", () => {
    const projection = projectSession(baseWithStartedTool())
    expect(projection?.activeTurn?.state).toBe(TurnState.Started)
    expect(projection?.tools).toEqual([
      expect.objectContaining({
        toolCallId: "tool_1",
        state: ToolState.Requested,
        requestItemId: "item_call",
      }),
    ])
    expect(projection?.items).toEqual([
      expect.objectContaining({ itemId: "item_call", kind: "tool_call" }),
    ])
  })

  it("rejects a completed tool fact that changes the started execution", () => {
    const sessionId = "session_00000000-0000-4000-8000-000000000000"
    const events = [
      ...baseWithStartedTool(),
      createEventEnvelope({
        sessionId,
        seq: 5,
        event: {
          type: EventType.ItemCompleted,
          data: {
            turnId: "turn_1",
            item: {
              type: "file_change",
              itemId: "item_call",
              toolCallId: "tool_1",
              name: "run_command",
              input: { command: "sleep 30" },
              requiresPermission: true,
              request: { operation: "edit", paths: ["README.md"] },
              changes: [],
              resultItemId: "item_result",
              content: { kind: "text", text: "changed" },
            },
          },
        },
      }),
    ]

    expect(() => projectSession(events)).toThrow(
      "Tool completion tool_1 changed execution semantics.",
    )
  })

  it("rejects orphaned and duplicate execution-item identities", () => {
    const sessionId = "session_00000000-0000-4000-8000-000000000000"
    const orphanedStart = [
      createEventEnvelope({
        sessionId,
        seq: 1,
        event: { type: EventType.SessionCreated, data: {} },
      }),
      createEventEnvelope({
        sessionId,
        seq: 2,
        event: {
          type: EventType.ItemStarted,
          data: {
            turnId: "turn_missing",
            item: {
              type: "file_read",
              itemId: "item_call",
              toolCallId: "tool_1",
              name: "read_file",
              input: { path: "README.md" },
              requiresPermission: false,
              path: "README.md",
            },
          },
        },
      }),
    ]
    expect(() => projectSession(orphanedStart)).toThrow(
      "Tool start tool_1 has no matching Turn.",
    )

    const duplicateAssistantItem = createEventEnvelope({
      sessionId,
      seq: 6,
      event: {
        type: EventType.ItemCompleted,
        data: {
          turnId: "turn_1",
          item: {
            type: "agent_message",
            itemId: "item_call",
            content: [{ type: "text", text: "duplicate" }],
          },
        },
      },
    })
    expect(() =>
      projectSession([...baseWithInterruptedTool(), duplicateAssistantItem]),
    ).toThrow("Item item_call completion does not match its start.")

    const duplicateToolCall = createEventEnvelope({
      sessionId,
      seq: 5,
      event: {
        type: EventType.ItemStarted,
        data: {
          turnId: "turn_1",
          item: {
            type: "file_read",
            itemId: "item_second_call",
            toolCallId: "tool_1",
            name: "read_file",
            input: { path: "README.md" },
            requiresPermission: false,
            path: "README.md",
          },
        },
      },
    })
    expect(() =>
      projectSession([...baseWithStartedTool(), duplicateToolCall]),
    ).toThrow("Tool call ID tool_1 is not unique.")

    const started = baseWithStartedTool()
    const duplicateResultItem = createEventEnvelope({
      sessionId,
      seq: 5,
      event: {
        type: EventType.ItemCompleted,
        data: {
          turnId: "turn_1",
          item: {
            type: "command_execution",
            itemId: "item_call",
            toolCallId: "tool_1",
            name: "run_command",
            input: { command: "sleep 30" },
            requiresPermission: true,
            command: "sleep 30",
            resultItemId: "item_call",
            content: { kind: "text", text: "done" },
          },
        },
      },
    })
    expect(() => projectSession([...started, duplicateResultItem])).toThrow(
      "Item ID item_call is not unique.",
    )
  })

  it("keeps a result-less tool call as honest open history", () => {
    const projection = projectSession(baseWithInterruptedTool())
    expect(projection?.turns[0]).toMatchObject({
      state: TurnState.Interrupted,
    })
    expect(projection?.tools[0]).toMatchObject({
      state: ToolState.Requested,
    })
    expect(projection?.tools[0]?.resultItemId).toBeUndefined()
  })

  it("skips and preserves unknown event types without refusing history", () => {
    const events = baseWithInterruptedTool()
    const unknown = parseStoredEventEnvelope(
      JSON.stringify({
        id: "event_unknown",
        sessionId: events[0]?.sessionId,
        seq: 6,
        version: 5,
        createdAt: "2026-07-24T00:00:00.000Z",
        type: "provider.future_fact",
        data: { value: "opaque" },
      }),
      6,
    )
    const projection = projectSession([...events, unknown])

    expect(unknown).toMatchObject({
      type: "provider.future_fact",
      data: { value: "opaque" },
    })
    expect(projection?.seq).toBe(6)
    expect(projection?.turns[0]?.state).toBe(TurnState.Interrupted)
  })

  it("skips a known fact whose future payload is not understood", () => {
    const events = baseWithInterruptedTool()
    const future = parseStoredEventEnvelope(
      JSON.stringify({
        id: "event_future_payload",
        sessionId: events[0]?.sessionId,
        seq: 6,
        version: 5,
        createdAt: "2026-07-24T00:00:00.000Z",
        type: "provider.future",
        data: {
          messageId: "message_future",
          turnId: "turn_1",
          content: [{ type: "future_content", value: true }],
        },
      }),
      6,
    )

    const projection = projectSession([...events, future])
    expect(projection?.seq).toBe(6)
    expect(projection?.items).toHaveLength(1)
    expect(projection?.turns[0]?.state).toBe(TurnState.Interrupted)
  })

  it("keeps incremental apply and full rebuild equal across unknown facts", () => {
    const events = baseWithInterruptedTool()
    const unknown = parseStoredEventEnvelope(
      JSON.stringify({
        id: "event_unknown_incremental",
        sessionId: events[0]?.sessionId,
        seq: 6,
        version: 5,
        createdAt: "2026-07-24T00:00:00.000Z",
        type: "provider.future_fact",
        data: { value: "opaque" },
      }),
      6,
    )
    const prefix = projectSession(events.slice(0, 4))

    expect(applySessionFacts(prefix, [...events.slice(4), unknown])).toEqual(
      projectSession([...events, unknown]),
    )
  })

  it("keeps only the latest compaction checkpoint with cumulative coverage", () => {
    const events = baseWithCompactions()

    const projection = projectSession(events)
    expect(projection?.compaction).toEqual({
      compactionId: "compaction_2",
      turnId: "turn_2",
      throughSeq: 5,
      coveredTurnIds: ["turn_0", "turn_1"],
      summary: "second checkpoint",
      usage: { inputTokens: 12, outputTokens: 4 },
      replacement: testCompactionReplacement(2),
      createdAt: "2026-07-24T00:00:02.000Z",
    })
  })

  it("keeps incremental apply and full rebuild equal across compaction facts", () => {
    const events = baseWithCompactions()
    const prefix = projectSession(events.slice(0, 2))

    expect(applySessionFacts(prefix, events.slice(2))).toEqual(
      projectSession(events),
    )
  })

  it("folds world-state merge patches while preserving exact updates", () => {
    const sessionId = "session_00000000-0000-4000-8000-000000000000"
    const events = [
      createEventEnvelope({
        sessionId,
        seq: 1,
        event: { type: EventType.SessionCreated, data: {} },
      }),
      createEventEnvelope({
        sessionId,
        seq: 2,
        event: {
          type: HistoryRecordType.WorldState,
          data: {
            turnId: "turn_1",
            full: true,
            state: {
              environment: { revision: "environment_1" },
              "project.instructions": { revision: "project_1" },
            },
            fragments: [
              {
                id: "environment",
                revision: "environment_1",
                role: "user" as const,
                text: "environment one",
              },
            ],
          },
        },
      }),
      createEventEnvelope({
        sessionId,
        seq: 3,
        event: {
          type: HistoryRecordType.WorldState,
          data: {
            turnId: "turn_2",
            afterItemId: "item_2",
            full: false,
            state: {
              environment: { revision: "environment_2" },
              "project.instructions": null,
            },
            fragments: [
              {
                id: "environment",
                revision: "environment_2",
                role: "user" as const,
                text: "environment two",
              },
            ],
          },
        },
      }),
    ]

    const projection = projectSession(events)
    expect(projection?.worldState).toMatchObject({
      state: { environment: { revision: "environment_2" } },
      updatedSeq: 3,
    })
    expect(projection?.worldState?.state).not.toHaveProperty(
      "project.instructions",
    )
    expect(projection?.worldStateUpdates).toHaveLength(2)
    expect(projection?.worldStateUpdates[1]).toMatchObject({
      afterItemId: "item_2",
      fragments: [{ text: "environment two" }],
    })
    expect(
      applySessionFacts(projectSession(events.slice(0, 2)), events.slice(2)),
    ).toEqual(projection)
  })
})

function baseWithCompactions() {
  const sessionId = "session_00000000-0000-4000-8000-000000000000"
  return [
    createEventEnvelope({
      sessionId,
      seq: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      event: { type: EventType.SessionCreated, data: {} },
    }),
    createEventEnvelope({
      sessionId,
      seq: 2,
      createdAt: "2026-07-24T00:00:01.000Z",
      event: {
        type: EventType.ContextCompacted,
        data: {
          compactionId: "compaction_1",
          turnId: "turn_1",
          throughSeq: 1,
          coveredTurnIds: ["turn_0"],
          summary: "first checkpoint",
          replacement: testCompactionReplacement(1),
        },
      },
    }),
    createEventEnvelope({
      sessionId,
      seq: 3,
      createdAt: "2026-07-24T00:00:02.000Z",
      event: {
        type: EventType.ContextCompacted,
        data: {
          compactionId: "compaction_2",
          turnId: "turn_2",
          throughSeq: 5,
          coveredTurnIds: ["turn_0", "turn_1"],
          summary: "second checkpoint",
          usage: { inputTokens: 12, outputTokens: 4 },
          replacement: testCompactionReplacement(2),
        },
      },
    }),
  ]
}

function testCompactionReplacement(windowNumber: number) {
  return {
    windowId: `context_window_${windowNumber}`,
    firstWindowId: "context_window_1",
    ...(windowNumber === 1
      ? {}
      : { previousWindowId: `context_window_${windowNumber - 1}` }),
    windowNumber,
    history: [],
    worldStateBaseline: {},
  }
}

function baseWithInterruptedTool() {
  const sessionId = "session_00000000-0000-4000-8000-000000000000"
  return [
    createEventEnvelope({
      sessionId,
      seq: 1,
      event: { type: EventType.SessionCreated, data: {} },
    }),
    createEventEnvelope({
      sessionId,
      seq: 2,
      event: {
        type: EventType.InputAdmitted,
        data: {
          requestId: "request:1",
          inputId: "input_1",
          role: InputRole.User,
          content: { kind: "text", text: "work" },
        },
      },
    }),
    createEventEnvelope({
      sessionId,
      seq: 3,
      event: {
        type: EventType.TurnStarted,
        data: { turnId: "turn_1", inputId: "input_1" },
      },
    }),
    createEventEnvelope({
      sessionId,
      seq: 4,
      event: {
        type: EventType.ItemStarted,
        data: {
          turnId: "turn_1",
          item: {
            type: "command_execution",
            itemId: "item_call",
            toolCallId: "tool_1",
            name: "run_command",
            input: { command: "sleep 30" },
            requiresPermission: true,
            command: "sleep 30",
          },
        },
      },
    }),
    createEventEnvelope({
      sessionId,
      seq: 5,
      event: {
        type: EventType.TurnCompleted,
        data: {
          turnId: "turn_1",
          outcome: { status: "interrupted", reason: "restart" },
        },
      },
    }),
  ]
}

function baseWithStartedTool() {
  return baseWithInterruptedTool().slice(0, 4)
}
