import { describe, expect, it } from "vitest"
import {
  type ModelRequest,
  ModelStopReason,
  type ModelStreamEvent,
  type StreamFn,
} from "../../src/runtime/model.ts"
import { withStreamIdleTimeout } from "../../src/runtime/stream-idle-timeout.ts"

describe("withStreamIdleTimeout", () => {
  it("terminates a half-open stream and aborts its transport", async () => {
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
    const events = await collect(
      withStreamIdleTimeout(halfOpen, 5),
      requestFixture(),
    )

    expect(events).toEqual([
      {
        type: "response",
        response: {
          stopReason: ModelStopReason.Error,
          content: [],
          error: {
            code: "stream_idle_timeout",
            message: "Model stream produced no event for 5 ms.",
            details: { idleTimeoutMs: 5 },
          },
        },
      },
    ])
    expect(transportAborted).toBe(true)
  })

  it("resets the deadline after every stream event", async () => {
    const stream: StreamFn = async function* () {
      yield { type: "snapshot", text: "one" }
      await new Promise((resolve) => setTimeout(resolve, 2))
      yield { type: "snapshot", text: "two" }
      yield {
        type: "response",
        response: { stopReason: ModelStopReason.EndTurn, content: [] },
      }
    }

    expect(
      await collect(withStreamIdleTimeout(stream, 20), requestFixture()),
    ).toHaveLength(3)
  })

  it("aborts and closes the provider when a consumer ends early", async () => {
    let transportAborted = false
    let providerClosed = false
    const stream: StreamFn = async function* (request) {
      request.signal?.addEventListener(
        "abort",
        () => {
          transportAborted = true
        },
        { once: true },
      )
      try {
        yield { type: "snapshot", text: "partial" }
        await new Promise(() => {})
      } finally {
        providerClosed = true
      }
    }
    const iterator = withStreamIdleTimeout(
      stream,
      20,
    )(requestFixture())[Symbol.asyncIterator]()

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: "snapshot", text: "partial" },
    })
    await iterator.return?.()

    expect(transportAborted).toBe(true)
    expect(providerClosed).toBe(true)
  })
})

function requestFixture(): ModelRequest {
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
