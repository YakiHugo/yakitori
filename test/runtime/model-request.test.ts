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
  it("does not replay a request after a completed item committed side effects", async () => {
    const item: ModelStreamEvent = {
      type: "output_item",
      itemId: "fc_once",
      content: [{ type: "tool_call", id: "once", name: "write", input: {} }],
    }
    const provider = scriptedStream([
      [item, failure("stream_disconnected")],
      [success],
    ])
    const stream = createModelRequestStream(provider.stream, {
      wireApi: "unknown",
      sleep: async () => {},
    })
    const events = await collect(stream)
    expect(events).toEqual([
      item,
      expect.objectContaining({
        type: "failure",
        failure: expect.objectContaining({ retryDecision: "fail" }),
      }),
    ])
    expect(provider.calls()).toBe(1)
  })

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
    "local",
    "remote_v2",
  ] as const)("retries a truncated %s compaction using the original request and output budget", async (compaction) => {
    const request: ModelRequest = {
      ...requestFixture(),
      compaction,
      maxOutputTokens: 32_000,
      system: [{ id: "summary", revision: "1", text: "Summarize history." }],
      messages: [
        { role: "user", content: [{ type: "text", text: "Original history" }] },
      ],
    }
    const provider = scriptedStream([[truncatedSummary], [success]])
    const sleeps: number[] = []
    const stream = createModelRequestStream(provider.stream, {
      wireApi: "openai_responses",
      maxAttempts: 2,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      random: () => 1,
    })

    expect(await collect(stream, undefined, request)).toEqual([
      expect.objectContaining({
        type: "retry",
        attempt: 1,
        nextAttempt: 2,
        delayMs: 500,
        failure: expect.objectContaining({
          kind: "provider_error",
          providerCode: "max_output_tokens",
          retryDecision: "retry",
        }),
        usage: { inputTokens: 31, outputTokens: 7 },
      }),
      success,
    ])
    expect(sleeps).toEqual([500])
    expect(provider.calls()).toBe(2)
    expect(
      provider
        .requests()
        .map(({ attempt: _attempt, signal: _signal, ...original }) => original),
    ).toEqual([request, request])
  })

  it("shares one attempt budget across transport failures and truncated compactions while retaining each usage result", async () => {
    const exhaustedSummary: ModelStreamEvent = {
      type: "response",
      response: {
        ...truncatedSummary.response,
        usage: { inputTokens: 37, outputTokens: 9 },
      },
    }
    const provider = scriptedStream([
      [
        {
          ...failure("stream_disconnected"),
          usage: { inputTokens: 5, outputTokens: 2 },
        },
      ],
      [truncatedSummary],
      [exhaustedSummary],
      [success],
    ])
    const sleeps: number[] = []
    const stream = createModelRequestStream(provider.stream, {
      wireApi: "openai_responses",
      maxAttempts: 3,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      random: () => 1,
    })

    expect(
      await collect(stream, undefined, {
        ...requestFixture(),
        compaction: "local",
      }),
    ).toEqual([
      expect.objectContaining({
        type: "retry",
        attempt: 1,
        nextAttempt: 2,
        failure: expect.objectContaining({ kind: "stream_disconnected" }),
        usage: { inputTokens: 5, outputTokens: 2 },
      }),
      expect.objectContaining({
        type: "retry",
        attempt: 2,
        nextAttempt: 3,
        failure: expect.objectContaining({ kind: "provider_error" }),
        usage: { inputTokens: 31, outputTokens: 7 },
      }),
      expect.objectContaining({
        type: "failure",
        failure: expect.objectContaining({
          kind: "provider_error",
          providerCode: "max_output_tokens",
          attempt: 3,
          maxAttempts: 3,
          retryDecision: "fail",
        }),
        usage: { inputTokens: 37, outputTokens: 9 },
      }),
    ])
    expect(provider.calls()).toBe(3)
    expect(sleeps).toEqual([500, 1_000])
  })

  it("fails a truncated compaction immediately when only one attempt is allowed", async () => {
    const provider = scriptedStream([[truncatedSummary], [success]])
    const sleeps: number[] = []
    const stream = createModelRequestStream(provider.stream, {
      wireApi: "openai_responses",
      maxAttempts: 1,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })

    expect(
      await collect(stream, undefined, {
        ...requestFixture(),
        compaction: "local",
      }),
    ).toEqual([
      expect.objectContaining({
        type: "failure",
        failure: expect.objectContaining({
          kind: "provider_error",
          providerCode: "max_output_tokens",
          attempt: 1,
          maxAttempts: 1,
          retryDecision: "fail",
        }),
        usage: { inputTokens: 31, outputTokens: 7 },
      }),
    ])
    expect(provider.calls()).toBe(1)
    expect(sleeps).toEqual([])
  })

  it.each([
    "second terminal",
    "tail error",
  ])("rejects a truncated compaction followed by a %s without retrying it", async (tail) => {
    let calls = 0
    const stream = createModelRequestStream(
      async function* () {
        calls += 1
        yield truncatedSummary
        if (tail === "second terminal") yield success
        else throw new Error("terminated")
      },
      {
        wireApi: "openai_responses",
        maxAttempts: 3,
        sleep: async () => {},
      },
    )

    expect(
      await collect(stream, undefined, {
        ...requestFixture(),
        compaction: "local",
      }),
    ).toEqual([
      expect.objectContaining({
        type: "failure",
        failure: expect.objectContaining({
          kind: "protocol_error",
          retryDecision: "fail",
        }),
      }),
    ])
    expect(calls).toBe(1)
  })

  it("passes ordinary Length responses through unchanged without retrying", async () => {
    const provider = scriptedStream([[truncatedSummary], [success]])
    const sleeps: number[] = []
    const stream = createModelRequestStream(provider.stream, {
      wireApi: "openai_responses",
      maxAttempts: 3,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })

    expect(await collect(stream)).toEqual([truncatedSummary])
    expect(provider.calls()).toBe(1)
    expect(sleeps).toEqual([])
  })

  it.each([
    ["delta", "stream_disconnected"],
    ["reasoning_delta", "stream_disconnected"],
    ["delta", "idle_timeout"],
    ["reasoning_delta", "idle_timeout"],
  ] as const)("retries provisional %s output followed by %s", async (type, kind) => {
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
        type: "retry",
        failure: expect.objectContaining({
          kind,
          attempt: 1,
          outputObserved: true,
          retryDecision: "retry",
        }),
      }),
      success,
    ])
    expect(provider.calls()).toBe(2)
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
      [{ type: "delta", text: "partial" }, failure("idle_timeout")],
      [failure("idle_timeout")],
      [success],
    ])
    const stream = createModelRequestStream(provider.stream, {
      wireApi: "unknown",
      maxAttempts: 2,
      sleep: async () => {},
    })

    expect(await collect(stream)).toEqual([
      { type: "delta", text: "partial" },
      expect.objectContaining({ type: "retry", nextAttempt: 2 }),
      expect.objectContaining({
        type: "failure",
        failure: expect.objectContaining({
          kind: "idle_timeout",
          attempt: 2,
          maxAttempts: 2,
          outputObserved: false,
          retryDecision: "fail",
        }),
      }),
    ])
    expect(provider.calls()).toBe(2)
  })

  it("uses the expanded default attempt budget for network timeouts", async () => {
    const provider = scriptedStream([
      [failure("idle_timeout")],
      [failure("idle_timeout")],
      [failure("idle_timeout")],
      [failure("idle_timeout")],
      [failure("idle_timeout")],
      [failure("idle_timeout")],
      [failure("idle_timeout")],
      [success],
    ])
    const stream = createModelRequestStream(provider.stream, {
      wireApi: "unknown",
      sleep: async () => {},
      random: () => 0,
    })

    const events = await collect(stream)

    expect(events).toHaveLength(8)
    expect(events[6]).toMatchObject({
      type: "retry",
      attempt: 7,
      nextAttempt: 8,
      maxAttempts: 8,
      failure: { kind: "idle_timeout" },
    })
    expect(events[7]).toEqual(success)
    expect(provider.calls()).toBe(8)
  })

  it("honors a server retry veto on an idle timeout", async () => {
    const event = failure("idle_timeout")
    const provider = scriptedStream([
      [
        { type: "delta", text: "partial" },
        { ...event, failure: { ...event.failure, serverShouldRetry: false } },
      ],
      [success],
    ])
    const stream = createModelRequestStream(provider.stream, {
      wireApi: "unknown",
    })

    expect(await collect(stream)).toEqual([
      { type: "delta", text: "partial" },
      expect.objectContaining({
        type: "failure",
        failure: expect.objectContaining({ retryDecision: "fail" }),
      }),
    ])
    expect(provider.calls()).toBe(1)
  })

  it("does not start another attempt when cancelled during retry backoff", async () => {
    const controller = new AbortController()
    const provider = scriptedStream([
      [{ type: "reasoning_delta", text: "partial" }, failure("idle_timeout")],
      [success],
    ])
    const stream = createModelRequestStream(provider.stream, {
      wireApi: "unknown",
      sleep: async () => controller.abort(),
    })

    expect(await collect(stream, controller.signal)).toEqual([
      { type: "reasoning_delta", text: "partial" },
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
          yield { type: "delta", text: "partial" }
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
      value: { type: "delta", text: "partial" },
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

const truncatedSummary: Extract<ModelStreamEvent, { type: "response" }> = {
  type: "response",
  response: {
    stopReason: ModelStopReason.Length,
    rawStopReason: "max_output_tokens",
    lengthReason: "output",
    content: [{ type: "text", text: "Incomplete summary" }],
    usage: { inputTokens: 31, outputTokens: 7 },
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
  const requests: ModelRequest[] = []
  const stream: StreamFn = (request) => {
    requests.push(request)
    const attempt = attempts[callCount]
    callCount += 1
    if (attempt === undefined) throw new Error("Missing scripted attempt.")
    return (async function* () {
      yield* attempt
    })()
  }
  return { stream, calls: () => callCount, requests: () => requests }
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
  request: ModelRequest = requestFixture(signal),
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = []
  for await (const event of stream(request)) events.push(event)
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
