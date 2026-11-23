import { crc32 } from "node:zlib"
import { isJsonObject, type JsonObject } from "../kernel/index.ts"
import type { ModelStreamEvent } from "./model.ts"

export class BedrockProtocolError extends Error {}

type Block =
  | { type: "text"; text: string; partIndex: number }
  | { type: "reasoning"; text: string; signature?: string; partIndex: number }
  | { type: "redacted"; bytes: Buffer[] }
  | { type: "tool"; start: JsonObject; input: string }

type ByteReader = Pick<
  ReadableStreamDefaultReader<Uint8Array>,
  "read" | "releaseLock"
>

export async function* readBedrockConverseStream(
  reader: ByteReader,
  signal: AbortSignal | undefined,
): AsyncGenerator<
  ModelStreamEvent,
  { content: JsonObject[]; metadata: JsonObject; stopReason: string }
> {
  let started = false
  let stop: JsonObject | undefined
  let metadata: JsonObject | undefined
  let block: Block | undefined
  const blocks: Block[] = []
  let textParts = 0
  let reasoningParts = 0
  for await (const { event, payload } of readFrames(reader, signal)) {
    if (event === "messageStart" && !started && payload.role === "assistant") {
      started = true
    } else if (
      started &&
      stop === undefined &&
      event === "messageStop" &&
      block === undefined &&
      typeof payload.stopReason === "string"
    ) {
      stop = payload
    } else if (
      stop !== undefined &&
      event === "metadata" &&
      metadata === undefined
    ) {
      metadata = payload
    } else if (
      started &&
      stop === undefined &&
      payload.contentBlockIndex === blocks.length
    ) {
      if (
        event === "contentBlockStart" &&
        block === undefined &&
        isJsonObject(payload.start) &&
        isJsonObject(payload.start.toolUse)
      ) {
        block = { type: "tool", start: payload.start.toolUse, input: "" }
      } else if (event === "contentBlockStop" && block !== undefined) {
        if (block.type === "reasoning" && block.text !== "") reasoningParts++
        blocks.push(block)
        block = undefined
      } else if (
        event === "contentBlockDelta" &&
        isJsonObject(payload.delta) &&
        Object.keys(payload.delta).length === 1
      ) {
        const delta = payload.delta
        if (
          typeof delta.text === "string" &&
          (block === undefined || block.type === "text")
        ) {
          block ??= { type: "text", text: "", partIndex: textParts++ }
          block.text += delta.text
          if (delta.text !== "")
            yield {
              type: "delta",
              text: delta.text,
              partIndex: block.partIndex,
            }
        } else if (
          isJsonObject(delta.toolUse) &&
          typeof delta.toolUse.input === "string" &&
          block?.type === "tool"
        ) {
          block.input += delta.toolUse.input
        } else if (
          isJsonObject(delta.reasoningContent) &&
          Object.keys(delta.reasoningContent).length === 1
        ) {
          const { text, signature, redactedContent } = delta.reasoningContent
          if (
            typeof redactedContent === "string" &&
            (block === undefined || block.type === "redacted")
          ) {
            block ??= { type: "redacted", bytes: [] }
            block.bytes.push(Buffer.from(redactedContent, "base64"))
          } else if (
            (typeof text === "string" || typeof signature === "string") &&
            (block === undefined || block.type === "reasoning")
          ) {
            block ??= { type: "reasoning", text: "", partIndex: reasoningParts }
            if (typeof signature === "string")
              block.signature = (block.signature ?? "") + signature
            if (typeof text === "string" && text !== "") {
              block.text += text
              yield {
                type: "reasoning_delta",
                format: "raw",
                text,
                partIndex: block.partIndex,
              }
            }
          } else
            throw new BedrockProtocolError("Invalid Bedrock reasoning delta.")
        } else
          throw new BedrockProtocolError("Unsupported Bedrock content delta.")
      } else throw new BedrockProtocolError("Invalid Bedrock content event.")
    } else
      throw new BedrockProtocolError("Unexpected Bedrock ConverseStream event.")
  }
  if (typeof stop?.stopReason !== "string" || metadata === undefined)
    throw new BedrockProtocolError(
      "Incomplete Bedrock ConverseStream response.",
    )
  const stopReason = stop.stopReason
  const content = blocks.map((part): JsonObject => {
    if (part.type === "text") return { text: part.text }
    if (part.type === "reasoning")
      return {
        reasoningContent: {
          reasoningText: {
            text: part.text,
            ...(part.signature === undefined
              ? {}
              : { signature: part.signature }),
          },
        },
      }
    if (part.type === "redacted")
      return {
        reasoningContent: {
          redactedContent: Buffer.concat(part.bytes).toString("base64"),
        },
      }
    return {
      toolUse: {
        ...part.start,
        input: stopReason === "tool_use" ? JSON.parse(part.input) : {},
      },
    }
  })
  return { content, stopReason, metadata: { ...stop, ...metadata } }
}

