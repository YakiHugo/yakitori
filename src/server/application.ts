import { mkdir, realpath, stat } from "node:fs/promises"
import { join } from "node:path"
import {
  JsonlThreadStore,
  createSqliteAgentGraphStore,
  ThreadManager,
  type SqliteAgentGraphStore,
  type ThreadStore,
} from "../core/index.ts"
import { createRolloutAssets } from "../kernel/index.ts"
import {
  createMateKernel,
  createSqliteMateStore,
  type MateKernel,
  MateLifecycle,
  type MateProjection,
  type SqliteMateStore,
} from "../mates/index.ts"
import {
  acquireRuntimeLock,
  type CodexLogin,
  createAnthropicProvider,
  createAgentRuntime,
  type AgentRuntime,
  createCodexProvider,
  createDefaultTools,
  createOpenAIProvider,
  createModelProvider,
  createProviderContinuationScope,
  createPermissionGate,
  createProviderRegistry,
  createToolRegistry,
  createTurnProcessor,
  createUserShellEnv,
  GROK_API_BASE_URL,
  ModelStopReason,
  type ApprovalPolicy,
  type RuntimeLock,
  type ModelProvider,
  readCodexLogin,
  resolveGrokAccessToken,
  resolveModel,
  type StreamFn,
  type ShellEnvironmentPolicy,
  type UserShellEnv,
} from "../runtime/index.ts"
import { createSessionEventHub } from "./event-hub.ts"
import {
  createThreadServerHandlers,
  type ServerHandlers,
  type SessionCreateDefaults,
} from "./handlers.ts"
import { createYakitoriHttpServer } from "./http.ts"
import { createModelDirectory, type ModelDirectory } from "./model-directory.ts"
import {
  consoleOperationalFailureReporter,
  type OperationalFailureReporter,
  reportOperationalFailure,
} from "./operational-errors.ts"
import type { RequestGate } from "./request-gate.ts"
import { createProjectRegistry } from "./project-registry.ts"
import type {
  ApiListProvidersResponse,
  ApiProviderModel,
  ApiProviderSummary,
} from "./protocol.ts"
import { createUserConfigStore } from "./user-config.ts"

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
const OPENAI_API_BASE_URL = "https://api.openai.com/v1"
const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com"

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
  readonly userConfigPath?: string
  readonly baseInstructions?: string
  readonly modelContextWindowTokens?: number
  readonly provider?: string
  readonly model?: string
  readonly fauxScenario?: string
  readonly userShellEnv?: UserShellEnv
  readonly reportOperationalFailure?: OperationalFailureReporter
  readonly shellEnvironmentPolicy?: Partial<ShellEnvironmentPolicy>
}

export type YakitoriApplication = {
  readonly handlers: ServerHandlers
  readonly mateKernel: MateKernel
  readonly mateDatabasePath: string
  readonly threadManager: ThreadManager
  readonly threadStore: ThreadStore
  readonly rolloutAssets: ReturnType<typeof createRolloutAssets>
  readonly sessionStoreRoot: string
  readonly workspace: string
  readonly activeMate: {
    readonly mateId: string
    readonly mateRevisionId: string
    readonly name: string
    readonly revision: number
  }
  createHttpServer(options?: {
    readonly requestGate?: RequestGate
  }): ReturnType<typeof createYakitoriHttpServer>
  probeUserShellEnv(): Promise<"ready" | "unavailable">
  close(): Promise<void>
}

