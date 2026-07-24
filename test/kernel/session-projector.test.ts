import { describe, expect, it } from "vitest"
import {
  applySessionFacts,
  createEventEnvelope,
  EventType,
  InputRole,
  projectSession,
  ToolState,
  TurnState,
} from "../../src/index.ts"
import { parseStoredEventEnvelope } from "../../src/kernel/event-store.ts"

describe("session fact projection", () => {
  it("returns no projection without a session.created fact", () => {
    expect(projectSession([])).toBeUndefined()
  })

  it("derives Items and Tools from coarse facts", () => {
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
          type: EventType.ToolCall,
          data: {
            toolCallId: "tool_1",
            itemId: "item_call",
            turnId: "turn_1",
            name: "read_file",
            input: { path: "README.md" },
            requiresPermission: false,
          },
        },
      }),
    ]

    const projection = projectSession(events)
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
        version: 1,
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
        version: 2,
        createdAt: "2026-07-24T00:00:00.000Z",
        type: "assistant.message",
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
        version: 1,
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
})

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
        type: EventType.ToolCall,
        data: {
          toolCallId: "tool_1",
          itemId: "item_call",
          turnId: "turn_1",
          name: "run_command",
          input: { command: "sleep 30" },
          requiresPermission: true,
        },
      },
    }),
    createEventEnvelope({
      sessionId,
      seq: 5,
      event: {
        type: EventType.TurnInterrupted,
        data: { turnId: "turn_1", reason: "restart" },
      },
    }),
  ]
}
