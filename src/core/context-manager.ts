import type { JsonObject, ModelToolContentBlock } from "../kernel/events.ts"
import { applyJsonMergePatch } from "../kernel/json-equality.ts"
import type {
  ModelContextSettings,
  HistoryOutputBudget,
  ResponseItemEnvelope,
  StoredThread,
} from "./rollout.ts"

export type ContextSnapshot = Readonly<{
  previousModel?: ModelContextSettings
  activeContextTokens?: number
  autoCompactPrefillTokens?: number
  autoCompactPrefillEstimated?: boolean
  contextTokenHistoryAnchorItemId?: string
  contextTokenHistoryAnchorTokens?: number
  contextTokenProvider?: string
  contextTokenModel?: string
  history: readonly ResponseItemEnvelope[]
  worldStateBaseline?: JsonObject
}>

// SessionState owns model-visible history. Rollout storage reconstructs this
// value on resume but never defines what transient Session state may exist.
export class ContextManager {
  #previousModel: ModelContextSettings | undefined
  #activeContextTokens: number | undefined
  #autoCompactPrefillTokens: number | undefined
  #autoCompactPrefillEstimated = false
  #contextTokenHistoryAnchorItemId: string | undefined
  #contextTokenHistoryAnchorTokens: number | undefined
  #contextTokenProvider: string | undefined
  #contextTokenModel: string | undefined
  #history: ResponseItemEnvelope[]
  #worldStateBaseline: JsonObject | undefined

  constructor(snapshot: ContextSnapshot = { history: [] }) {
    this.#previousModel =
      snapshot.previousModel === undefined
        ? undefined
        : { ...snapshot.previousModel }
    this.#activeContextTokens = snapshot.activeContextTokens
    this.#autoCompactPrefillTokens = snapshot.autoCompactPrefillTokens
    this.#autoCompactPrefillEstimated =
      snapshot.autoCompactPrefillEstimated ?? false
    this.#contextTokenHistoryAnchorItemId =
      snapshot.contextTokenHistoryAnchorItemId
    this.#contextTokenHistoryAnchorTokens =
      snapshot.contextTokenHistoryAnchorTokens
    this.#contextTokenProvider = snapshot.contextTokenProvider
    this.#contextTokenModel = snapshot.contextTokenModel
    this.#history = structuredClone([...snapshot.history])
    this.#worldStateBaseline =
      snapshot.worldStateBaseline === undefined
        ? undefined
        : structuredClone(snapshot.worldStateBaseline)
  }

  static fromStoredThread(
    thread: Pick<StoredThread, "rollout">,
  ): ContextManager {
    let history: ResponseItemEnvelope[] = []
    let worldStateBaseline: JsonObject | undefined
    let activeContextTokens: number | undefined
    let autoCompactPrefillTokens: number | undefined
    let autoCompactPrefillEstimated = false
    let contextTokenHistoryAnchorItemId: string | undefined
    let contextTokenHistoryAnchorTokens: number | undefined
    let contextTokenProvider: string | undefined
    let contextTokenModel: string | undefined
    let previousModel: ModelContextSettings | undefined
    for (const record of thread.rollout) {
      const item = record.item
      if (item.type === "model_context") previousModel = item.settings
      if (item.type === "response_item" || item.type === "agent_message") {
        history.push(projectHistoryItem(item.item))
      } else if (item.type === "compacted") {
        activeContextTokens = undefined
        autoCompactPrefillTokens = undefined
        autoCompactPrefillEstimated = false
        contextTokenHistoryAnchorItemId = undefined
        contextTokenHistoryAnchorTokens = undefined
        contextTokenProvider = undefined
        contextTokenModel = undefined
        history = item.replacement.map(projectHistoryItem)
        worldStateBaseline = undefined
      } else if (item.type === "token_count") {
        activeContextTokens = item.activeContextTokens
        autoCompactPrefillTokens = item.autoCompactPrefillTokens
        autoCompactPrefillEstimated = item.autoCompactPrefillEstimated ?? false
        contextTokenHistoryAnchorItemId = item.historyAnchorItemId
        contextTokenHistoryAnchorTokens = item.historyAnchorTokens
        contextTokenProvider = item.provider
        contextTokenModel = item.model
      } else if (item.type === "world_state") {
        if (item.full) {
          worldStateBaseline = structuredClone(item.state)
        } else if (worldStateBaseline !== undefined) {
          worldStateBaseline = applyJsonMergePatch(
            worldStateBaseline,
            item.state,
          )
        }
      }
    }
    return new ContextManager({
      ...(previousModel === undefined ? {} : { previousModel }),
      ...(activeContextTokens === undefined ? {} : { activeContextTokens }),
      ...(autoCompactPrefillTokens === undefined
        ? {}
        : { autoCompactPrefillTokens }),
      ...(autoCompactPrefillEstimated
        ? { autoCompactPrefillEstimated: true }
        : {}),
      ...(contextTokenHistoryAnchorItemId === undefined
        ? {}
        : { contextTokenHistoryAnchorItemId }),
      ...(contextTokenHistoryAnchorTokens === undefined
        ? {}
        : { contextTokenHistoryAnchorTokens }),
      ...(contextTokenProvider === undefined ? {} : { contextTokenProvider }),
      ...(contextTokenModel === undefined ? {} : { contextTokenModel }),
      history,
      ...(worldStateBaseline === undefined ? {} : { worldStateBaseline }),
    })
  }