export async function createYakitoriApplication(
  options: YakitoriApplicationOptions = {},
): Promise<YakitoriApplication> {
  const reporter =
    options.reportOperationalFailure ?? consoleOperationalFailureReporter
  const rootDir = options.rootDir ?? ".yakitori"
  const configuredSessionStoreRoot =
    options.sessionStoreRoot ?? join(rootDir, "sessions")
  const mateDatabasePath =
    options.mateDatabasePath ?? join(rootDir, "mates.sqlite")
  const workspace = await resolveWorkspaceDirectory(
    options.workspace ?? process.env.YAKITORI_WORKSPACE ?? process.cwd(),
  )
  const activeMateId =
    options.activeMateId ?? process.env.YAKITORI_MATE_ID ?? undefined
  const approvalPolicy = resolveApprovalPolicy(
    process.env.YAKITORI_APPROVAL_POLICY,
  )
  let runtimeLock: RuntimeLock | undefined
  let threadManagerForCleanup: ThreadManager | undefined
  let agentRuntimeForCleanup: AgentRuntime | undefined
  let agentGraphStoreForCleanup: SqliteAgentGraphStore | undefined
  let mateStore: SqliteMateStore | undefined

  try {
    await mkdir(configuredSessionStoreRoot, { recursive: true })
    const sessionStoreRoot = await realpath(configuredSessionStoreRoot)
    runtimeLock = await acquireRuntimeLock(sessionStoreRoot)
    const ownedMateStore = createSqliteMateStore({
      databasePath: mateDatabasePath,
    })
    mateStore = ownedMateStore
    const mateKernel = createMateKernel(ownedMateStore)
    const eventHub = createSessionEventHub({
      reportOperationalFailure: reporter,
    })
    const permissionGate = createPermissionGate()
    const projectRegistry = createProjectRegistry({
      defaultProject: workspace,
      reportOperationalFailure: reporter,
    })
    const userConfig = createUserConfigStore({
      cwd: workspace,
      reportOperationalFailure: reporter,
      ...(options.userConfigPath === undefined
        ? {}
        : { configPath: options.userConfigPath }),
    })
    const userConfiguration = await userConfig.readConfiguration()
    const configuredShellEnvironmentPolicy =
      options.shellEnvironmentPolicy ?? userConfiguration.shellEnvironmentPolicy
    const userShellEnv =
      options.userShellEnv ??
      createUserShellEnv({
        ...(configuredShellEnvironmentPolicy === undefined
          ? {}
          : { shellEnvironmentPolicy: configuredShellEnvironmentPolicy }),
      })
    const createTrustedTools = () =>
      createDefaultTools({
        userShellEnv,
        execCommandLog: (message) => console.log(message),
      })
    const activeMate = await resolveActiveMate(mateKernel, activeMateId)
    const sessionDefaults: SessionCreateDefaults = {
      workingDirectory: workspace,
      mateId: activeMate.id,
      mateRevisionId: activeMate.currentRevision.id,
    }
    const providerName =
      options.provider ?? process.env.YAKITORI_PROVIDER ?? "faux"
    const provider = await configureProviders({
      provider: providerName,
      model: options.model ?? process.env.YAKITORI_MODEL ?? undefined,
      fauxScenario: options.fauxScenario ?? process.env.YAKITORI_FAUX_SCENARIO,
      primaryStream: options.stream,
      injected: options.providerStreams,
      reportOperationalFailure: reporter,
    })
    const providerRegistry = createProviderRegistry(provider.providers)
    // Auto-registered providers pick the model per request, so only the
    // primary provider carries its configured default model. The payload is
    // assembled per request: the model directory resolves lazily.
    const modelDirectory =
      options.modelDirectory ?? createModelDirectory(providerRegistry)
    const providers = async (): Promise<ApiListProvidersResponse> => {
      const [summaries, userPreference] = await Promise.all([
        Promise.all(
          providerRegistry.providers.map((name) =>
            providerSummary(
              modelDirectory,
              name,
              name === provider.provider ? provider.model : undefined,
            ),
          ),
        ),
        userConfig.read(),
      ])
      return {
        providers: summaries,
        defaultProvider: provider.provider,
        defaultModel: provider.model,
        ...(userPreference === undefined ? {} : { userPreference }),
      }
    }
    const modelContextWindowTokens =
      options.modelContextWindowTokens ??
      userConfiguration.modelContextWindowTokens
    const baseInstructions =
      options.baseInstructions ?? userConfiguration.baseInstructions

    const threadStore = new JsonlThreadStore({ root: sessionStoreRoot })
    await threadStore.initialize()
    const rolloutAssets = createRolloutAssets(sessionStoreRoot, {
      withMutationLease: (rolloutId, mutate) =>
        threadStore.withRolloutAssetMutation(rolloutId, mutate),
    })
    await rolloutAssets.cleanupStagingImageAttachments()
    const agentGraphStore = createSqliteAgentGraphStore({
      databasePath: join(sessionStoreRoot, "agent-graph.sqlite"),
    })
    agentGraphStoreForCleanup = agentGraphStore
    let threadManager: ThreadManager
    const agentRuntime = createAgentRuntime({
      graphStore: agentGraphStore,
      getThreadManager: () => threadManager,
      onBackgroundError: (error, threadId, operation) => {
        reportOperationalFailure(reporter, {
          component: "agent-control",
          operation,
          cause: error,
          sessionId: threadId,
        })
      },
    })
    agentRuntimeForCleanup = agentRuntime
    threadManager = new ThreadManager({
      store: threadStore,
      createTurnProcessor: (stored) =>
        createTurnProcessor({
          modelClient: providerRegistry.createClient(),
          provider: provider.provider,
          model: provider.model,
          ...(baseInstructions === undefined ? {} : { baseInstructions }),
          ...(modelContextWindowTokens === undefined
            ? {}
            : { modelContextWindowTokens }),
          permissionGate,
          resolveShellName: () => userShellEnv.shellName(),
          // Each Session owns both its external catalog and process manager.
          toolRegistry: createToolRegistry(createTrustedTools()),
          agentControl: agentRuntime.registerThread(stored),
          rolloutAssets,
          approvalPolicy,
          onOperationalFailure: (failure) => {
            reportOperationalFailure(reporter, {
              component: "turn-processor",
              operation: failure.operation,
              cause: failure.cause,
              sessionId: stored.metadata.id,
            })
          },
        }),
      onPersistenceError: (error, threadId) => {
        reportOperationalFailure(reporter, {
          component: "thread-store",
          operation: "persist",
          cause: error,
          sessionId: threadId,
        })
      },
      onBackgroundError: (error, threadId, operation) => {
        reportOperationalFailure(reporter, {
          component: "thread-manager",
          operation,
          cause: error,
          sessionId: threadId,
        })
      },
    })
    threadManagerForCleanup = threadManager

    const handlers = createThreadServerHandlers({
      manager: threadManager,
      discardThread: (threadId) => agentRuntime.discardThread(threadId),
      store: threadStore,
      eventHub,
      sessionDefaults,
      resolvePermission: (input) => permissionGate.resolve(input),
      listPendingPermissions: (sessionId) => permissionGate.list(sessionId),
      availableProviders: providerRegistry.providers,
      rolloutAssets,
      reportOperationalFailure: reporter,
    })

    let closePromise: Promise<void> | undefined
    return {
      handlers,
      mateKernel,
      mateDatabasePath,
      threadManager,
      threadStore,
      rolloutAssets,
      sessionStoreRoot,
      workspace,
      activeMate: {
        mateId: activeMate.id,
        mateRevisionId: activeMate.currentRevision.id,
        name: activeMate.currentRevision.name,
        revision: activeMate.currentRevision.revision,
      },
      createHttpServer(httpOptions = {}) {
        return createYakitoriHttpServer({
          eventHub,
          handlers,
          projectRegistry,
          providers,
          userConfig,
          availableProviders: providerRegistry.providers,
          rolloutAssets,
          reportOperationalFailure: reporter,
          ...httpOptions,
          ...(options.guiStaticDir === undefined
            ? {}
            : { staticAssets: { directory: options.guiStaticDir } }),
        })
      },
      probeUserShellEnv() {
        return userShellEnv.probe()
      },
      async close() {
        closePromise ??= closeApplicationResources(
          threadManager,
          handlers.close,
          ownedMateStore.close,
          agentRuntime.close,
          agentGraphStore.close,
          runtimeLock,
        )
        await closePromise
      },
    }
  } catch (error) {
    try {
      await closeApplicationResources(
        threadManagerForCleanup,
        undefined,
        mateStore?.close,
        agentRuntimeForCleanup?.close,
        agentGraphStoreForCleanup?.close,
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

function resolveApprovalPolicy(value: string | undefined): ApprovalPolicy {
  if (value === undefined || value === "always_approve") {
    return "always_approve"
  }
  if (value === "auto_file_tools") return value
  throw new Error(`Unsupported YAKITORI_APPROVAL_POLICY: ${value}`)
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
      instructionProfileId: entry.instructionProfileId as string,
      ...(entry.effortStyle === undefined
        ? {}
        : { effortStyle: entry.effortStyle }),
      ...(entry.efforts === undefined ? {} : { efforts: entry.efforts }),
      ...(entry.speeds === undefined ? {} : { speeds: entry.speeds }),
      ...(entry.inputModalities === undefined
        ? {}
        : { inputModalities: entry.inputModalities }),
      ...(entry.imageDetailModes === undefined
        ? {}
        : { imageDetailModes: entry.imageDetailModes }),
    }),
  )
  if (configuredModel === undefined) return { name, models }
  // The configured default always comes first; one outside the directory is
  // synthesized so the running configuration stays selectable.
  const listed = models.find(
    (entry) => entry.id.toLowerCase() === configuredModel.toLowerCase(),
  )
  const ordered =
    listed === undefined
      ? [
          {
            id: configuredModel,
            displayName: configuredModel,
            instructionProfileId: resolveModel({
              provider: name,
              model: configuredModel,
            }).instructionProfileId,
          },
          ...models,
        ]
      : [listed, ...models.filter((entry) => entry !== listed)]
  return { name, defaultModel: configuredModel, models: ordered }
}

async function configureProviders(input: {
  readonly provider: string
  readonly model: string | undefined
  readonly fauxScenario: string | undefined
  readonly primaryStream: StreamFn | undefined
  readonly injected: Readonly<Record<string, StreamFn>> | undefined
  readonly reportOperationalFailure: OperationalFailureReporter
}): Promise<{
  readonly provider: string
  readonly model: string
  readonly providers: Readonly<Record<string, ModelProvider | StreamFn>>
}> {
  const providers: Record<string, ModelProvider | StreamFn> = {
    ...input.injected,
  }
  for (const provider of apiKeyProviderNames) {
    const apiKey = process.env[apiKeyEnvironment[provider]]
    if (apiKey && providers[provider] === undefined) {
      providers[provider] = createApiKeyProvider(
        provider,
        apiKey,
        "selected-at-request-time",
      )
    }
  }
  providers.grok ??= createGrokProvider()
  await registerCodexLogin(providers, input.reportOperationalFailure)

  const model =
    input.model ??
    (input.provider === "faux"
      ? "scripted"
      : input.primaryStream === undefined
        ? undefined
        : "injected")
  if (input.primaryStream !== undefined) {
    providers[input.provider] = input.primaryStream
    return {
      provider: input.provider,
      model: model ?? "injected",
      providers,
    }
  }
  if (input.provider === "faux") {
    providers.faux = createModelProvider({
      info: providerInfo("faux", "faux"),
      stream: createFauxScenarioStream(input.fauxScenario ?? "text"),
    })
    return {
      provider: input.provider,
      model: model ?? "scripted",
      providers,
    }
  }
  if (isApiKeyProvider(input.provider)) {
    const credential = apiKeyEnvironment[input.provider]
    const apiKey = process.env[credential]
    if (!apiKey) {
      throw new Error(
        `${credential} is required when YAKITORI_PROVIDER=${input.provider}.`,
      )
    }
    if (!model) {
      throw new Error(
        `YAKITORI_MODEL is required when YAKITORI_PROVIDER=${input.provider}.`,
      )
    }
    providers[input.provider] = createApiKeyProvider(
      input.provider,
      apiKey,
      model,
    )
    return { provider: input.provider, model, providers }
  }
  if (input.provider !== "grok") {
    throw new Error(
      `Provider "${input.provider}" is not configured. Use YAKITORI_PROVIDER=faux|openai|anthropic|grok|kimi or inject a stream.`,
    )
  }
  if (!model) {
    throw new Error(
      `YAKITORI_MODEL is required when YAKITORI_PROVIDER=${input.provider}.`,
    )
  }
  providers.grok = createGrokProvider()
  return { provider: input.provider, model, providers }
}

const apiKeyEnvironment = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  kimi: "KIMI_API_KEY",
} as const

