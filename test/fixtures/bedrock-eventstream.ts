import { crc32 } from "node:zlib"
import { isJsonObject, type JsonObject } from "../../src/kernel/index.ts"

export function bedrockEvent(event: string, payload: JsonObject) {
  const headers = Buffer.concat(
    Object.entries({
      ":message-type": "event",
      ":event-type": event,
      ":content-type": "application/json",
    }).flatMap(([name, value]) => [
      Buffer.from([name.length]),
      Buffer.from(name),
      Buffer.from([7, 0, value.length]),
      Buffer.from(value),
    ]),
  )
  const body = Buffer.from(JSON.stringify(payload))
  const frame = Buffer.alloc(16 + headers.length + body.length)
  frame.writeUInt32BE(frame.length)
  frame.writeUInt32BE(headers.length, 4)
  frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8)
  headers.copy(frame, 12)
  body.copy(frame, 12 + headers.length)
  frame.writeUInt32BE(crc32(frame.subarray(0, -4)), frame.length - 4)
  return frame
}

export function bedrockReply(
  content: readonly JsonObject[],
  stopReason: string,
  usage: JsonObject,
) {
  const frames = [bedrockEvent("messageStart", { role: "assistant" })]
  for (const [contentBlockIndex, block] of content.entries()) {
    const emitDelta = (delta: JsonObject) =>
      frames.push(
        bedrockEvent("contentBlockDelta", { contentBlockIndex, delta }),
      )
    if (typeof block.text === "string") emitDelta({ text: block.text })
    else if (isJsonObject(block.toolUse)) {
      const { input, ...toolUse } = block.toolUse
      frames.push(
        bedrockEvent("contentBlockStart", {
          contentBlockIndex,
          start: { toolUse },
        }),
      )
      const json = JSON.stringify(input)
      for (const fragment of [json.slice(0, 1), json.slice(1)])
        emitDelta({ toolUse: { input: fragment } })
    } else if (isJsonObject(block.reasoningContent)) {
      const { reasoningText, redactedContent } = block.reasoningContent
      if (isJsonObject(reasoningText)) {
        if (typeof reasoningText.text === "string")
          emitDelta({ reasoningContent: { text: reasoningText.text } })
        if (typeof reasoningText.signature === "string")
          emitDelta({
            reasoningContent: { signature: reasoningText.signature },
          })
      } else if (typeof redactedContent === "string")
        emitDelta({ reasoningContent: { redactedContent } })
    } else throw new Error("Unsupported test content block")
    frames.push(bedrockEvent("contentBlockStop", { contentBlockIndex }))
  }
  frames.push(
    bedrockEvent("messageStop", { stopReason }),
    bedrockEvent("metadata", { usage }),
  )
  return Buffer.concat(frames)
}