const preludeBytes = 12
const checksumBytes = 4
// Bound the accumulated wire and output memory; this is not an AWS quota.
const responseSafetyBytes = 16_000_000

async function* readFrames(
  reader: ByteReader,
  signal: AbortSignal | undefined,
) {
  const prelude = Buffer.alloc(preludeBytes)
  let frame = prelude
  let used = 0
  let received = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      received += value.byteLength
      if (received > responseSafetyBytes)
        throw new BedrockProtocolError(
          "Bedrock response exceeds Yakitori's 16 MB response safety limit.",
        )
      for (let offset = 0; offset < value.byteLength; ) {
        const take = Math.min(
          frame.byteLength - used,
          value.byteLength - offset,
        )
        frame.set(value.subarray(offset, offset + take), used)
        used += take
        offset += take
        if (used !== frame.byteLength) continue
        if (frame === prelude) {
          const length = prelude.readUInt32BE(0)
          if (length > responseSafetyBytes)
            throw new BedrockProtocolError(
              "Bedrock frame exceeds Yakitori's 16 MB response safety limit.",
            )
          if (
            length < preludeBytes + checksumBytes ||
            prelude.readUInt32BE(4) > length - preludeBytes - checksumBytes ||
            prelude.readUInt32BE(8) !== crc32(prelude.subarray(0, 8))
          )
            throw new BedrockProtocolError("Invalid Bedrock event prelude.")
          frame = Buffer.allocUnsafe(length)
          frame.set(prelude)
        } else {
          yield decodeFrame(frame)
          frame = prelude
          used = 0
        }
      }
    }
    if (used !== 0)
      throw new BedrockProtocolError("Truncated Bedrock event frame.")
  } finally {
    reader.releaseLock()
  }
}

function decodeFrame(frame: Buffer) {
  const checksumOffset = frame.byteLength - checksumBytes
  if (
    frame.readUInt32BE(checksumOffset) !==
    crc32(frame.subarray(0, checksumOffset))
  )
    throw new BedrockProtocolError("Invalid Bedrock event checksum.")
  const headerEnd = preludeBytes + frame.readUInt32BE(4)
  const headers = new Map<string, string>()
  for (let offset = preludeBytes; offset < headerEnd; ) {
    const nameLength = frame.readUInt8(offset++)
    if (nameLength === 0 || offset + nameLength >= headerEnd)
      throw new BedrockProtocolError("Invalid Bedrock event header.")
    const name = frame.toString("utf8", offset, offset + nameLength)
    offset += nameLength
    const type = frame.readUInt8(offset++)
    if ((type === 6 || type === 7) && offset + 2 <= headerEnd) {
      const size = frame.readUInt16BE(offset)
      offset += 2
      if (offset + size > headerEnd)
        throw new BedrockProtocolError("Truncated Bedrock event header.")
      if (type === 7)
        headers.set(name, frame.toString("utf8", offset, offset + size))
      offset += size
    } else {
      const size = [0, 0, 1, 2, 4, 8, undefined, undefined, 8, 16][type]
      if (size === undefined || offset + size > headerEnd)
        throw new BedrockProtocolError(
          "Invalid Bedrock event header type or size.",
        )
      offset += size
    }
  }
  const event = headers.get(":event-type")
  if (headers.get(":message-type") !== "event")
    throw new BedrockProtocolError(
      "Bedrock reported an error in the response stream.",
    )
  const payload: unknown = JSON.parse(
    frame.toString("utf8", headerEnd, checksumOffset),
  )
  if (event === undefined || !isJsonObject(payload))
    throw new BedrockProtocolError("Invalid Bedrock event payload.")
  return { event, payload }
}
