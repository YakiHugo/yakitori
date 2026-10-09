import type {
  EngineAdapter,
  EngineBinding,
  EngineInput,
  EnginePermissionResponse,
} from "./engines/engine.ts"

// App identity and display metadata remain outside engine-owned context. Native
// sessions use an identity binding; other engines retain their opaque IDs here.
export class AppSessionService {
  readonly #engine: EngineAdapter
  readonly #bindings = new Map<string, EngineBinding>()
  readonly #bindingTasks = new Map<string, Promise<EngineBinding>>()

  constructor(engine: EngineAdapter) {
    this.#engine = engine
  }

  async bind(input: {
    appSessionId: string
    engineSessionId?: string
    cwd: string
  }): Promise<EngineBinding> {
    const existing = this.#bindings.get(input.appSessionId)
    if (existing !== undefined) {
      if (
        existing.cwd !== input.cwd ||
        (input.engineSessionId !== undefined &&
          existing.engineSessionId !== input.engineSessionId)
      )
        throw new Error(
          "App session is already bound to another engine context.",
        )
      return existing
    }
    const pending = this.#bindingTasks.get(input.appSessionId)
    if (pending !== undefined) {
      await pending
      return this.bind(input)
    }
    const bindingTask = (async () => {
      await this.#engine.connect()
      const binding = await this.#engine.bind(input)
      this.#bindings.set(input.appSessionId, binding)
      return binding
    })()
    this.#bindingTasks.set(input.appSessionId, bindingTask)
    try {
      return await bindingTask
    } finally {
      this.#bindingTasks.delete(input.appSessionId)
    }
  }

  send(appSessionId: string, input: EngineInput) {
    return this.#engine.send(this.#binding(appSessionId), input)
  }

  cancel(appSessionId: string, turnId: string, reason?: string) {
    return this.#engine.cancel(this.#binding(appSessionId), turnId, reason)
  }

  respondPermission(appSessionId: string, response: EnginePermissionResponse) {
    return this.#engine.respondPermission(this.#binding(appSessionId), response)
  }

  subscribe(
    appSessionId: string,
    listener: Parameters<EngineAdapter["subscribe"]>[1],
  ) {
    return this.#engine.subscribe(this.#binding(appSessionId), listener)
  }

  async close(): Promise<void> {
    await this.#engine.close()
    this.#bindings.clear()
  }

  #binding(appSessionId: string): EngineBinding {
    const binding = this.#bindings.get(appSessionId)
    if (binding === undefined)
      throw new Error(`App session ${appSessionId} is not bound.`)
    return binding
  }
}
