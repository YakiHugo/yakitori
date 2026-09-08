import type { JsonObject, WorldStateFragment } from "../kernel/events.ts"
import type { ModelMessage } from "./model.ts"
import type {
  ModelContextSettings,
  ResponseItemEnvelope,
} from "../core/rollout.ts"
import { estimateImageTokens } from "./model-request-budget.ts"

export type ForkedModelContext = Readonly<{
  sourceSessionId: string
  messages: readonly ModelMessage[]
  worldState?: JsonObject
  previousModel?: ModelContextSettings
  activeContextTokens?: number
}>

export function createCompactionReplacementHistory(input: {
  readonly summary: string
  readonly worldStateFragments?: readonly WorldStateFragment[]
}): readonly ModelMessage[] {
  return [
    ...(input.worldStateFragments ?? []).map((fragment) => ({
      role: fragment.role,
      content: [{ type: "text" as const, text: fragment.text }],
      context: {
        type: "world_state" as const,
        sectionId: fragment.id,
        revision: fragment.revision,
      },
    })),
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `<context_compacted>\nEarlier turns in this session were summarized into this checkpoint. The complete history is preserved on disk.\n${input.summary}\n</context_compacted>`,
        },
      ],
    },
  ]
}

// Codex local compaction retains recent user text independently of the summary
// within a 20,000 approximate-token budget. Preserve Yakitori's envelope
// attribution while dropping images from this text-only retained history.
export function retainCompactionUserMessages(
  history: readonly ResponseItemEnvelope[],
): ResponseItemEnvelope[] {
  const retained: ResponseItemEnvelope[] = []
  let remaining = 20_000
  for (const envelope of [...history].reverse()) {
    const message = envelope.item
    if (message.role !== "user" || message.context !== undefined) continue
    const text = message.content.map((block) => block.text).join("\n")
    if (
      text.length === 0 ||
      text.startsWith("<context_compacted>") ||
      isAgentContextMessage(text)
    )
      continue
    if (remaining === 0) break
    const tokens = Math.ceil(Buffer.byteLength(text, "utf8") / 4)
    const retainedText = truncateCompactionText(text, remaining)
    retained.push({
      ...envelope,
      item: { role: "user", content: [{ type: "text", text: retainedText }] },
    })
    remaining = Math.max(0, remaining - tokens)
  }
  return retained.reverse()
}

// Codex remote v2 retains recent real user content (including images), then
// appends one native checkpoint. Developer environment fragments are rebuilt.
export function retainRemoteCompactionMessages(
  history: readonly ResponseItemEnvelope[],
): ResponseItemEnvelope[] {
  const retained: ResponseItemEnvelope[] = []
  let remaining = 64_000
  for (const envelope of [...history].reverse()) {
    if (remaining === 0) break
    const message = envelope.item
    if (message.role !== "user" || message.context !== undefined) continue
    const text = message.content.map((block) => block.text).join("\n")
    if (
      text.startsWith("<context_compacted>") ||
      text.startsWith("<subagent_notification ")
    )
      continue
    const images = message.images ?? []
    const textTokens = Math.ceil(Buffer.byteLength(text) / 4)
    const total = Math.max(
      1,
      textTokens +
        images.reduce(
          (tokens, image) => tokens + estimateImageTokens(image),
          0,
        ),
    )
    if (text.startsWith("<inter_agent_message ") && total > 10_000) continue
    if (total <= remaining) {
      retained.push(envelope)
      remaining -= total
      continue
    }
    // IR places images after text; keep the latest boundary content, with
    // each image atomic, just as the reference's reverse content traversal.
    const keptImages: (typeof images)[number][] = []
    for (const image of [...images].reverse()) {
      const cost = estimateImageTokens(image)
      if (cost > remaining) {
        remaining = 0
        break
      }
      keptImages.push(image)
      remaining -= cost
    }
    const keptText = truncateCompactionText(text, remaining)
    if (keptText.length > 0 || keptImages.length > 0) {
      retained.push({
        ...envelope,
        item: {
          role: "user",
          content:
            keptText.length === 0 ? [] : [{ type: "text", text: keptText }],
          ...(keptImages.length === 0 ? {} : { images: keptImages.reverse() }),
        },
      })
    }
    remaining = 0
  }
  return retained.reverse()
}

function isAgentContextMessage(text: string): boolean {
  return (
    text.startsWith("<inter_agent_message ") ||
    text.startsWith("<subagent_notification ")
  )
}

function truncateCompactionText(text: string, tokens: number): string {
  if (Buffer.byteLength(text) <= tokens * 4) return text
  const marker = "\n[... user message truncated ...]\n".slice(0, tokens * 4)
  const half = Math.max(
    0,
    Math.floor((tokens * 4 - Buffer.byteLength(marker)) / 2),
  )
  const characters = Array.from(text)
  let head = ""
  let tail = ""
  let bytes = 0
  for (const character of characters) {
    bytes += Buffer.byteLength(character)
    if (bytes > half) break
    head += character
  }
  bytes = 0
  for (const character of characters.reverse()) {
    bytes += Buffer.byteLength(character)
    if (bytes > half) break
    tail = character + tail
  }
  return head + marker + tail
}
