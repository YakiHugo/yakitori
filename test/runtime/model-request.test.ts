import { describe, expect, it } from "vitest"
import {
  type ModelFailure,
  type ModelRequest,
  ModelStopReason,
  type ModelStreamEvent,
  type StreamFn,
} from "../../src/runtime/model.ts"
import { createModelRequestStream } from "../../src/runtime/model-request.ts"

describe("model request runtime", () => {
  it("retries a transient failure before visible output", async () => {
    const provider = scriptedStream([[failure("rate_limited")], [success]])
    const sleeps: number[] = []
    const stream = createModelRequestStream(provider.stream, {
      wireApi: "unknown",
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      random: () => 1,
    })

    expect(await collect(stream)).toEqual([
      expect.objectContaining({
        type: "retry",
        attempt: 1,
        nextAttempt: 2,
        delayMs: 500,
      }),
      success,
    ])
    expect(provider.calls()).toBe(2)
    expect(sleeps).toEqual([500])
  })

  it("does not retry after visible output", async () => {
    const terminalFailure = failure("stream_disconnected")
    const provider = scriptedStream([
      [{ type: "snapshot", text: "partial" }, terminalFailure],
      [success],
    ])
    const stream = createModelRequestStream(provider.stream, {
      wireApi: "unknown",
      sleep: async () => {},
    })

    expect(await collect(stream)).toEqual([
      { type: "snapshot", text: "partial" },
      expect.objectContaining({
        type: "failure",
        failure: expect.objectContaining({
          kind: "stream_disconnected",
          attempt: 1,
          outputObserved: true,
          retryDecision: "fail",
        }),
      }),
    ])
    expect(provider.calls()).toBe(1)
  })

  it("classifies a clean EOF as a retryable disconnect", async () => {
    const provider = scriptedStream([[], [success]])
    const stream = createModelRequestStream(provider.stream, {
      wireApi: "unknown",
      sleep: async () => {},
      random: () => 0,
    })

    const events = await collect(stream)

    expect(events[0]).toMatchObject({
      type: "retry",
      failure: { kind: "stream_disconnected", stage: "response_body" },
    })
    expect(events[1]).toEqual(success)
  })

  it("normalizes a thrown undici termination without exposing its text", async () => {
    const provider = scriptedThrow(new Error("terminated"))
    const stream = createModelRequestStream(provider, {
      wireApi: "openai_responses",
      maxAttempts: 1,
    })

    expect(await collect(stream)).toEqual([
      expect.objectContaining({
        type: "failure",
        failure: expect.objectContaining({
          kind: "stream_disconnected",
          message: "The model response stream disconnected before completion.",
        }),
      }),
    ])
  })

  it("normalizes a synchronous transport construction failure", async () => {
    const stream = createModelRequestStream(
      () => {
        throw new Error("terminated")
      },
      { wireApi: "openai_responses", maxAttempts: 1 },
    )

    expect(await collect(stream)).toEqual([
      expect.objectContaining({
        type: "failure",
        failure: expect.objectContaining({
          kind: "connection_failed",
          message: "Could not connect to the model provider.",
        }),
      }),
    ])
  })

  it("times out a half-open attempt and aborts its transport", async () => {
    let transportAborted = false
    const halfOpen: StreamFn = async function* (request) {
      await new Promise<void>((resolve) => {
        request.signal?.addEventListener(
          "abort",
          () => {
            transportAborted = true
            resolve()
          },
          { once: true },
        )
      })
    }
    const stream = createModelRequestStream(halfOpen, {
      wireApi: "unknown",
      maxAttempts: 1,
      streamIdleTimeoutMs: 5,
    })

    expect(await collect(stream)).toEqual([
      expect.objectContaining({
        type: "failure",
        failure: expect.objectContaining({ kind: "idle_timeout" }),
      }),
    ])
    expect(transportAborted).toBe(true)
  })

  it("reports cancellation only when the caller aborts", async () => {
    const controller = new AbortController()
    const stream = createModelRequestStream(
      async function* (request) {
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          })
        })
      },
      { wireApi: "unknown" },
    )
    const collecting = collect(stream, controller.signal)
    controller.abort()

    expect(await collecting).toEqual([{ type: "cancelled" }])
  })

  it("rejects events after a terminal response", async () => {
    const provider = scriptedStream([[success, success]])
    const stream = createModelRequestStream(provider.stream, {
      wireApi: "unknown",
      maxAttempts: 1,
    })

    expect(await collect(stream)).toEqual([
      expect.objectContaining({
        type: "failure",
        failure: expect.objectContaining({
          kind: "protocol_error",
          retryDecision: "fail",
        }),
      }),
    ])
  })

  it("awaits provider cleanup when the consumer ends early", async () => {
    let closed = false
    const stream = createModelRequestStream(
      async function* () {
        try {
          yield { type: "snapshot", text: "partial" }
          await new Promise(() => {})
        } finally {
          await Promise.resolve()
          closed = true
        }
      },
      { wireApi: "unknown" },
    )
    const iterator = stream(requestFixture())[Symbol.asyncIterator]()

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: "snapshot", text: "partial" },
    })
    await iterator.return?.()

    expect(closed).toBe(true)
  })

  it("reports the effective rate-limit attempt budget", async () => {
    const provider = scriptedStream([
      [failure("rate_limited")],
      [failure("rate_limited")],
    ])
    const stream = createModelRequestStream(provider.stream, {
      wireApi: "unknown",
      maxAttempts: 4,
      rateLimitMaxAttempts: 2,
      sleep: async () => {},
    })

    expect(await collect(stream)).toEqual([
      expect.objectContaining({ type: "retry", maxAttempts: 2 }),
      expect.objectContaining({
        type: "failure",
        failure: expect.objectContaining({
          attempt: 2,
          maxAttempts: 2,
          retryDecision: "fail",
        }),
      }),
    ])
  })

  it("rejects delays above the Node timer implementation boundary", () => {
    expect(() =>
      createModelRequestStream(async function* () {}, {
        wireApi: "unknown",
        streamIdleTimeoutMs: 2_147_483_648,
      }),
    ).toThrow("streamIdleTimeoutMs must be at most 2147483647")
    expect(() =>
      createModelRequestStream(async function* () {}, {
        wireApi: "unknown",
        baseDelayMs: Number.POSITIVE_INFINITY,
      }),
    ).toThrow("Retry delays must be finite")
  })
})

