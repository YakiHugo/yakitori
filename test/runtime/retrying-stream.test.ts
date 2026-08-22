import { describe, expect, it } from "vitest"
import {
  ModelStopReason,
  type ModelRequest,
  type ModelStreamEvent,
  type StreamFn,
} from "../../src/index.ts"
import { withRetries } from "../../src/runtime/retrying-stream.ts"

describe("withRetries", () => {
  it("retries a retryable error and streams the second attempt", async () => {
    const provider = scriptedStream([
      [{ type: "snapshot", text: "par" }, retryableError(429)],
      [{ type: "snapshot", text: "full" }, success],
    ])
    const sleeps: number[] = []
    const stream = withRetries(provider.stream, {
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      random: () => 1,
    })

    const events = await collect(stream, requestFixture())

    expect(events).toEqual([
      { type: "snapshot", text: "par" },
      { type: "snapshot", text: "full" },
      success,
    ])
    expect(provider.calls()).toBe(2)
    expect(sleeps).toEqual([500])
  })

  it("stops after maxAttempts and yields the final error response", async () => {
    const provider = scriptedStream([
      [retryableError(429)],
      [retryableError(500)],
      [retryableError(503)],
      [retryableError(529)],
    ])
    const sleeps: number[] = []
    const stream = withRetries(provider.stream, {
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      random: () => 1,
    })

    const events = await collect(stream, requestFixture())

    expect(events).toEqual([retryableError(529)])
    expect(provider.calls()).toBe(4)
    expect(sleeps).toEqual([500, 1000, 2000])
  })

  it("does not retry an error the provider marked non-retryable", async () => {
    const clientError: ModelStreamEvent = {
      type: "response",
      response: {
        stopReason: ModelStopReason.Error,
        content: [],
        error: {
          code: "provider_error",
          message: "HTTP 400",
          details: { retryable: false, status: 400 },
        },
      },
    }
    const provider = scriptedStream([[clientError]])
    const sleeps: number[] = []
    const stream = withRetries(provider.stream, {
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      random: () => 1,
    })

    const events = await collect(stream, requestFixture())

    expect(events).toEqual([clientError])
    expect(provider.calls()).toBe(1)
    expect(sleeps).toEqual([])
  })

  it("yields an aborted terminal when the signal aborts during backoff", async () => {
    const controller = new AbortController()
    const provider = scriptedStream([[retryableError(429)], [success]])
    const stream = withRetries(provider.stream, {
      sleep: async () => {
        controller.abort()
      },
      random: () => 1,
    })

    const events = await collect(stream, requestFixture(controller.signal))

    expect(events).toEqual([
      {
        type: "response",
        response: { stopReason: ModelStopReason.Aborted, content: [] },
      },
    ])
    expect(provider.calls()).toBe(1)
  })

  it("ends the default sleep early when the signal aborts mid-backoff", async () => {
    const controller = new AbortController()
    const provider = scriptedStream([[retryableError(429)], [success]])
    const stream = withRetries(provider.stream, {
      baseDelayMs: 60_000,
      random: () => 1,
    })

    const startedAt = Date.now()
    const collecting = collect(stream, requestFixture(controller.signal))
    setTimeout(() => controller.abort(), 10)
    const events = await collecting

    // The capped delay would be 8 s without the abort wakeup.
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(events).toEqual([
      {
        type: "response",
        response: { stopReason: ModelStopReason.Aborted, content: [] },
      },
    ])
    expect(provider.calls()).toBe(1)
  })

  it("does not retry when the error has no retryable details", async () => {
    const plainError: ModelStreamEvent = {
      type: "response",
      response: {
        stopReason: ModelStopReason.Error,
        content: [],
        error: { code: "provider_error", message: "Bad request." },
      },
    }
    const provider = scriptedStream([[plainError]])
    const stream = withRetries(provider.stream, {
      sleep: () => Promise.reject(new Error("sleep must not be called")),
      random: () => 1,
    })

    const events = await collect(stream, requestFixture())

    expect(events).toEqual([plainError])
    expect(provider.calls()).toBe(1)
  })
})

const success: ModelStreamEvent = {
  type: "response",
  response: {
    stopReason: ModelStopReason.EndTurn,
    content: [{ type: "text", text: "done" }],
  },
}

function retryableError(status: number): ModelStreamEvent {
  return {
    type: "response",
    response: {
      stopReason: ModelStopReason.Error,
      content: [],
      error: {
        code: "provider_error",
        message: `HTTP ${status}`,
        details: { retryable: true, status },
      },
    },
  }
}

function requestFixture(signal?: AbortSignal): ModelRequest {
  return {
    target: { provider: "test", model: "test-model", promptId: "default" },
    system: [{ id: "base", revision: "base-1", text: "Be helpful." }],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    ...(signal === undefined ? {} : { signal }),
  }
}

function scriptedStream(attempts: readonly (readonly ModelStreamEvent[])[]) {
  let calls = 0
  const stream: StreamFn = () => {
    calls += 1
    const attempt = attempts[calls - 1]
    if (attempt === undefined) {
      throw new Error(`No scripted attempt for stream call ${calls}.`)
    }
    return (async function* () {
      yield* attempt
    })()
  }
  return {
    stream,
    calls: () => calls,
  }
}

async function collect(
  stream: StreamFn,
  request: ModelRequest,
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = []
  for await (const event of stream(request)) events.push(event)
  return events
}
