import { describe, expect, it } from "vitest"
import {
  createEventEnvelope,
  createRuntimeLimits,
  EventType,
  InputRole,
  isKernelEvent,
} from "../../src/index.ts"

describe("kernel facts", () => {
  it("contains exactly the coarse witness vocabulary", () => {
    expect(Object.values(EventType)).toEqual([
      "session.created",
      "session.configured",
      "input.admitted",
      "input.cancelled",
      "turn.started",
      "turn.completed",
      "turn.failed",
      "turn.cancelled",
      "turn.interrupted",
      "assistant.message",
      "tool.call",
      "tool.result",
      "permission.requested",
      "permission.resolved",
      "world_state.updated",
      "context_window.seeded",
      "context.compacted",
    ])
  })

  it("creates a versioned envelope for a valid fact", () => {
    const envelope = createEventEnvelope({
      sessionId: "session_00000000-0000-4000-8000-000000000000",
      seq: 1,
      event: { type: EventType.SessionCreated, data: { title: "Witness" } },
    })

    expect(envelope).toMatchObject({
      sessionId: "session_00000000-0000-4000-8000-000000000000",
      seq: 1,
      version: 1,
      type: EventType.SessionCreated,
      data: { title: "Witness" },
    })
  })

  it("recognizes a persisted session configuration snapshot", () => {
    expect(
      isKernelEvent({
        type: EventType.SessionConfigured,
        data: {
          configuration: {
            schemaVersion: 1,
            workspaceRoot: "/workspace",
            defaultTarget: { provider: "codex", model: "gpt-5.6-sol" },
            baseInstructions: {
              text: "instructions",
              revision: "revision_1",
              provenance: {
                type: "model",
                provider: "codex",
                model: "gpt-5.6-sol",
                promptId: "gpt",
              },
            },
            enabledTools: ["read_file"],
            approvalPolicy: "never",
            runtimeLimits: createRuntimeLimits(),
          },
        },
      }),
    ).toBe(true)
  })

  it("accepts schema v1 snapshots written before a runtime limit existed", () => {
    const runtimeLimits = createRuntimeLimits()
    const { compactionRetainRatio: _removed, ...legacyRuntimeLimits } =
      runtimeLimits

    expect(
      isKernelEvent({
        type: EventType.SessionConfigured,
        data: {
          configuration: {
            schemaVersion: 1,
            workspaceRoot: "/workspace",
            defaultTarget: { provider: "codex", model: "gpt-5.6-sol" },
            baseInstructions: {
              text: "instructions",
              revision: "revision_1",
              provenance: {
                type: "model",
                provider: "codex",
                model: "gpt-5.6-sol",
                promptId: "gpt",
              },
            },
            enabledTools: ["read_file"],
            approvalPolicy: "never",
            runtimeLimits: legacyRuntimeLimits,
          },
        },
      }),
    ).toBe(true)
  })

  it("strictly rejects malformed known facts at write time", () => {
    expect(() =>
      createEventEnvelope({
        sessionId: "session_00000000-0000-4000-8000-000000000000",
        seq: 1,
        event: {
          type: EventType.InputAdmitted,
          data: {
            requestId: "request-1",
            inputId: "input_1",
            role: InputRole.User,
            content: { kind: "text", text: "hello" },
            extra: true,
          },
        } as never,
      }),
    ).toThrow("Invalid event data")
  })

  it("accepts Session image references and rejects inline image data", () => {
    const event = (attachment: unknown) =>
      isKernelEvent({
        type: EventType.InputAdmitted,
        data: {
          requestId: "request-1",
          inputId: "input_1",
          role: InputRole.User,
          content: { kind: "text", text: "image", attachments: [attachment] },
        },
      })

    expect(
      event({
        name: "screen.png",
        mediaType: "image/png",
        sizeBytes: 5,
        file: {
          sessionId: "session_00000000-0000-4000-8000-000000000000",
          path: "attachments/request-1/1.png",
        },
      }),
    ).toBe(true)
    expect(
      event({
        name: "inline.png",
        mediaType: "image/png",
        sizeBytes: 5,
        data: "aGVsbG8=",
      }),
    ).toBe(false)
    expect(
      event({
        name: "invalid.png",
        mediaType: "image/png",
        sizeBytes: 5,
        data: "aGVsbG8=",
        file: { sessionId: "session_bad", path: "image.png" },
      }),
    ).toBe(false)
  })

  it("accepts modelSelection with effort/speed and rejects malformed ones", () => {
    const admitted = (modelSelection: unknown) =>
      isKernelEvent({
        type: EventType.InputAdmitted,
        data: {
          requestId: "request-1",
          inputId: "input_1",
          role: InputRole.User,
          content: { kind: "text", text: "hello" },
          modelSelection,
        },
      })

    expect(admitted({ provider: "openai", model: "gpt-5.1-codex" })).toBe(true)
    expect(
      admitted({ provider: "openai", model: "gpt-5.1-codex", effort: "high" }),
    ).toBe(true)
    expect(
      admitted({
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        speed: "fast",
      }),
    ).toBe(true)
    expect(admitted({ provider: "openai", model: "" })).toBe(false)
    expect(admitted({ provider: "", model: "gpt-5.1-codex" })).toBe(false)
    expect(
      admitted({ provider: "openai", model: "gpt-5.1-codex", effort: "" }),
    ).toBe(false)
    expect(
      admitted({ provider: "codex", model: "gpt-5.6-sol", speed: "" }),
    ).toBe(false)
    expect(
      admitted({ provider: "codex", model: "gpt-5.6-sol", speed: 2 }),
    ).toBe(false)
    expect(
      admitted({ provider: "openai", model: "gpt-5.1-codex", effort: 3 }),
    ).toBe(false)
    expect(
      admitted({ provider: "openai", model: "gpt-5.1-codex", extra: true }),
    ).toBe(false)
  })

  it("accepts backward-compatible Turn execution configuration fields", () => {
    const started = (executionContext: Record<string, unknown>) =>
      isKernelEvent({
        type: EventType.TurnStarted,
        data: {
          turnId: "turn_1",
          inputId: "input_1",
          executionContext: {
            mateId: "mate_1",
            mateRevisionId: "revision_1",
            provider: "openai",
            model: "gpt-5.1-codex",
            workingDirectory: "/p/a",
            enabledTools: [],
            approvalPolicy: "on-request",
            limits: {
              modelCallsPerTurn: 1,
              toolCallsPerTurn: 1,
              modelVisibleMessageBlocks: 1,
              modelVisibleContextBytes: 1,
              modelVisibleToolResultBytes: 1,
              modelVisibleToolResultLines: 1,
              assistantResponseBytes: 1,
            },
            ...executionContext,
          },
        },
      })

    // Facts written before prompt attribution and effort/speed existed
    // must still validate.
    expect(started({})).toBe(true)
    expect(started({ promptId: "gpt" })).toBe(true)
    expect(
      started({
        promptId: "gpt",
        baseInstructionsRevision: "base@1",
        modelInstructionsRevision: "gpt@1",
        modelContextWindowTokens: 272_000,
        effectiveModelContextWindowTokens: 258_400,
      }),
    ).toBe(true)
    expect(started({ promptId: 1 })).toBe(false)
    expect(started({ promptRevision: 1 })).toBe(false)
    expect(started({ baseInstructionsRevision: 1 })).toBe(false)
    expect(started({ modelInstructionsRevision: 1 })).toBe(false)
    expect(started({ modelContextWindowTokens: 0 })).toBe(false)
    expect(
      started({
        modelContextWindowTokens: 100,
        effectiveModelContextWindowTokens: 101,
      }),
    ).toBe(false)
    expect(started({ effort: "low" })).toBe(true)
    expect(started({ effort: "low", speed: "fast" })).toBe(true)
    expect(
      started({
        limits: {
          modelCallsPerTurn: 1,
          toolCallsPerTurn: 1,
          modelVisibleMessageBlocks: 1,
          modelVisibleContextBytes: 100,
          compactionTriggerContextBytes: 80,
          compactionRetainContextBytes: 16,
          modelVisibleToolResultBytes: 1,
          modelVisibleToolResultLines: 1,
          assistantResponseBytes: 1,
        },
      }),
    ).toBe(true)
    expect(
      started({
        limits: {
          modelCallsPerTurn: 1,
          toolCallsPerTurn: 1,
          modelVisibleMessageBlocks: 1,
          modelVisibleContextBytes: 100,
          compactionTriggerContextBytes: 80,
          compactionRetainContextBytes: 80,
          modelVisibleToolResultBytes: 1,
          modelVisibleToolResultLines: 1,
          assistantResponseBytes: 1,
        },
      }),
    ).toBe(false)
    expect(started({ effort: 1 })).toBe(false)
    expect(started({ speed: 2 })).toBe(false)
  })

  it("recognizes valid tool facts", () => {
    expect(
      isKernelEvent({
        type: EventType.ToolCall,
        data: {
          toolCallId: "tool_1",
          itemId: "item_1",
          turnId: "turn_1",
          name: "read_file",
          input: { path: "README.md" },
          requiresPermission: false,
        },
      }),
    ).toBe(true)
  })

  it("recognizes a valid context.compacted fact", () => {
    expect(
      isKernelEvent({
        type: EventType.ContextCompacted,
        data: {
          compactionId: "compaction_1",
          turnId: "turn_1",
          throughSeq: 7,
          coveredTurnIds: ["turn_0"],
          summary: "Goal: ship it.",
          usage: { inputTokens: 10, outputTokens: 5 },
          replacement: {
            windowId: "context_window_2",
            firstWindowId: "context_window_1",
            previousWindowId: "context_window_1",
            windowNumber: 2,
            history: [
              {
                role: "developer",
                content: [{ type: "text", text: "current state" }],
                context: {
                  type: "world_state",
                  sectionId: "environment",
                  revision: "revision_1",
                },
              },
              {
                role: "user",
                content: [{ type: "text", text: "Goal: ship it." }],
              },
            ],
            worldStateBaseline: { environment: { cwd: "/workspace" } },
          },
        },
      }),
    ).toBe(true)
  })

  it("recognizes a durable inherited context window", () => {
    expect(
      isKernelEvent({
        type: EventType.ContextWindowSeeded,
        data: {
          windowId: "context_window_1",
          sourceSessionId: "session_parent",
          history: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_call",
                  id: "call_1",
                  name: "read_file",
                  input: { path: "README.md" },
                },
              ],
            },
            {
              role: "tool",
              toolCallId: "call_1",
              content: "hello",
            },
          ],
          worldStateBaseline: { environment: { cwd: "/workspace" } },
        },
      }),
    ).toBe(true)
  })

  it("rejects inline images in a durable inherited context window", () => {
    expect(
      isKernelEvent({
        type: EventType.ContextWindowSeeded,
        data: {
          windowId: "context_window_1",
          sourceSessionId: "session_parent",
          history: [
            {
              role: "user",
              content: [{ type: "text", text: "inspect" }],
              images: [
                {
                  type: "image",
                  mediaType: "image/png",
                  data: "aGVsbG8=",
                },
              ],
            },
          ],
        },
      }),
    ).toBe(false)
  })

  it("recognizes a strict world_state.updated fact", () => {
    const event = {
      type: EventType.WorldStateUpdated,
      data: {
        turnId: "turn_1",
        afterItemId: "item_1",
        full: false,
        state: { "project.instructions": null },
        fragments: [
          {
            id: "project.instructions",
            revision: "revision_removed",
            role: "user",
            text: "instructions removed",
          },
        ],
      },
    }

    expect(isKernelEvent(event)).toBe(true)
    expect(
      isKernelEvent({
        ...event,
        data: { ...event.data, fragments: [] },
      }),
    ).toBe(true)
    expect(
      isKernelEvent({
        ...event,
        data: {
          ...event.data,
          fragments: [{ ...event.data.fragments[0], role: "system" }],
        },
      }),
    ).toBe(false)
  })

  it.each([
    {
      name: "an extra key",
      data: {
        compactionId: "compaction_1",
        turnId: "turn_1",
        throughSeq: 7,
        coveredTurnIds: ["turn_0"],
        summary: "Goal: ship it.",
        model: "faux-1",
      },
    },
    {
      name: "a missing key",
      data: {
        compactionId: "compaction_1",
        turnId: "turn_1",
        coveredTurnIds: ["turn_0"],
        summary: "Goal: ship it.",
      },
    },
    {
      name: "throughSeq of zero",
      data: {
        compactionId: "compaction_1",
        turnId: "turn_1",
        throughSeq: 0,
        coveredTurnIds: ["turn_0"],
        summary: "Goal: ship it.",
      },
    },
    {
      name: "a non-string covered turn id",
      data: {
        compactionId: "compaction_1",
        turnId: "turn_1",
        throughSeq: 7,
        coveredTurnIds: ["turn_0", 42],
        summary: "Goal: ship it.",
      },
    },
  ])("rejects context.compacted with $name", ({ data }) => {
    expect(
      isKernelEvent({
        type: EventType.ContextCompacted,
        data,
      }),
    ).toBe(false)
  })
})
