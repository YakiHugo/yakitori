import { describe, expect, it } from "vitest"
import { createGeminiProvider } from "../../src/runtime/gemini-provider.ts"
import type { ModelRequest, ModelStreamEvent } from "../../src/runtime/model.ts"
import { createModelRequestStream } from "../../src/runtime/model-request.ts"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1S8AAAAASUVORK5CYII=",
  "base64",
)

function request(
  read: NonNullable<ModelRequest["assets"]>["read"],
): ModelRequest {
  return {
    target: {
      provider: "gemini",
      model: "fixture",
      instructionProfileId: "default",
    },
    system: [],
    tools: [],
    toolWireProtocol: "eager",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            mediaType: "image/png",
            sizeBytes: 0,
            file: { rolloutId: "fixture", path: "attachments/fixture.png" },
          },
        ],
      },
    ],
    assets: { read },
  }
}

function stream(fetchFn: typeof fetch) {
  return createModelRequestStream(
    createGeminiProvider({
      apiKey: "fixture",
      model: "fixture",
      baseURL: "https://fixture.invalid/v1beta",
      fetchFn,
    }),
    {
      wireApi: "gemini_generate_content",
      sleep: async () => {},
      random: () => 0,
    },
  )
}

async function collect(events: AsyncIterable<ModelStreamEvent>) {
  const result: ModelStreamEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

function completed() {
  return new Response(
    `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

describe("model image failures", () => {
  it.each([
    [
      "unrecognized format",
      Buffer.from("not an image"),
      "Only PNG, JPEG, GIF, and WebP images can be attached.",
    ],
    [
      "truncated dimensions",
      png.subarray(0, 12),
      "Image data is truncated or has invalid dimensions.",
    ],
  ] as const)("does not retry successfully read image bytes with %s", async (_name, bytes, message) => {
    let reads = 0
    let requests = 0
    const events = await collect(
      stream(async () => {
        requests += 1
        return completed()
      })(
        request(async () => {
          reads += 1
          return bytes
        }),
      ),
    )
    expect(events).toMatchObject([
      {
        type: "failure",
        failure: {
          kind: "invalid_request",
          stage: "request_build",
          message,
          attempt: 1,
          retryDecision: "fail",
        },
      },
    ])
    expect(events).toHaveLength(1)
    expect(reads).toBe(1)
    expect(requests).toBe(0)
  })

  it("still retries a transient asset read failure before decoding the successful read", async () => {
    let reads = 0
    let requests = 0
    const disconnected = Object.assign(new Error("asset connection reset"), {
      code: "ECONNRESET",
    })
    const events = await collect(
      stream(async () => {
        requests += 1
        return completed()
      })(
        request(async () => {
          reads += 1
          if (reads === 1) throw disconnected
          return png
        }),
      ),
    )
    expect(events[0]).toMatchObject({
      type: "retry",
      failure: { kind: "stream_disconnected", stage: "request_build" },
    })
    expect(events.at(-1)).toMatchObject({
      type: "response",
      response: {
        stopReason: "end_turn",
        content: [{ type: "text", text: "ok" }],
      },
    })
    expect(reads).toBe(2)
    expect(requests).toBe(1)
  })
})
