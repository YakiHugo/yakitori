import { expect, it } from "vitest"
import {
  ModelStopReason,
  type ModelStreamEvent,
} from "../../src/runtime/model.ts"
import { cleanModelTextStream } from "../../src/runtime/model-control-tokens.ts"

it("emits the same visible text for every split of supported control tokens", async () => {
  const raw =
    "A\uE200cite\uE202turn0search0\uE201B <|eos|> example<|eos|><|endoftext|><|im_end|><|eot_id|>"
  for (let split = 0; split <= raw.length; split += 1) {
    const events = await cleanDeltas([raw.slice(0, split), raw.slice(split)])
    expect(events).toBe("AB <|eos|> example")
  }
})

it("flushes literal prefixes on EOF and before a part completes without text", async () => {
  expect(await cleanDeltas(["a ", "<"])).toBe("a <")
  expect(await cleanDeltas(["literal ", "<|im_"])).toBe("literal <|im_")
  const delta = {
    type: "delta",
    itemId: "message",
    partIndex: 3,
    purpose: "commentary",
  } as const
  const completed = {
    type: "output_item",
    itemId: "message",
    content: [],
  } as const
  async function* input(): AsyncGenerator<ModelStreamEvent> {
    yield { ...delta, text: "a <" }
    yield completed
  }
  expect(await Array.fromAsync(cleanModelTextStream(input()))).toEqual([
    { ...delta, text: "a " },
    { ...delta, text: "<" },
    completed,
  ])
})

it("flushes visible text before propagating a thrown upstream failure", async () => {
  const error = new Error("transport ended")
  async function* input(): AsyncGenerator<ModelStreamEvent> {
    yield { type: "delta", text: "a <" }
    throw error
  }
  const stream = cleanModelTextStream(input())
  expect((await stream.next()).value).toEqual({ type: "delta", text: "a " })
  expect((await stream.next()).value).toEqual({ type: "delta", text: "<" })
  await expect(stream.next()).rejects.toBe(error)
})

it("does not hold another part behind an unfinished private marker", async () => {
  async function* input(): AsyncGenerator<ModelStreamEvent> {
    yield { type: "delta", itemId: "item", partIndex: 0, text: "One\uE200ci" }
    yield { type: "delta", itemId: "item", partIndex: 1, text: "Two" }
    yield { type: "delta", itemId: "list", partIndex: 0, text: "Three" }
    yield { type: "delta", itemId: "item", partIndex: 0, text: "te\uE202lost" }
    yield { type: "delta", itemId: "item", partIndex: 0, text: "\nFour" }
  }
  expect(await Array.fromAsync(cleanModelTextStream(input()))).toEqual([
    { type: "delta", itemId: "item", partIndex: 0, text: "One" },
    { type: "delta", itemId: "item", partIndex: 1, text: "Two" },
    { type: "delta", itemId: "list", partIndex: 0, text: "Three" },
    { type: "delta", itemId: "item", partIndex: 0, text: "\nFour" },
  ])
})

it("preserves literal code examples and whitespace following an end token", async () => {
  const text = "Write `<|eos|>` in code.<|eos|>\n\n"
  async function* input(): AsyncGenerator<ModelStreamEvent> {
    yield {
      type: "response",
      response: {
        stopReason: ModelStopReason.EndTurn,
        content: [{ type: "text", text }],
      },
    }
  }
  expect(await Array.fromAsync(cleanModelTextStream(input()))).toEqual([
    {
      type: "response",
      response: {
        stopReason: ModelStopReason.EndTurn,
        content: [{ type: "text", text: "Write `<|eos|>` in code.\n\n" }],
      },
    },
  ])
})

async function cleanDeltas(chunks: readonly string[]): Promise<string> {
  async function* input(): AsyncGenerator<ModelStreamEvent> {
    for (const text of chunks) yield { type: "delta", text }
  }
  const events = await Array.fromAsync(cleanModelTextStream(input()))
  return events
    .flatMap((event) => (event.type === "delta" ? [event.text] : []))
    .join("")
}
