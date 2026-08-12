import { mkdir, realpath, stat } from "node:fs/promises"
import { join } from "node:path"
import {
  createJsonlEventStore,
  createSessionKernel,
  type JsonlEventStore,
  type SessionKernel,
} from "../kernel/index.ts"
import {
  createMateKernel,
  createSqliteMateStore,
  MateLifecycle,
  type MateKernel,
  type MateProjection,
  type SqliteMateStore,
} from "../mates/index.ts"
import {
  acquireRuntimeLock,
  createAnthropicProvider,
  createCodexProvider,
  createOpenAIProvider,
  createPermissionGate,
  createProviderRegistry,
  createSessionRunner,
  createToolRegistry,
  createTransientEventHub,
  GROK_API_BASE_URL,
  ModelStopReason,
  readCodexLogin,
  recoverSessions,
  resolveGrokAccessToken,
  type CodexLogin,
  type PermissionGate,
  type RuntimeLock,
  type SessionRunner,
  type StreamFn,
  type TransientEventHub,
} from "../runtime/index.ts"
import { withRetries } from "../runtime/retrying-stream.ts"
import { createDurableEventHub, type DurableEventHub } from "./event-hub.ts"
import {
  createServerHandlers,
  type SessionCreateDefaults,
  type ServerHandlers,
} from "./handlers.ts"
import { createYakitoriHttpServer } from "./http.ts"
import { createModelDirectory, type ModelDirectory } from "./model-directory.ts"
import type {
  ApiListProvidersResponse,
  ApiProviderModel,
  ApiProviderSummary,
} from "./protocol.ts"
import {
  createProjectRegistry,
  type ProjectRegistry,
} from "./project-registry.ts"

const defaultMateProfile = {
  instructions:
    "You are Yakitori's default Mate. Keep changes small, reversible, and well tested.",
  name: "Yakitori",
  role: "Assistant",
} as const

// Kimi Code subscription endpoint. The Anthropic SDK appends /v1/messages
// itself, so this omits the /v1 suffix. Requests keep the SDK's real client
// identity — Kimi's terms warn that spoofing another client can suspend
// membership benefits.
const KIMI_CODE_API_BASE_URL = "https://api.kimi.com/coding"

export type YakitoriApplicationOptions = {
  readonly activeMateId?: string
  readonly guiStaticDir?: string
  readonly mateDatabasePath?: string
  readonly rootDir?: string
  readonly sessionStoreRoot?: string
  readonly workspace?: string
  readonly stream?: StreamFn
  readonly providerStreams?: Readonly<Record<string, StreamFn>>
  readonly modelDirectory?: ModelDirectory
  readonly provider?: string
  readonly model?: string
  readonly fauxScenario?: string
  readonly recoverOnStart?: boolean
}

