import type {
  JsonObject,
  ProviderUsageBaseline,
  WorldStateFragment,
} from "../kernel/events.ts"
import type { ModelMessage } from "./model.ts"

export type DroppedTurn = {
  readonly turnId: string
  readonly messages: readonly ModelMessage[]
}

export type ForkedModelContext = Readonly<{
  sourceSessionId: string
  messages: readonly ModelMessage[]
  worldState?: JsonObject
  providerUsageBaseline?: {
    readonly turnId: string
    readonly modelCallId: string
    readonly baseline: ProviderUsageBaseline
    readonly seq: number
    readonly createdAt: string
  }
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
