import type { JsonObject } from "../kernel/events.ts"
import { applyJsonMergePatch } from "../kernel/json-equality.ts"
import type {
  ModelContextSettings,
  ResponseItemEnvelope,
  StoredThread,
} from "./rollout.ts"

export type ContextSnapshot = Readonly<{
  previousModel?: ModelContextSettings
  activeContextTokens?: number
  autoCompactPrefillTokens?: number
  autoCompactPrefillEstimated?: boolean
  contextTokenHistoryAnchorItemId?: string
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
    this.#contextTokenProvider = snapshot.contextTokenProvider
    this.#contextTokenModel = snapshot.contextTokenModel
    this.#history = structuredClone([...snapshot.history])
    this.#worldStateBaseline =
      snapshot.worldStateBaseline === undefined
        ? undefined
        : structuredClone(snapshot.worldStateBaseline)
  }

  static fromStoredThread(thread: StoredThread): ContextManager {
    let history: ResponseItemEnvelope[] = []
    let worldStateBaseline: JsonObject | undefined
    let activeContextTokens: number | undefined
    let autoCompactPrefillTokens: number | undefined
    let autoCompactPrefillEstimated = false
    let contextTokenHistoryAnchorItemId: string | undefined
    let contextTokenProvider: string | undefined
    let contextTokenModel: string | undefined
    let previousModel: ModelContextSettings | undefined
    for (const record of thread.rollout) {
      const item = record.item
      if (item.type === "model_context") previousModel = item.settings
      if (item.type === "response_item" || item.type === "agent_message") {
        history.push(item.item)
      } else if (item.type === "compacted") {
        activeContextTokens = undefined
        autoCompactPrefillTokens = undefined
        autoCompactPrefillEstimated = false
        contextTokenHistoryAnchorItemId = undefined
        contextTokenProvider = undefined
        contextTokenModel = undefined
        history = structuredClone([...item.replacement])
        worldStateBaseline = undefined
      } else if (item.type === "token_count") {
        activeContextTokens = item.activeContextTokens
        autoCompactPrefillTokens = item.autoCompactPrefillTokens
        autoCompactPrefillEstimated = item.autoCompactPrefillEstimated ?? false
        contextTokenHistoryAnchorItemId = item.historyAnchorItemId
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
    this.#history.push(...structuredClone([...items]))
  }

  replace(items: readonly ResponseItemEnvelope[]): void {
    this.#activeContextTokens = undefined
    this.#autoCompactPrefillTokens = undefined
    this.#autoCompactPrefillEstimated = false
    this.#contextTokenHistoryAnchorItemId = undefined
    this.#contextTokenProvider = undefined
    this.#contextTokenModel = undefined
    this.#history = structuredClone([...items])
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
      provider: string
      model: string
    }>,
  ): Readonly<{
    activeContextTokens: number
    autoCompactPrefillTokens?: number
    autoCompactPrefillEstimated?: boolean
    historyAnchorItemId: string
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
    this.#contextTokenProvider = input.provider
    this.#contextTokenModel = input.model
  }

  setPreviousModel(settings: ModelContextSettings): void {
    this.#previousModel = { ...settings }
  }
}