export type YakitoriApplication = {
  readonly eventHub: DurableEventHub
  readonly transientHub: TransientEventHub
  readonly handlers: ServerHandlers
  readonly mateKernel: MateKernel
  readonly mateDatabasePath: string
  readonly permissionGate: PermissionGate
  readonly projectRegistry: ProjectRegistry
  readonly runner: SessionRunner
  readonly rootDir: string
  readonly sessionDefaults: SessionCreateDefaults
  readonly sessionKernel: SessionKernel
  readonly sessionStoreRoot: string
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
  const configuredSessionStoreRoot =
    options.sessionStoreRoot ?? join(rootDir, "sessions")
  const mateDatabasePath = await resolveMateDatabasePath(
    rootDir,
    options.mateDatabasePath,
  )
  const workspace = await resolveWorkspaceDirectory(
    options.workspace ?? process.env.YAKITORI_WORKSPACE ?? process.cwd(),
  )
  const activeMateId =
    options.activeMateId ?? process.env.YAKITORI_MATE_ID ?? undefined
  const shouldRecover = options.recoverOnStart ?? true

  let runtimeLock: RuntimeLock | undefined
  let eventStore: JsonlEventStore | undefined
  let mateStore: SqliteMateStore | undefined
  let runnerForCleanup: SessionRunner | undefined

  try {
    await mkdir(configuredSessionStoreRoot, { recursive: true })
    const sessionStoreRoot = await realpath(configuredSessionStoreRoot)
    runtimeLock = await acquireRuntimeLock(sessionStoreRoot)
    const ownedEventStore = createJsonlEventStore({
      sessionsDir: sessionStoreRoot,
    })
    eventStore = ownedEventStore
    const ownedMateStore = createSqliteMateStore({
      databasePath: mateDatabasePath,
    })
    mateStore = ownedMateStore
    const sessionKernel = createSessionKernel(ownedEventStore)
    const mateKernel = createMateKernel(ownedMateStore)
    const eventHub = createDurableEventHub()
    const transientHub = createTransientEventHub()
    const permissionGate = createPermissionGate()
    const projectRegistry = createProjectRegistry({
      defaultProject: workspace,
    })
    const toolRegistry = createToolRegistry()
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
        ? await createDefaultProvider(
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
    const providerRegistry = createProviderRegistry(
      await createConfiguredProviderStreams(provider, options.providerStreams),
    )
    // Auto-registered providers pick the model per request, so only the
    // primary provider carries its configured default model. The payload is
    // assembled per request: the model directory resolves lazily. Disk cache
    // lives under the store root so test roots and desktop store dirs stay
    // isolated; production can still point YAKITORI_HOME elsewhere for shared
    // user config by injecting modelDirectory.
    const modelDirectory =
      options.modelDirectory ??
      createModelDirectory({
        cachePath: join(rootDir, "model-catalogs.json"),
      })
    const providers = async (): Promise<ApiListProvidersResponse> => ({
      providers: await Promise.all(
        providerRegistry.providers.map((name) =>
          providerSummary(
            modelDirectory,
            name,
            name === provider.provider ? provider.model : undefined,
          ),
        ),
      ),
      defaultProvider: provider.provider,
      defaultModel: provider.model,
    })

    const runner = createSessionRunner({
      kernel: sessionKernel,
      mateKernel,
      stream: providerRegistry.stream,
      provider: provider.provider,
      model: provider.model,
      durableHub: eventHub,
      transientHub,
      permissionGate,
      toolRegistry,
      onRuntimeError: (error) => {
        console.error("Session lane failed", error)
      },
    })
    runnerForCleanup = runner

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
      availableProviders: providerRegistry.providers,
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

    let closePromise: Promise<void> | undefined
    return {
      eventHub,
      transientHub,
      handlers,
      mateKernel,
      mateDatabasePath,
      permissionGate,
      projectRegistry,
      runner,
      rootDir,
      sessionDefaults,
      sessionKernel,
      sessionStoreRoot,
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
          projectRegistry,
          providers,
          ...(options.guiStaticDir === undefined
            ? {}
            : { staticAssets: { directory: options.guiStaticDir } }),
        })
      },
      async close() {
        closePromise ??= closeApplicationResources(
          runner,
          ownedEventStore.close,
          ownedMateStore.close,
          runtimeLock,
        )
        await closePromise
      },
    }
  } catch (error) {
    try {
      await closeApplicationResources(
        runnerForCleanup,
        eventStore?.close,
        mateStore?.close,
        runtimeLock,
      )
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Yakitori application startup and cleanup both failed.",
        { cause: error },
      )
    }
    throw error
  }
}

async function providerSummary(
  directory: ModelDirectory,
  name: string,
  configuredModel: string | undefined,
): Promise<ApiProviderSummary> {
  const models: ApiProviderModel[] = (await directory.listModels(name)).map(
    (entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      ...(entry.description === undefined
        ? {}
        : { description: entry.description }),
      ...(entry.efforts === undefined ? {} : { efforts: entry.efforts }),
      ...(entry.defaultEffort === undefined
        ? {}
        : { defaultEffort: entry.defaultEffort }),
      ...(entry.speeds === undefined ? {} : { speeds: entry.speeds }),
    }),
  )
  if (configuredModel === undefined) return { name, models }
  // The configured default always comes first; one outside the directory is
  // synthesized so the running configuration stays selectable. promptId stays
  // server-internal (resolveModel) and is not part of the /providers payload.
  const listed = models.find(
    (entry) => entry.id.toLowerCase() === configuredModel.toLowerCase(),
  )
  const ordered =
    listed === undefined
      ? [
          {
            id: configuredModel,
            displayName: configuredModel,
          },
          ...models,
        ]
      : [listed, ...models.filter((entry) => entry !== listed)]
  return { name, defaultModel: configuredModel, models: ordered }
}

