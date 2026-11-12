import { describe, expect, it } from "vitest"
import type {
  ResponseItemEnvelope,
  StoredRolloutItem,
} from "../../src/core/rollout.ts"
import { turnInputSubmissionMetadata } from "../../src/core/turn-input-metadata.ts"
import {
  createUserInput,
  inputContentToModelMessage,
} from "../../src/core/user-input.ts"
import type { ModelMessage } from "../../src/kernel/events.ts"
import { mapRolloutEvent } from "../../src/server/session-event-projection.ts"

const threadId = "session_receiver"
const createdAt = "2026-11-12T00:00:00.000Z"
const provenance = {
  sourceThreadId: "session_sender",
  sourceRequestId: "request_sender",
}

function storedResponse(
  item: ResponseItemEnvelope,
  seq = 2,
): StoredRolloutItem {
  return {
    threadId,
    rolloutId: "rollout_receiver",
    seq,
    createdAt,
    item: { type: "response_item", item },
  }
}

describe("agent input event projection", () => {
  it.each([
    {
      action: "create_thread",
      inputId: "input_initial",
      turnId: "turn_initial",
      steered: false,
    },
    {
      action: "send_message_to_thread starting a turn",
      inputId: "input_followup",
      turnId: "turn_followup",
      steered: false,
    },
    {
      action: "send_message_to_thread steering an active turn",
      inputId: "message_followup",
      turnId: "turn_active",
      steered: true,
    },
  ])("projects $action from host metadata without exposing the security wrapper", ({
    inputId,
    turnId,
    steered,
  }) => {
    const content = createUserInput(
      'Review the task.\n{"body":"keep this text"}',
    )
    const input = {
      submissionId: "submission_task",
      content,
      source: "agent" as const,
      provenance,
    }
    const modelMessage = inputContentToModelMessage(
      content,
      undefined,
      provenance,
    )
    expect(modelMessage.role).toBe("developer")
    expect(modelMessage.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("untrusted data"),
    })
    const record = storedResponse({
      id: inputId,
      turnId,
      createdAt,
      item: modelMessage,
      ...turnInputSubmissionMetadata(input),
    })
    const originalRecord = structuredClone(record)

    const event = mapRolloutEvent(record, threadId)

    expect(event).toMatchObject({
      type: "input.admitted",
      sessionId: threadId,
      seq: 3,
      id: "event_session_receiver_rollout_receiver_2",
    })
    expect(event.data).toEqual({
      requestId: turnId,
      inputId,
      role: "runtime",
      content,
      source: "agent",
      provenance: {
        sourceThreadId: "session_sender",
        sourceRequestId: "request_sender",
      },
      ...(steered ? { steered: true } : {}),
    })
    expect(record).toEqual(originalRecord)
  })

  it.each([
    "input_subagent",
    "message_subagent",
  ])("preserves agent source on subagent user input %s", (inputId) => {
    const content = createUserInput("Implement the bounded subtask.")
    const modelSelection = { provider: "test", model: "test-model" }
    const record = storedResponse({
      id: inputId,
      turnId: "turn_subagent",
      createdAt,
      item: inputContentToModelMessage(content),
      ...turnInputSubmissionMetadata({
        submissionId: "submission_subagent",
        source: "agent",
        content,
        parentInputId: "input_parent",
        modelSelection,
        metadata: { taskName: "bounded_subtask" },
      }),
    })

    expect(mapRolloutEvent(record, threadId)).toMatchObject({
      type: "input.admitted",
      data: {
        requestId: "turn_subagent",
        inputId,
        role: "user",
        content,
        source: "agent",
        parentInputId: "input_parent",
        modelSelection,
        metadata: { taskName: "bounded_subtask" },
        ...(inputId.startsWith("message_") ? { steered: true } : {}),
      },
    })
  })

  it("keeps ordinary user content and optional host provenance intact", () => {
    const content = createUserInput("The authored input.")
    const record = storedResponse({
      id: "input_user",
      turnId: "turn_user",
      createdAt,
      item: { role: "user", content: [{ type: "text", text: "model text" }] },
      submissionMetadata: { content, source: "human", provenance },
    })

    expect(mapRolloutEvent(record, threadId).data).toEqual({
      requestId: "turn_user",
      inputId: "input_user",
      role: "user",
      content,
      source: "human",
      provenance,
    })
  })

  it("continues reconstructing legacy user input without inventing a source", () => {
    const record = storedResponse({
      id: "input_user",
      turnId: "turn_user",
      createdAt,
      item: {
        role: "user",
        content: [{ type: "text", text: "legacy user text" }],
      },
    })

    expect(mapRolloutEvent(record, threadId).data).toEqual({
      requestId: "turn_user",
      inputId: "input_user",
      role: "user",
      content: {
        kind: "input",
        text: "legacy user text",
        elements: [],
        attachments: [],
      },
    })
  })

  const hiddenMessages: readonly ModelMessage[] = [
    {
      role: "developer",
      content: [{ type: "text", text: "Ordinary developer instructions." }],
    },
    {
      role: "developer",
      content: [{ type: "text", text: "Continue working toward the goal." }],
      context: { type: "goal", goalId: "goal_current" },
    },
    {
      role: "developer",
      content: [{ type: "text", text: "Current runtime state." }],
      context: {
        type: "world_state",
        sectionId: "runtime",
        revision: "revision_current",
      },
    },
    {
      role: "user",
      content: [{ type: "text", text: "Injected skill instructions." }],
      context: { type: "skill_invocation", inputId: "input_owner" },
    },
    {
      role: "developer",
      content: [
        { type: "text", text: JSON.stringify({ ...provenance, body: "task" }) },
      ],
    },
  ]

  it.each(
    hiddenMessages,
  )("keeps contextual and ordinary developer instructions hidden: %j", (message) => {
    const record = storedResponse({
      id: "input_hidden",
      turnId: "turn_hidden",
      createdAt,
      item: message,
      submissionMetadata: {
        source: "agent",
        content: createUserInput(
          "Host metadata alone does not mark a thread message.",
        ),
        provenance,
      },
    })

    expect(mapRolloutEvent(record, threadId)).toMatchObject({
      type: "session.cursor",
      seq: 3,
      data: {},
    })
  })

  it("does not recover thread message display content by parsing model text", () => {
    const content = createUserInput("An external task.")
    const record = storedResponse({
      id: "input_missing_metadata",
      turnId: "turn_external",
      createdAt,
      item: inputContentToModelMessage(content, undefined, provenance),
    })

    expect(mapRolloutEvent(record, threadId)).toMatchObject({
      type: "session.cursor",
      data: {},
    })
  })
})
