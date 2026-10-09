import type {
  EngineDescriptor,
  EngineRpcParams,
  EngineSessionSnapshot,
  EngineSessionSummary,
} from "../protocol/engine.ts"
import { createAcpEngine } from "./engines/acp/adapter.ts"
import type { EngineAdapter } from "./engines/engine.ts"
import type { AcpEngineConfiguration } from "./engine-configuration.ts"
import {
  createExternalSessionService,
  type ExternalAppSession,
  type ExternalSessionService,
  listStoredExternalEngineIds,
} from "./external-session-service.ts"

export class EngineRegistryError extends Error {}

const unavailableCapabilities = {
  resume: false,
  load: false,
  list: false,
  fork: false,
  steer: false,
  queue: false,
  subagents: false,
}

export class EngineRegistry {
  readonly #entries = new Map<
    string,
    {
      label: string
      adapter: EngineAdapter
      service: ExternalSessionService
      available: boolean
    }
  >()
  readonly #workspace: string

  constructor(options: {
    configurations: readonly AcpEngineConfiguration[]
    databasePath: string
    workspace: string
    changed: (sessionId: string) => void
  }) {
    this.#workspace = options.workspace
    try {
      for (const config of options.configurations) {
        const adapter = createAcpEngine({
          id: config.id,
          command: config.command,
          ...(config.args === undefined ? {} : { args: [...config.args] }),
        })
        this.#entries.set(config.id, {
          label: config.label,
          adapter,
          available: true,
          service: createExternalSessionService({
            engine: adapter,
            databasePath: options.databasePath,
            changed: options.changed,
          }),
        })
      }
      for (const id of listStoredExternalEngineIds(options.databasePath)) {
        if (this.#entries.has(id)) continue
        const unavailable = async (): Promise<never> => {
          throw new EngineRegistryError(
            `Engine ${id} is not configured. Its observed history is still available.`,
          )
        }
        const adapter: EngineAdapter = {
          id,
          capabilities: unavailableCapabilities,
          connect: unavailable,
          bind: unavailable,
          send: unavailable,
          cancel: unavailable,
          respondPermission: unavailable,
          subscribe: () => () => {},
          close: async () => {},
        }
        this.#entries.set(id, {
          label: id,
          adapter,
          available: false,
          service: createExternalSessionService({
            engine: adapter,
            databasePath: options.databasePath,
            changed: options.changed,
          }),
        })
      }
    } catch (error) {
      // Construction never starts a subprocess. Release already-open stores.
      for (const entry of this.#entries.values()) void entry.service.close()
      throw error
    }
  }

  engines(): readonly EngineDescriptor[] {
    return [
      {
        id: "yakitori",
        label: "Yakitori",
        kind: "native",
        available: true,
        capabilities: {
          resume: true,
          load: true,
          list: true,
          fork: true,
          steer: true,
          queue: true,
          subagents: true,
        },
      },
      ...[...this.#entries].map(([id, entry]) => ({
        id,
        label: entry.label,
        kind: "acp" as const,
        available: entry.available,
        capabilities: entry.adapter.capabilities,
      })),
    ]
  }

  async create(
    input: EngineRpcParams["engineSession/create"],
  ): Promise<EngineSessionSnapshot> {
    const entry = this.#entries.get(input.engineId)
    if (!entry?.available)
      throw new EngineRegistryError(
        `External engine is not configured: ${input.engineId}`,
      )
    const session = await entry.service.create({
      cwd: input.cwd ?? this.#workspace,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    })
    return this.read(session.id)
  }

  list(): readonly EngineSessionSummary[] {
    return [...this.#entries.values()]
      .flatMap(({ service }) => service.list().map(summary))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  read(id: string): EngineSessionSnapshot {
    const snapshot = this.#service(id).read(id)
    if (!snapshot)
      throw new EngineRegistryError(`External session was not found: ${id}`)
    return { ...snapshot, session: summary(snapshot.session) }
  }

  send(input: EngineRpcParams["engineSession/send"]) {
    return this.#service(input.sessionId, true).send(input.sessionId, {
      requestId: input.requestId,
      text: input.text,
    })
  }

  cancel(input: EngineRpcParams["engineSession/cancel"]) {
    return this.#service(input.sessionId, true).cancel(
      input.sessionId,
      input.turnId,
    )
  }

  respondPermission(input: EngineRpcParams["engineSession/respondPermission"]) {
    return this.#service(input.sessionId, true).respondPermission(
      input.sessionId,
      {
        requestId: input.requestId,
        optionId: input.optionId,
        ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      },
    )
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#entries.values()].map(({ service }) => service.close()),
    )
    const errors = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason)
    if (errors.length)
      throw new AggregateError(errors, "Could not close external engines.")
  }

  #service(id: string, requireAvailable = false): ExternalSessionService {
    for (const { service, available, adapter } of this.#entries.values()) {
      if (!service.read(id)) continue
      if (requireAvailable && !available)
        throw new EngineRegistryError(
          `Engine ${adapter.id} is not configured. Its observed history is still available.`,
        )
      return service
    }
    throw new EngineRegistryError(`External session was not found: ${id}`)
  }
}

function summary(session: ExternalAppSession): EngineSessionSummary {
  const { binding, ...metadata } = session
  return { ...metadata, engineId: binding.engineId, cwd: binding.cwd }
}