const apiKeyProviderNames = Object.keys(
  apiKeyEnvironment,
) as (keyof typeof apiKeyEnvironment)[]

function isApiKeyProvider(
  provider: string,
): provider is keyof typeof apiKeyEnvironment {
  return Object.hasOwn(apiKeyEnvironment, provider)
}

function createApiKeyProvider(
  provider: keyof typeof apiKeyEnvironment,
  apiKey: string,
  model: string,
): ModelProvider {
  if (provider === "openai") {
    return createModelProvider({
      info: providerInfo(provider, "openai_responses"),
      stream: createOpenAIProvider({ apiKey, model }),
      continuationScope: createProviderContinuationScope(
        provider,
        OPENAI_API_BASE_URL,
        apiKey,
      ),
    })
  }
  const baseURL =
    provider === "kimi" ? KIMI_CODE_API_BASE_URL : ANTHROPIC_API_BASE_URL
  return createModelProvider({
    info: providerInfo(provider, "anthropic_messages"),
    stream: createAnthropicProvider({
      apiKey,
      model,
      ...(provider === "kimi" ? { baseURL: KIMI_CODE_API_BASE_URL } : {}),
    }),
    continuationScope: createProviderContinuationScope(
      provider,
      baseURL,
      apiKey,
    ),
  })
}

