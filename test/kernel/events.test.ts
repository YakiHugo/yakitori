import { describe, expect, it } from "vitest"
import {
  createEventEnvelope,
  createInputId,
  createItemId,
  createPermissionRequestId,
  createSessionId,
  createToolCallId,
  createTurnId,
  EventType,
  IdPrefix,
  InputRole,
  isIdWithPrefix,
  ItemKind,
  ItemStatus,
  PermissionBehavior,
  type KernelEvent,
} from "../../src/index.ts"

describe("kernel ids", () => {
  it("creates branded ids with readable prefixes", () => {
    expect(isIdWithPrefix(createSessionId(), IdPrefix.Session)).toBe(true)
    expect(isIdWithPrefix(createInputId(), IdPrefix.Input)).toBe(true)
    expect(isIdWithPrefix(createTurnId(), IdPrefix.Turn)).toBe(true)
    expect(isIdWithPrefix(createItemId(), IdPrefix.Item)).toBe(true)
    expect(isIdWithPrefix(createToolCallId(), IdPrefix.ToolCall)).toBe(true)
    expect(
      isIdWithPrefix(
        createPermissionRequestId(),
        IdPrefix.PermissionRequest,
      ),
    ).toBe(true)
  })
})

describe("kernel events", () => {
  it("wraps a kernel event in a durable envelope", () => {
    const sessionId = createSessionId()
    const inputId = createInputId()
    const event = {
      type: EventType.InputAdmitted,
      data: {
        inputId,
        role: InputRole.User,
        content: {
          kind: "text",
          text: "start the kernel",
        },
      },
    } satisfies KernelEvent

    const envelope = createEventEnvelope({
      sessionId,
      seq: 1,
      event,
      createdAt: "2026-07-06T00:00:00.000Z",
    })

    expect(isIdWithPrefix(envelope.id, IdPrefix.Event)).toBe(true)
    expect(envelope).toMatchObject({
      sessionId,
      seq: 1,
      version: 1,
      type: EventType.InputAdmitted,
      createdAt: "2026-07-06T00:00:00.000Z",
      data: event.data,
    })
  })

  it("rejects non-positive event sequence numbers", () => {
    const sessionId = createSessionId()
    const event = {
      type: EventType.SessionCreated,
      data: {
        title: "Yakitori",
      },
    } satisfies KernelEvent

    expect(() =>
      createEventEnvelope({
        sessionId,
        seq: 0,
        event,
      }),
    ).toThrow(RangeError)
  })

  it("rejects non-positive event versions", () => {
    const sessionId = createSessionId()
    const event = {
      type: EventType.SessionCreated,
      data: {
        title: "Yakitori",
      },
    } satisfies KernelEvent

    expect(() =>
      createEventEnvelope({
        sessionId,
        seq: 1,
        version: 0,
        event,
      }),
    ).toThrow(RangeError)
  })

  it("keeps event data narrowed by event type in event consumers", () => {
    const sessionId = createSessionId()
    const turnId = createTurnId()
    const itemId = createItemId()
    const toolCallId = createToolCallId()
    const permissionRequestId = createPermissionRequestId()
    const toolCompletedEvent = {
      type: EventType.ToolCompleted,
      data: {
        toolCallId,
        turnId,
        output: {
          ok: true,
          files: 3,
        },
      },
    } satisfies KernelEvent
    const events: KernelEvent[] = [
      {
        type: EventType.ItemAppended,
        data: {
          itemId,
          turnId,
          kind: ItemKind.AssistantMessage,
          status: ItemStatus.InProgress,
          content: {
            kind: "text",
            text: "I will inspect the repo.",
          },
        },
      },
      {
        type: EventType.PermissionResolved,
        data: {
          permissionRequestId,
          turnId,
          behavior: PermissionBehavior.Allow,
        },
      },
      toolCompletedEvent,
    ]

    const descriptions = events.map(describeEvent)
    const envelope = createEventEnvelope({
      sessionId,
      seq: 2,
      event: toolCompletedEvent,
    })

    expect(descriptions).toEqual([
      "item:assistant_message",
      "permission:allow",
      "tool:{\"ok\":true,\"files\":3}",
    ])
    expect(envelope.type).toBe(EventType.ToolCompleted)
    expect(envelope.data).toEqual(toolCompletedEvent.data)
  })
})

function describeEvent(event: KernelEvent): string {
  switch (event.type) {
    case EventType.ItemAppended:
      return `item:${event.data.kind}`
    case EventType.PermissionResolved:
      return `permission:${event.data.behavior}`
    case EventType.ToolCompleted:
      return `tool:${JSON.stringify(event.data.output)}`
    default:
      return event.type
  }
}
