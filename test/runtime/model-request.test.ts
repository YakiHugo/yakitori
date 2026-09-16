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

  it.each([
    ["snapshot", "stream_disconnected"],
    ["reasoning_snapshot", "stream_disconnected"],
    ["snapshot", "idle_timeout"],
    ["reasoning_snapshot", "idle_timeout"],
  ] as const)("does not retry %s output followed by %s", async (type, kind) => {
    const terminalFailure = failure(kind)
    const provider = scriptedStream([
      [{ type, text: "partial" }, terminalFailure],
      [success],
    ])
    const stream = createModelRequestStream(provider.stream, {
      wireApi: "unknown",
      sleep: async () => {},
    })

    expect(await collect(stream)).toEqual([
      { type, text: "partial" },
      expect.objectContaining({
        type: "failure",
        failure: expect.objectContaining({
          kind,
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

  it("aborts a stalled transport and recovers before visible output", async () => {
    let transportAborted = false
    let attempts = 0
    const halfOpen: StreamFn = async function* (request) {
      if (++attempts === 2) {
        expect(transportAborted).toBe(true)
        yield success
        return
      }
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
      maxAttempts: 2,
      streamIdleTimeoutMs: 5,
      sleep: async () => {},
    })

    expect(await collect(stream)).toEqual([
      expect.objectContaining({
        type: "retry",
        failure: expect.objectContaining({
          kind: "idle_timeout",
          outputObserved: false,
        }),
      }),
      success,
    ])
    expect(transportAborted).toBe(true)
    expect(attempts).toBe(2)
  })

  it("stops repeated idle timeouts at the request attempt budget", async () => {
    const provider = scriptedStream([
      [failure("idle_timeout")],
      [failure("idle_timeout")],
      [success],
    ])
    const stream = createModelRequestStream(provider.stream, {
      wireApi: "unknown",
      maxAttempts: 2,
      sleep: async () => {},
    })

    expect(await collect(stream)).toEqual([
      expect.objectContaining({ type: "retry", nextAttempt: 2 }),
      expect.objectContaining({
        type: "failure",
        failure: expect.objectContaining({
          kind: "idle_timeout",
          attempt: 2,
          maxAttempts: 2,
          retryDecision: "fail",
        }),
      }),
    ])
    expect(provider.calls()).toBe(2)
  })

  it("honors a server retry veto on an idle timeout", async () => {
    const event = failure("idle_timeout")
    const provider = scriptedStream([
      [{ ...event, failure: { ...event.failure, serverShouldRetry: false } }],
      [success],
    ])
    const stream = createModelRequestStream(provider.stream, {
      wireApi: "unknown",
    })

    expect(await collect(stream)).toEqual([
      expect.objectContaining({
        type: "failure",
        failure: expect.objectContaining({ retryDecision: "fail" }),
      }),
    ])
    expect(provider.calls()).toBe(1)
  })

  it("does not start another attempt when cancelled during retry backoff", async () => {
    const controller = new AbortController()
    const provider = scriptedStream([[failure("idle_timeout")], [success]])
    const stream = createModelRequestStream(provider.stream, {
      wireApi: "unknown",
      sleep: async () => controller.abort(),
    })

    expect(await collect(stream, controller.signal)).toEqual([
      expect.objectContaining({ type: "retry" }),
      { type: "cancelled" },
    ])
    expect(provider.calls()).toBe(1)
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

function failure(
  kind: ModelFailure["kind"],
): Extract<ModelStreamEvent, { type: "failure" }> {
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