// Registers the codex provider from the local codex CLI login, or the plain
// openai provider for API-key logins when no environment key already claims
// it. A missing or unreadable login disables codex without breaking startup.
async function registerCodexLogin(
  providers: Record<string, ModelProvider | StreamFn>,
  reporter: OperationalFailureReporter,
): Promise<void> {
  let login: CodexLogin | undefined
  try {
    login = await readCodexLogin()
  } catch (error) {
    reportOperationalFailure(reporter, {
      component: "codex-credentials",
      operation: "read-login",
      cause: error,
    })
    return
  }
  if (login === undefined) return
  if (login.kind === "chatgpt") {
    providers.codex ??= createModelProvider({
      info: providerInfo("codex", "openai_responses"),
      stream: createCodexProvider(),
    })
    return
  }
  if (providers.openai === undefined) {
    providers.openai = createModelProvider({
      info: providerInfo("openai", "openai_responses"),
      stream: createOpenAIProvider({
        apiKey: login.apiKey,
        model: "selected-at-request-time",
      }),
      continuationScope: createProviderContinuationScope(
        "openai",
        OPENAI_API_BASE_URL,
        login.apiKey,
      ),
    })
  }
}

async function closeApplicationResources(
  threadManager: ThreadManager | undefined,
  closeHandlers: (() => Promise<void>) | undefined,
  closeMateStore: (() => void) | undefined,
  closeAgentRuntime: (() => Promise<void>) | undefined,
  closeAgentGraphStore: (() => void) | undefined,
  runtimeLock: RuntimeLock | undefined,
): Promise<void> {
  const errors: unknown[] = []
  try {
    await closeAgentRuntime?.()
  } catch (error) {
    errors.push(error)
  }
  try {
    await threadManager?.shutdown()
  } catch (error) {
    errors.push(error)
  }
  try {
    await closeHandlers?.()
  } catch (error) {
    errors.push(error)
  }
  try {
    closeMateStore?.()
  } catch (error) {
    errors.push(error)
  }
  try {
    closeAgentGraphStore?.()
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

function createGrokProvider(): ModelProvider {
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
    })({
      ...request,
      continuationScope: createProviderContinuationScope(
        "grok",
        GROK_API_BASE_URL,
        apiKey,
      ),
    })
  }
  return createModelProvider({
    info: providerInfo("grok", "openai_responses"),
    stream,
  })
}

function providerInfo(
  id: string,
  wireApi: ModelProvider["info"]["wireApi"],
): ModelProvider["info"] {
  return {
    id,
    wireApi,
    capabilities: { remoteCompaction: false },
  }
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
      yield { type: "reasoning_snapshot", text: "Preparing a concise reply." }
      yield { type: "snapshot", text: "Hel" }
      yield { type: "snapshot", text: "Hello from faux." }
      yield {
        type: "response",
        response: {
          content: [
            { type: "reasoning", text: "Preparing a concise reply." },
            { type: "text", text: "Hello from faux." },
          ],
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
                  : "Command finished.",
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
                name: "exec_command",
                input: { cmd: "echo faux-command" },
              },
        ],
      },
    }
  }
}