const success: ModelStreamEvent = {
  type: "response",
  response: {
    stopReason: ModelStopReason.EndTurn,
    content: [{ type: "text", text: "done" }],
  },
}

function failure(kind: ModelFailure["kind"]): ModelStreamEvent {
  return {
    type: "failure",
    failure: {
      kind,
      stage: "response_body",
      provider: "test",
      wireApi: "unknown",
      message: `failure: ${kind}`,
    },
  }
}

function scriptedStream(attempts: readonly (readonly ModelStreamEvent[])[]) {
  let callCount = 0
  const stream: StreamFn = () => {
    const attempt = attempts[callCount]
    callCount += 1
    if (attempt === undefined) throw new Error("Missing scripted attempt.")
    return (async function* () {
      yield* attempt
    })()
  }
  return { stream, calls: () => callCount }
}

function scriptedThrow(error: unknown): StreamFn {
  return () => ({
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.reject(error),
      }
    },
  })
}

async function collect(
  stream: StreamFn,
  signal?: AbortSignal,
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = []
  for await (const event of stream(requestFixture(signal))) events.push(event)
  return events
}

function requestFixture(signal?: AbortSignal): ModelRequest {
  return {
    target: {
      provider: "test",
      model: "test-model",
      instructionProfileId: "default",
    },
    system: [],
    messages: [],
    tools: [],
    toolWireProtocol: "eager",
    ...(signal === undefined ? {} : { signal }),
  }
}
