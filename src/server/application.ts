import { realpath, stat } from "node:fs/promises"
import { join } from "node:path"
import {
  createSessionKernel,
  createSqliteEventStore,
  type SessionKernel,
} from "../kernel/index.ts"
import {
  createMateKernel,
  createSqliteMateStore,
  MateLifecycle,
  type MateKernel,
  type MateProjection,
} from "../mates/index.ts"
import {
  acquireRuntimeLock,
  createAnthropicProvider,
  createOpenAIProvider,
  createPermissionGate,
  createSessionRunner,
  createToolRegistry,
  createTransientEventHub,
  ModelStopReason,
  recoverSessions,
  type PermissionGate,
  type RuntimeLock,
  type SessionRunner,
  type StreamFn,
  type TransientEventHub,
} from "../runtime/index.ts"
import { createDurableEventHub, type DurableEventHub } from "./event-hub.ts"
import {
  createServerHandlers,
  type SessionCreateDefaults,
  type ServerHandlers,
} from "./handlers.ts"
import { createYakitoriHttpServer } from "./http.ts"

const defaultMateProfile = {
  instructions:
    "You are Yakitori's default Mate. Keep changes small, reversible, and well tested.",
  name: "Yakitori",
  role: "Assistant",
} as const

export type YakitoriApplicationOptions = {
  readonly activeMateId?: string
  readonly databasePath?: string
  readonly rootDir?: string
  readonly workspace?: string
  readonly stream?: StreamFn
  readonly provider?: string
  readonly model?: string
  readonly fauxScenario?: string
  readonly recoverOnStart?: boolean
  readonly acquireLock?: boolean
}

export type YakitoriApplication = {
  readonly databasePath: string
  readonly eventHub: DurableEventHub
  readonly transientHub: TransientEventHub
  readonly handlers: ServerHandlers
  readonly mateKernel: MateKernel
  readonly permissionGate: PermissionGate
  readonly runner: SessionRunner
  readonly rootDir: string
  readonly sessionDefaults: SessionCreateDefaults
  readonly sessionKernel: SessionKernel
  readonly workspace: string
  readonly activeMate: {
    readonly mateId: string
    readonly mateRevisionId: string
    readonly name: string
    readonly revision: number
  }
  createHttpServer(): ReturnType<typeof createYakitoriHttpServer>
  close(): Promise<void>
}

export async function createYakitoriApplication(
  options: YakitoriApplicationOptions = {},
): Promise<YakitoriApplication> {
  const rootDir = options.rootDir ?? ".yakitori"
  const databasePath = options.databasePath ?? join(rootDir, "events.sqlite")
  const workspace = await resolveWorkspaceDirectory(
    options.workspace ?? process.env.YAKITORI_WORKSPACE ?? process.cwd(),
  )
  const activeMateId =
    options.activeMateId ?? process.env.YAKITORI_MATE_ID ?? undefined
  const shouldLock = options.acquireLock ?? true
  const shouldRecover = options.recoverOnStart ?? true

  let runtimeLock: RuntimeLock | undefined
  if (shouldLock) {
    runtimeLock = await acquireRuntimeLock(rootDir)
  }

  const eventStore = createSqliteEventStore({ databasePath })
  const mateStore = createSqliteMateStore({ databasePath })
  const sessionKernel = createSessionKernel(eventStore)
  const mateKernel = createMateKernel(mateStore)
  const eventHub = createDurableEventHub()
  const transientHub = createTransientEventHub()
  const permissionGate = createPermissionGate()
  const toolRegistry = createToolRegistry()

  try {
    const activeMate = await resolveActiveMate(mateKernel, activeMateId)
    const sessionDefaults: SessionCreateDefaults = {
      workingDirectory: workspace,
      mateId: activeMate.id,
      mateRevisionId: activeMate.currentRevision.id,
    }
    const providerName =
      options.provider ?? process.env.YAKITORI_PROVIDER ?? "faux"
    const provider =
      options.stream === undefined
        ? createDefaultProvider(
            providerName,
            options.model ?? process.env.YAKITORI_MODEL ?? undefined,
            options.fauxScenario ?? process.env.YAKITORI_FAUX_SCENARIO,
          )
        : {
            stream: options.stream,
            provider: providerName,
            model:
              options.model ??
              process.env.YAKITORI_MODEL ??
              (providerName === "faux" ? "scripted" : "injected"),
          }

    const runner = createSessionRunner({
      kernel: sessionKernel,
      mateKernel,
      stream: provider.stream,
      provider: provider.provider,
      model: provider.model,
      durableHub: eventHub,
      transientHub,
      permissionGate,
      toolRegistry,
    })

    const handlers = createServerHandlers(sessionKernel, {
      eventHub,
      sessionDefaults,
      wakeSession: (sessionId) => {
        void runner.wake(sessionId).catch((error) => {
          console.error("Session wake failed", error)
        })
      },
      onPermissionResolved: (input) => {
        permissionGate.notify(input)
      },
      interruptTurn: async (input) => {
        await runner.interrupt(input)
      },
    })

    if (shouldRecover) {
      await recoverSessions({
        kernel: sessionKernel,
        publish: (events) => eventHub.publish(events),
        wake: (sessionId) => runner.wake(sessionId),
        onWakeError: (error, sessionId) => {
          console.error(`Recovered Session wake failed: ${sessionId}`, error)
        },
      })
    }

    let closed = false
    return {
      databasePath,
      eventHub,
      transientHub,
      handlers,
      mateKernel,
      permissionGate,
      runner,
      rootDir,
      sessionDefaults,
      sessionKernel,
      workspace,
      activeMate: {
        mateId: activeMate.id,
        mateRevisionId: activeMate.currentRevision.id,
        name: activeMate.currentRevision.name,
        revision: activeMate.currentRevision.revision,
      },
      createHttpServer() {
        return createYakitoriHttpServer({
          eventHub,
          transientHub,
          handlers,
        })
      },
      async close() {
        if (closed) return
        closed = true
        await runner.close()
        mateStore.close()
        eventStore.close()
        await runtimeLock?.release()
      },
    }
  } catch (error) {
    mateStore.close()
    eventStore.close()
    await runtimeLock?.release()
    throw error
  }
}