  snapshot(): ContextSnapshot {
    return {
      ...(this.#previousModel === undefined
        ? {}
        : { previousModel: { ...this.#previousModel } }),
      ...(this.#activeContextTokens === undefined
        ? {}
        : { activeContextTokens: this.#activeContextTokens }),
      ...(this.#autoCompactPrefillTokens === undefined
        ? {}
        : { autoCompactPrefillTokens: this.#autoCompactPrefillTokens }),
      ...(this.#autoCompactPrefillEstimated
        ? { autoCompactPrefillEstimated: true }
        : {}),
      ...(this.#contextTokenHistoryAnchorItemId === undefined
        ? {}
        : {
            contextTokenHistoryAnchorItemId:
              this.#contextTokenHistoryAnchorItemId,
          }),
      ...(this.#contextTokenHistoryAnchorTokens === undefined
        ? {}
        : {
            contextTokenHistoryAnchorTokens:
              this.#contextTokenHistoryAnchorTokens,
          }),
      ...(this.#contextTokenProvider === undefined
        ? {}
        : { contextTokenProvider: this.#contextTokenProvider }),
      ...(this.#contextTokenModel === undefined
        ? {}
        : { contextTokenModel: this.#contextTokenModel }),
      history: structuredClone(this.#history),
      ...(this.#worldStateBaseline === undefined
        ? {}
        : { worldStateBaseline: structuredClone(this.#worldStateBaseline) }),
    }
  }

  record(items: readonly ResponseItemEnvelope[]): void {
    this.#history.push(...items.map(projectHistoryItem))
  }

  replace(items: readonly ResponseItemEnvelope[]): void {
    this.#activeContextTokens = undefined
    this.#autoCompactPrefillTokens = undefined
    this.#autoCompactPrefillEstimated = false
    this.#contextTokenHistoryAnchorItemId = undefined
    this.#contextTokenHistoryAnchorTokens = undefined
    this.#contextTokenProvider = undefined
    this.#contextTokenModel = undefined
    this.#history = items.map(projectHistoryItem)
    this.#worldStateBaseline = undefined
  }

  setWorldStateBaseline(state: JsonObject): void {
    this.#worldStateBaseline = structuredClone(state)
  }

  contextTokensAfterUpdate(
    input: Readonly<{
      activeContextTokens: number
      inputTokens?: number
      estimatedPrefill?: boolean
      historyAnchorItemId: string
      historyAnchorTokens?: number
      provider: string
      model: string
    }>,
  ): Readonly<{
    activeContextTokens: number
    autoCompactPrefillTokens?: number
    autoCompactPrefillEstimated?: boolean
    historyAnchorItemId: string
    historyAnchorTokens?: number
    provider: string
    model: string
  }> {
    const identityChanged =
      this.#activeContextTokens !== undefined &&
      (this.#contextTokenProvider !== input.provider ||
        this.#contextTokenModel !== input.model)
    const replacePrefill =
      input.inputTokens !== undefined &&
      (identityChanged ||
        this.#autoCompactPrefillTokens === undefined ||
        (this.#autoCompactPrefillEstimated && input.estimatedPrefill !== true))
    const autoCompactPrefillTokens = replacePrefill
      ? input.inputTokens
      : this.#autoCompactPrefillTokens
    const autoCompactPrefillEstimated = replacePrefill
      ? input.estimatedPrefill === true
      : this.#autoCompactPrefillEstimated
    return {
      activeContextTokens: input.activeContextTokens,
      ...(autoCompactPrefillTokens === undefined
        ? {}
        : { autoCompactPrefillTokens }),
      ...(autoCompactPrefillEstimated
        ? { autoCompactPrefillEstimated: true }
        : {}),
      historyAnchorItemId: input.historyAnchorItemId,
      ...(input.historyAnchorTokens === undefined
        ? {}
        : { historyAnchorTokens: input.historyAnchorTokens }),
      provider: input.provider,
      model: input.model,
    }
  }

  setContextTokens(
    input: ReturnType<ContextManager["contextTokensAfterUpdate"]>,
  ): void {
    this.#activeContextTokens = input.activeContextTokens
    this.#autoCompactPrefillTokens = input.autoCompactPrefillTokens
    this.#autoCompactPrefillEstimated =
      input.autoCompactPrefillEstimated ?? false
    this.#contextTokenHistoryAnchorItemId = input.historyAnchorItemId
    this.#contextTokenHistoryAnchorTokens = input.historyAnchorTokens
    this.#contextTokenProvider = input.provider
    this.#contextTokenModel = input.model
  }

  setPreviousModel(settings: ModelContextSettings): void {
    this.#previousModel = { ...settings }
  }
}

// Rollouts retain the original result. Live and restored history both use the
// budget captured at tool completion; a later model change cannot enlarge it.
function projectHistoryItem(
  envelope: ResponseItemEnvelope,
): ResponseItemEnvelope {
  const copied = structuredClone(envelope)
  const budget = copied.historyOutputBudget
  if (copied.item.role !== "tool" || budget === undefined) return copied
  let remainingBytes = budget.maxBytes
  let remainingLines = budget.maxLines
  let toolContentTruncated = false
  let textBlockCount = 0
  let retainedToolContentBlockCount = 0
  const content = copied.item.content.flatMap<ModelToolContentBlock>(
    (block, index) => {
      const isToolContent =
        index < (copied.toolContentBlockCount ?? copied.item.content.length)
      if (block.type !== "text") {
        if (isToolContent) retainedToolContentBlockCount++
        return [block]
      }
      const separatorBytes = textBlockCount > 0 ? 1 : 0
      const text = truncateHistoryText(block.text, {
        maxBytes: Math.max(0, remainingBytes - separatorBytes),
        maxLines: remainingLines,
      })
      if (isToolContent) {
        toolContentTruncated ||= text !== block.text
      }
      if (text === "") return []
      if (isToolContent) retainedToolContentBlockCount++
      textBlockCount++
      remainingBytes = Math.max(
        0,
        remainingBytes - Buffer.byteLength(text) - separatorBytes,
      )
      remainingLines = Math.max(0, remainingLines - text.split("\n").length)
      return [{ ...block, text }]
    },
  )
  const item = { ...copied.item, content }
  if (toolContentTruncated) delete item.fileObservations
  return {
    ...copied,
    item,
    ...(copied.toolContentBlockCount === undefined
      ? {}
      : { toolContentBlockCount: retainedToolContentBlockCount }),
  }
}

function truncateHistoryText(
  text: string,
  budget: HistoryOutputBudget,
): string {
  const lines = text.split("\n")
  if (
    Buffer.byteLength(text) <= budget.maxBytes &&
    lines.length <= budget.maxLines
  )
    return text
  if (budget.maxBytes === 0 || budget.maxLines === 0) return ""
  const marker = "[Output truncated.]"
  if (budget.maxBytes < Buffer.byteLength(marker)) return ""
  if (budget.maxLines === 1) return marker
  const bytes = budget.maxBytes - Buffer.byteLength(marker) - 2
  if (bytes <= 0) return marker
  const headLines = Math.floor((budget.maxLines - 1) / 2)
  const head = Buffer.from(lines.slice(0, headLines).join("\n"))
  let headEnd = Math.min(head.length, Math.floor(bytes / 2))
  while (headEnd > 0 && ((head[headEnd] ?? 0) & 0xc0) === 0x80) headEnd--
  const tail = Buffer.from(
    lines.slice(-Math.max(1, budget.maxLines - 1 - headLines)).join("\n"),
  )
  let tailStart = Math.max(0, tail.length - (bytes - headEnd))
  while (tailStart < tail.length && ((tail[tailStart] ?? 0) & 0xc0) === 0x80)
    tailStart++
  return [
    head.subarray(0, headEnd).toString("utf8"),
    marker,
    tail.subarray(tailStart).toString("utf8"),
  ]
    .filter((part) => part !== "")
    .join("\n")
}
