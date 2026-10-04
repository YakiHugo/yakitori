import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { isTokenUsage, type TokenUsage } from "../kernel/events.ts"
import { isStorageKey } from "../kernel/ids.ts"
import type { HistoryPosition, RolloutItem, ThreadMetadata } from "./rollout.ts"

export type UsageHistoryRecord = Readonly<{
  threadId: string
  rolloutId: string
  seq: number
  createdAt: string
  item:
    | Extract<RolloutItem, { type: "auxiliary_usage" }>
    | Readonly<{
        type: "turn_context"
        context: Readonly<{
          turnId: string
          selection: Readonly<{ provider: string; model: string }>
        }>
      }>
    | Readonly<{
        type: "turn_completed" | "turn_usage"
        turnId: string
        usage?: TokenUsage
      }>
}>
export type UsageHistory = Readonly<{
  metadata: ThreadMetadata
  rollout: readonly UsageHistoryRecord[]
}>

// Accounting reads known historical record envelopes, not executable context.
// Configuration schemas 3/4/5 all stored the same selection and token fields;
// obsolete execution policy must not erase valid recorded usage. Unknown formats
// still fail this read and are reported as incomplete by the store.
export async function readUsageHistory(
  metadata: ThreadMetadata,
  rolloutsDirectory: string,
): Promise<UsageHistory> {
  const seen = new Set<string>()
  const materialize = async (
    rolloutId: string,
    position?: HistoryPosition,
    expectedThreadId?: string,
  ): Promise<UsageHistoryRecord[]> => {
    if (!isStorageKey(rolloutId) || seen.has(rolloutId))
      throw new Error("Invalid usage history identity or cycle.")
    seen.add(rolloutId)
    try {
      const bytes = await readFile(
        join(rolloutsDirectory, rolloutId, "rollout.jsonl"),
      )
      const end = position?.endByteOffset ?? bytes.lastIndexOf(10) + 1
      if (end <= 0 || end > bytes.length || bytes[end - 1] !== 10)
        throw new Error("Invalid usage history boundary.")
      let owner: string | undefined
      let base: HistoryPosition | undefined
      let expectedSeq = 0
      const records: UsageHistoryRecord[] = []
      let start = 0
      for (let offset = 0; offset < end; offset += 1) {
        if (bytes[offset] !== 10) continue
        if (offset === start) {
          start = offset + 1
          continue
        }
        const value: unknown = JSON.parse(
          bytes.subarray(start, offset).toString("utf8"),
        )
        start = offset + 1
        if (
          !isRecord(value) ||
          !isStorageKey(value.threadId) ||
          value.rolloutId !== rolloutId ||
          !Number.isSafeInteger(value.seq) ||
          value.seq !== expectedSeq ||
          typeof value.createdAt !== "string" ||
          !Number.isFinite(Date.parse(value.createdAt)) ||
          !isRecord(value.item) ||
          typeof value.item.type !== "string"
        )
          throw new Error("Invalid usage record envelope.")
        const item = value.item
        if (owner === undefined) {
          if (
            item.type !== "session_meta" ||
            !isRecord(item.metadata) ||
            item.metadata.id !== value.threadId ||
            item.metadata.rolloutId !== rolloutId ||
            (expectedThreadId !== undefined &&
              value.threadId !== expectedThreadId)
          )
            throw new Error("Invalid usage session identity.")
          owner = value.threadId
          if (item.metadata.historyBase !== undefined) {
            if (!isPosition(item.metadata.historyBase))
              throw new Error("Invalid usage history reference.")
            base = item.metadata.historyBase
          }
          expectedSeq = base?.endSeqExclusive ?? 1
          continue
        }
        if (value.threadId !== owner)
          throw new Error("Usage record belongs to another thread.")
        expectedSeq += 1
        const envelope = {
          threadId: owner,
          rolloutId,
          seq: Number(value.seq),
          createdAt: value.createdAt,
        }
        if (item.type === "turn_context") {
          if (
            !isRecord(item.context) ||
            typeof item.context.turnId !== "string" ||
            !isRecord(item.context.configuration) ||
            typeof item.context.configuration.schemaVersion !== "number" ||
            ![3, 4, 5].includes(item.context.configuration.schemaVersion) ||
            !isRecord(item.context.selection) ||
            typeof item.context.selection.provider !== "string" ||
            typeof item.context.selection.model !== "string"
          )
            throw new Error("Unsupported usage context.")
          records.push({
            ...envelope,
            item: {
              type: "turn_context",
              context: {
                turnId: item.context.turnId,
                selection: {
                  provider: item.context.selection.provider,
                  model: item.context.selection.model,
                },
              },
            },
          })
        } else if (item.type === "auxiliary_usage") {
          if (
            item.source !== "session_title" ||
            typeof item.occurredAt !== "string" ||
            !Number.isFinite(Date.parse(item.occurredAt)) ||
            typeof item.requestId !== "string" ||
            item.requestId.length === 0 ||
            typeof item.provider !== "string" ||
            item.provider.length === 0 ||
            typeof item.model !== "string" ||
            item.model.length === 0 ||
            !isTokenUsage(item.usage)
          )
            throw new Error("Invalid auxiliary token usage.")
          records.push({
            ...envelope,
            item: {
              type: "auxiliary_usage",
              source: "session_title",
              occurredAt: item.occurredAt,
              requestId: item.requestId,
              provider: item.provider,
              model: item.model,
              usage: item.usage,
            },
          })
        } else if (
          item.type === "turn_completed" ||
          item.type === "turn_usage"
        ) {
          if (
            typeof item.turnId !== "string" ||
            (item.type === "turn_completed" &&
              !["completed", "failed", "interrupted"].includes(
                String(item.outcome),
              )) ||
            (item.type === "turn_usage" && item.usage === undefined) ||
            (item.usage !== undefined && !isTokenUsage(item.usage))
          )
            throw new Error("Invalid recorded token usage.")
          records.push({
            ...envelope,
            item: {
              type: item.type,
              turnId: item.turnId,
              ...(item.usage === undefined ? {} : { usage: item.usage }),
            },
          })
        } else if (
          ![
            "model_context",
            "response_item",
            "turn_started",
            "agent_status",
            "agent_message",
            "item_started",
            "item_completed",
            "world_state",
            "compacted",
            "token_count",
          ].includes(String(item.type))
        ) {
          throw new Error("Unsupported usage record type.")
        }
      }
      if (
        owner === undefined ||
        (position !== undefined && expectedSeq !== position.endSeqExclusive)
      )
        throw new Error("Incomplete usage history boundary.")
      return [
        ...(base === undefined ? [] : await materialize(base.rolloutId, base)),
        ...records,
      ]
    } finally {
      seen.delete(rolloutId)
    }
  }
  return {
    metadata,
    rollout: await materialize(metadata.rolloutId, undefined, metadata.id),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function isPosition(value: unknown): value is HistoryPosition {
  return (
    isRecord(value) &&
    isStorageKey(value.rolloutId) &&
    Number.isSafeInteger(value.endSeqExclusive) &&
    Number(value.endSeqExclusive) >= 1 &&
    Number.isSafeInteger(value.endByteOffset) &&
    Number(value.endByteOffset) > 0
  )
}
