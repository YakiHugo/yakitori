import { describe, expect, it } from "vitest"
import { isKernelEvent } from "../../src/kernel/events.ts"
import {
  isInputAdmittedEvent,
  isTurnCompletedEvent,
} from "../../src/protocol/event-validation.ts"

const admitted = {
  type: "input.admitted",
  data: {
    requestId: "request_1",
    inputId: "input_1",
    role: "user",
    content: { kind: "input", text: "hello", elements: [], attachments: [] },
  },
}
const completed = {
  type: "turn.completed",
  data: {
    turnId: "turn_1",
    outcome: { status: "completed", answerItemIds: ["item_1"] },
  },
}

describe("application admission and completion validation", () => {
  it("accepts valid app facts through both the renderer and native boundaries", () => {
    expect(isInputAdmittedEvent(admitted)).toBe(true)
    expect(isTurnCompletedEvent(completed)).toBe(true)
    expect(isKernelEvent(admitted)).toBe(true)
    expect(isKernelEvent(completed)).toBe(true)
    expect(isInputAdmittedEvent(completed)).toBe(false)
    expect(isTurnCompletedEvent(admitted)).toBe(false)
  })

  it.each([
    { role: "unknown" },
    { requestId: 4 },
    { parentInputId: null },
    { metadata: { bad: Number.NaN } },
    { modelSelection: { provider: "p", model: "" } },
    { steered: false },
    { unknownField: true },
    {
      content: {
        kind: "input",
        text: "a",
        elements: [{ startOffset: 0, endOffset: 2, attachmentIndex: 0 }],
        attachments: [],
      },
    },
  ])("rejects malformed admission data at both boundaries: %j", (patch) => {
    const event = { ...admitted, data: { ...admitted.data, ...patch } }
    expect(isInputAdmittedEvent(event)).toBe(false)
    expect(isKernelEvent(event)).toBe(false)
  })

  it.each([
    { turnId: 1 },
    { outcome: { status: "completed", answerItemIds: ["same", "same"] } },
    {
      outcome: {
        status: "failed",
        error: { message: "bad", details: { value: Infinity } },
      },
    },
    { usage: { inputTokens: -1, outputTokens: 0 } },
    { sessionUsage: { inputTokens: 1, outputTokens: 1, extra: true } },
    {
      metrics: {
        modelCalls: 0,
        toolCalls: 0,
        modelDurationMs: 0,
        toolDurationMs: 0,
        latency: {},
      },
    },
    { metadata: [] },
    { unknownField: true },
  ])("rejects malformed completion data at both boundaries: %j", (patch) => {
    const event = { ...completed, data: { ...completed.data, ...patch } }
    expect(isTurnCompletedEvent(event)).toBe(false)
    expect(isKernelEvent(event)).toBe(false)
  })

  it("treats cyclic non-wire metadata as invalid instead of throwing", () => {
    const metadata: Record<string, unknown> = {}
    metadata.self = metadata
    expect(
      isInputAdmittedEvent({
        ...admitted,
        data: { ...admitted.data, metadata },
      }),
    ).toBe(false)
    expect(
      isTurnCompletedEvent({
        ...completed,
        data: { ...completed.data, metadata },
      }),
    ).toBe(false)
  })
})
