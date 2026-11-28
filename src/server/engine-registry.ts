import type { DatabaseSync } from "node:sqlite"
import type { RolloutAssets } from "../core/rollout-assets.ts"
import type { UserAttachment } from "../protocol/asset-types.ts"
import type {
  EngineDescriptor,
  EngineRpcParams,
  EngineSessionSearchResult,
  EngineSessionSnapshot,
  EngineSessionSummary,
} from "../protocol/engine.ts"
import { projectEngineSession } from "../shared/acp-execution-view.ts"
import type { AcpEngineConfiguration } from "./engine-configuration.ts"
import { createAcpEngine } from "./engines/acp/adapter.ts"
import type { EngineAdapter } from "./engines/engine.ts"
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
    database: DatabaseSync
    workspace: string
    changed: (sessionId: string) => void
    rolloutAssets?: () => RolloutAssets
  }) {
    this.#workspace = options.workspace
    try {
      for (const config of options.configurations) {
        const assets = options.rolloutAssets
        const adapter = createAcpEngine({
          id: config.id,
          command: config.command,
          ...(config.args === undefined ? {} : { args: [...config.args] }),
          ...(assets === undefined
            ? {}
            : { readAttachment: (source) => assets().read(source) }),
        })
        this.#entries.set(config.id, {
          label: config.label,
          adapter,
          available: true,
          service: createExternalSessionService({
            engine: adapter,
            database: options.database,
            changed: options.changed,
            ...(assets === undefined
              ? {}
              : {
                  prepareAttachments: (
                    id: string,
                    requestId: string,
                    attachments: readonly UserAttachment[],
                  ) => assets().copyAttachments(id, requestId, attachments),
                }),
          }),
        })
      }
      for (const id of listStoredExternalEngineIds(options.database)) {
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
            database: options.database,
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

  async inspect(engineId: string): Promise<EngineDescriptor> {
    const entry = this.#entries.get(engineId)
    if (!entry?.available)
      throw new EngineRegistryError(
        `External engine is not configured: ${engineId}`,
      )
    await entry.adapter.connect()
    return {
      id: engineId,
      label: entry.label,
      kind: "acp",
      available: true,
      capabilities: entry.adapter.capabilities,
    }
  }

  list(): readonly EngineSessionSummary[] {
    return [...this.#entries.values()]
      .flatMap(({ service }) => service.list().map(summary))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  search(term: string, offset = 0): EngineSessionSearchResult {
    const needle = term.toLowerCase()
    const sessions = this.list()
    const matches: EngineSessionSearchResult["matches"][number][] = []
    // Bound the number of full transcript projections per foreground search page.
    const end = Math.min(sessions.length, offset + 25)
    for (const engineSession of sessions.slice(offset, end)) {
      const title = engineSession.title ?? ""
      let match = title.toLowerCase().includes(needle) ? title : undefined
      if (match === undefined) {
        const snapshot = this.read(engineSession.id)
        const { entries } = projectEngineSession(snapshot).executionView
        for (const entry of entries) {
          if (entry.kind !== "assistant" && entry.kind !== "user_input")
            continue
          if (!entry.text.toLowerCase().includes(needle)) continue
          match = entry.text
          break
        }
      }
      if (match !== undefined) {
        const location = match.toLowerCase().indexOf(needle)
        const start = Math.max(0, location - 48)
        const stop = Math.min(match.length, location + term.length + 72)
        matches.push({
          engineSession,
          snippet: `${start === 0 ? "" : "…"}${match.slice(start, stop)}${stop === match.length ? "" : "…"}`,
        })
      }
    }
    return { matches, ...(end < sessions.length ? { nextOffset: end } : {}) }
  }

  hasSession(id: string): boolean {
    return [...this.#entries.values()].some(({ service }) =>
      service.hasSession(id),
    )
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
      ...(input.content === undefined ? {} : { content: input.content }),
    })
  }

  cancel(input: EngineRpcParams["engineSession/cancel"]) {
    return this.#service(input.sessionId, true).cancel(
      input.sessionId,
      input.turnId,
    )
  }

  configure(input: EngineRpcParams["engineSession/configure"]) {
    return this.#service(input.sessionId, true).configure(
      input.sessionId,
      input.configId,
      input.value,
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
      if (!service.hasSession(id)) continue
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