export async function resolveWorkspaceDirectory(
  workspace: string,
): Promise<string> {
  let resolved: string
  try {
    resolved = await realpath(workspace)
  } catch (error) {
    throw new Error(`Workspace path does not exist: ${workspace}`, {
      cause: error,
    })
  }

  const stats = await stat(resolved)
  if (!stats.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${workspace}`)
  }
  return resolved
}

async function resolveActiveMate(
  mateKernel: MateKernel,
  configuredMateId: string | undefined,
): Promise<MateProjection> {
  if (configuredMateId !== undefined) {
    const read = await mateKernel.readMate({ mateId: configuredMateId })
    if (!read.mate) {
      throw new Error(`Configured Mate was not found: ${configuredMateId}`)
    }
    if (read.mate.lifecycle !== MateLifecycle.Active) {
      throw new Error(`Configured Mate is inactive: ${configuredMateId}`)
    }
    return read.mate
  }

  const activeMates = await listAllActiveMateIds(mateKernel)

  if (activeMates.length > 1) {
    throw new Error(
      `Multiple active Mates found (${activeMates.join(", ")}). Set YAKITORI_MATE_ID to select one.`,
    )
  }

  const mateId = activeMates[0]
  if (mateId !== undefined) {
    const read = await mateKernel.readMate({ mateId })
    if (!read.mate) {
      throw new Error(`Active Mate was not found: ${mateId}`)
    }
    return read.mate
  }

  const created = await mateKernel.createMate({ ...defaultMateProfile })
  return created.mate
}

async function listAllActiveMateIds(mateKernel: MateKernel): Promise<string[]> {
  const activeMateIds: string[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await mateKernel.listMates({
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    })
    for (const mate of page.mates) {
      if (mate.lifecycle === MateLifecycle.Active) activeMateIds.push(mate.id)
    }
    if (page.nextCursor === undefined) return activeMateIds
    cursor = page.nextCursor
  }
}

function createDefaultProvider(
  provider: string,
  model: string | undefined,
  fauxScenario: string | undefined,
): {
  readonly stream: StreamFn
  readonly provider: string
  readonly model: string
} {
  if (provider === "faux") {
    const scenario = fauxScenario ?? "text"
    return {
      stream: createFauxScenarioStream(scenario),
      provider,
      model: model ?? "scripted",
    }
  }
  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is required when YAKITORI_PROVIDER=anthropic.",
      )
    }
    if (!model) {
      throw new Error(
        "YAKITORI_MODEL is required when YAKITORI_PROVIDER=anthropic.",
      )
    }
    return {
      stream: createAnthropicProvider({ apiKey, model }),
      provider,
      model,
    }
  }
  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is required when YAKITORI_PROVIDER=openai.",
      )
    }
    if (!model) {
      throw new Error(
        "YAKITORI_MODEL is required when YAKITORI_PROVIDER=openai.",
      )
    }
    return {
      stream: createOpenAIProvider({ apiKey, model }),
      provider,
      model,
    }
  }
  throw new Error(
    `Provider "${provider}" is not configured. Use YAKITORI_PROVIDER=faux|openai|anthropic or inject a stream.`,
  )
}

function createFauxScenarioStream(scenario: string): StreamFn {
  if (!["text", "file", "command", "error"].includes(scenario)) {
    throw new Error(
      `Unknown YAKITORI_FAUX_SCENARIO "${scenario}". Use text|file|command|error.`,
    )
  }

  let toolCallSequence = 0
  return async function* (request) {
    if (scenario === "text") {
      yield { type: "snapshot", text: "Hel" }
      yield { type: "snapshot", text: "Hello from faux." }
      yield {
        type: "response",
        response: {
          content: [{ type: "text", text: "Hello from faux." }],
          stopReason: ModelStopReason.EndTurn,
        },
      }
      return
    }
    if (scenario === "error") {
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.Error,
          content: [],
          error: { code: "faux_error", message: "Scripted provider error." },
        },
      }
      return
    }
    if (request.messages.at(-1)?.role === "tool") {
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [
            {
              type: "text",
              text:
                scenario === "file"
                  ? "Read README.md via faux tool loop."
                  : "Command finished under approval.",
            },
          ],
        },
      }
      return
    }

    toolCallSequence += 1
    yield {
      type: "response",
      response: {
        stopReason: ModelStopReason.ToolUse,
        content: [
          scenario === "file"
            ? {
                type: "tool_call",
                id: `tool_read_${toolCallSequence}`,
                name: "read_file",
                input: { path: "README.md" },
              }
            : {
                type: "tool_call",
                id: `tool_cmd_${toolCallSequence}`,
                name: "run_command",
                input: { command: "echo faux-command" },
              },
        ],
      },
    }
  }
}