async function createConfiguredProviderStreams(
  primary: {
    readonly provider: string
    readonly stream: StreamFn
  },
  injected: Readonly<Record<string, StreamFn>> | undefined,
): Promise<Readonly<Record<string, StreamFn>>> {
  const providers: Record<string, StreamFn> = { ...injected }
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY
  if (anthropicApiKey && providers.anthropic === undefined) {
    providers.anthropic = withRetries(
      createAnthropicProvider({
        apiKey: anthropicApiKey,
        model: "selected-at-request-time",
      }),
    )
  }
  const openaiApiKey = process.env.OPENAI_API_KEY
  if (openaiApiKey && providers.openai === undefined) {
    providers.openai = withRetries(
      createOpenAIProvider({
        apiKey: openaiApiKey,
        model: "selected-at-request-time",
      }),
    )
  }
  const kimiApiKey = process.env.KIMI_API_KEY
  if (kimiApiKey && providers.kimi === undefined) {
    providers.kimi = withRetries(
      createAnthropicProvider({
        apiKey: kimiApiKey,
        model: "selected-at-request-time",
        baseURL: KIMI_CODE_API_BASE_URL,
      }),
    )
  }
  providers.grok ??= createGrokStream()
  await registerCodexLogin(providers)
  providers[primary.provider] = primary.stream
  return providers
}

// Registers the codex provider from the local codex CLI login, or the plain
// openai provider for API-key logins when no environment key already claims
// it. A missing or unreadable login disables codex without breaking startup.
async function registerCodexLogin(
  providers: Record<string, StreamFn>,
): Promise<void> {
  let login: CodexLogin | undefined
  try {
    login = await readCodexLogin()
  } catch (error) {
    console.warn(
      "Codex login could not be read; codex provider disabled.",
      error,
    )
    return
  }
  if (login === undefined) return
  if (login.kind === "chatgpt") {
    providers.codex ??= createCodexProvider()
    return
  }
  if (providers.openai === undefined) {
    providers.openai = withRetries(
      createOpenAIProvider({
        apiKey: login.apiKey,
        model: "selected-at-request-time",
      }),
    )
  }
}

async function closeApplicationResources(
  runner: SessionRunner | undefined,
  closeEventStore: (() => Promise<void>) | undefined,
  closeMateStore: (() => void) | undefined,
  runtimeLock: RuntimeLock | undefined,
): Promise<void> {
  const errors: unknown[] = []
  try {
    await runner?.close()
  } catch (error) {
    errors.push(error)
  }
  try {
    await closeEventStore?.()
  } catch (error) {
    errors.push(error)
  }
  try {
    closeMateStore?.()
  } catch (error) {
    errors.push(error)
  }
  try {
    await runtimeLock?.release()
  } catch (error) {
    errors.push(error)
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to close Yakitori application.")
  }
}

async function resolveMateDatabasePath(
  rootDir: string,
  configuredPath: string | undefined,
): Promise<string> {
  if (configuredPath !== undefined) return configuredPath
  const current = join(rootDir, "mates.sqlite")
  if (await pathExists(current)) return current
  const legacy = join(rootDir, "events.sqlite")
  if (await pathExists(legacy)) return legacy
  return current
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false
    }
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

async function createDefaultProvider(
  provider: string,
  model: string | undefined,
  fauxScenario: string | undefined,
): Promise<{
  readonly stream: StreamFn
  readonly provider: string
  readonly model: string
}> {
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
      stream: withRetries(createAnthropicProvider({ apiKey, model })),
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
      stream: withRetries(createOpenAIProvider({ apiKey, model })),
      provider,
      model,
    }
  }
  if (provider === "grok") {
    if (!model) {
      throw new Error("YAKITORI_MODEL is required when YAKITORI_PROVIDER=grok.")
    }
    return { stream: createGrokStream(), provider, model }
  }
  if (provider === "kimi") {
    const apiKey = process.env.KIMI_API_KEY
    if (!apiKey) {
      throw new Error("KIMI_API_KEY is required when YAKITORI_PROVIDER=kimi.")
    }
    if (!model) {
      throw new Error("YAKITORI_MODEL is required when YAKITORI_PROVIDER=kimi.")
    }
    return {
      stream: withRetries(
        createAnthropicProvider({
          apiKey,
          model,
          baseURL: KIMI_CODE_API_BASE_URL,
        }),
      ),
      provider,
      model,
    }
  }
  throw new Error(
    `Provider "${provider}" is not configured. Use YAKITORI_PROVIDER=faux|openai|anthropic|grok|kimi or inject a stream.`,
  )
}

function createGrokStream(): StreamFn {
  // XAI_API_KEY wins; otherwise reuse the Grok CLI's OIDC login. OAuth
  // tokens expire, so resolve per model call rather than freezing one token at
  // application startup. The same lazy stream supports primary and switched
  // Grok Turns.
  const stream: StreamFn = async function* (request) {
    const apiKey = process.env.XAI_API_KEY ?? (await resolveGrokAccessToken())
    yield* createOpenAIProvider({
      apiKey,
      model: request.target.model,
      baseURL: GROK_API_BASE_URL,
    })(request)
  }
  return withRetries(stream)
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
