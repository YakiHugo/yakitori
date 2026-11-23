import { scanModelText } from "../shared/model-text.ts"
import type {
  ModelContentBlock,
  ModelStreamDeltaEvent,
  ModelStreamEvent,
} from "./model.ts"

export function cleanModelText(text: string): string {
  return scanModelText(text, true).text
}

export async function* cleanModelTextStream(
  events: AsyncIterable<ModelStreamEvent>,
): AsyncGenerator<ModelStreamEvent> {
  const tails = new Map<
    string | undefined,
    Map<number, ModelStreamDeltaEvent>
  >()
  function* finish(itemIds: Iterable<string | undefined>) {
    for (const itemId of itemIds) {
      const parts = tails.get(itemId)
      tails.delete(itemId)
      if (parts === undefined) continue
      for (const delta of parts.values()) {
        const text = cleanModelText(delta.text)
        if (text !== "") yield { ...delta, text }
      }
    }
  }
  try {
    for await (const event of events) {
      if (event.type === "delta") {
        const part = event.partIndex ?? 0
        const parts = tails.get(event.itemId)
        const { text, tail } = scanModelText(
          (parts?.get(part)?.text ?? "") + event.text,
          false,
        )
        if (tail !== "") {
          const next = parts ?? new Map<number, ModelStreamDeltaEvent>()
          next.set(part, { ...event, text: tail })
          tails.set(event.itemId, next)
        } else if (parts !== undefined) {
          parts.delete(part)
          if (parts.size === 0) tails.delete(event.itemId)
        }
        if (text !== "") yield { ...event, text }
      } else if (event.type === "output_item") {
        yield* finish([event.itemId])
        yield { ...event, content: cleanContent(event.content) }
      } else if (event.type === "response") {
        yield* finish(tails.keys())
        const { response } = event
        yield {
          ...event,
          response: { ...response, content: cleanContent(response.content) },
        }
      } else {
        if (event.type === "retry") tails.clear()
        else if (event.type === "failure" || event.type === "cancelled")
          yield* finish(tails.keys())
        yield event
      }
    }
  } catch (error) {
    yield* finish(tails.keys())
    throw error
  }
  yield* finish(tails.keys())
}

function cleanContent(content: readonly ModelContentBlock[]) {
  return content.map((block) => {
    if (block.type !== "text") return block
    const { text, removed } = scanModelText(block.text, true)
    if (removed.length === 0) return block
    const mapOffset = (offset: number) =>
      removed.reduce(
        (mapped, { start, end }) =>
          mapped - Math.max(0, Math.min(offset, end) - start),
        offset,
      )
    const annotations = block.annotations?.map(
      ({ responseSpan, ...annotation }) => {
        if (responseSpan === undefined) return annotation
        const start = mapOffset(responseSpan.start)
        const end = mapOffset(responseSpan.end)
        return start < end
          ? { ...annotation, responseSpan: { start, end } }
          : annotation
      },
    )
    return {
      ...block,
      text,
      ...(annotations === undefined ? {} : { annotations }),
    }
  })
}
