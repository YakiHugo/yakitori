import type { JsonObject } from "../kernel/events.ts"
import { applyJsonMergePatch } from "../kernel/json-equality.ts"
import type { ResponseItemEnvelope, StoredThread } from "./rollout.ts"

export type ContextSnapshot = {
  readonly history: readonly ResponseItemEnvelope[]
  readonly worldStateBaseline?: JsonObject
}

// SessionState owns model-visible history. Rollout storage reconstructs this
// value on resume but never defines what transient Session state may exist.
export class ContextManager {
  #history: ResponseItemEnvelope[]
  #worldStateBaseline: JsonObject | undefined

  constructor(snapshot: ContextSnapshot = { history: [] }) {
    this.#history = structuredClone([...snapshot.history])
    this.#worldStateBaseline =
      snapshot.worldStateBaseline === undefined
        ? undefined
        : structuredClone(snapshot.worldStateBaseline)
  }

  static fromStoredThread(thread: StoredThread): ContextManager {
    let history: ResponseItemEnvelope[] = []
    let worldStateBaseline: JsonObject | undefined
    for (const record of thread.rollout) {
      const item = record.item
      if (item.type === "response_item" || item.type === "agent_message") {
        history.push(item.item)
      } else if (item.type === "compacted") {
        history = structuredClone([...item.replacement])
        worldStateBaseline = undefined
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
      history,
      ...(worldStateBaseline === undefined ? {} : { worldStateBaseline }),
    })
  }

  snapshot(): ContextSnapshot {
    return {
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
    this.#history = structuredClone([...items])
    this.#worldStateBaseline = undefined
  }

  setWorldStateBaseline(state: JsonObject): void {
    this.#worldStateBaseline = structuredClone(state)
  }
}
