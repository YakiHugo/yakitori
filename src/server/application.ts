import { mkdir, realpath, stat } from "node:fs/promises"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"
import { Agent as UndiciAgent } from "undici"
import packageJson from "../../package.json" with { type: "json" }
import {
  createSqliteAgentGraphStore,
  JsonlThreadStore,
  type SqliteAgentGraphStore,
  type StoredThread,
  ThreadManager,
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
  type AgentRuntime,
  type ApprovalPolicy,
  acquireRuntimeLock,
  type CodexLogin,
  createAgentRuntime,
  createAnthropicProvider,
  createCodexProvider,
  createDefaultTools,
  createDiscoveringModelsManager,
  createHookRunner,
  createMcpConnectionManager,
  createModelProvider,
  createOpenAIProvider,
  createPermissionGate,
  createProviderContinuationScope,
  createProviderRegistry,
  createToolRegistry,
  createTurnProcessor,
  createUserShellEnv,
  discoverCodexModels,
  discoverOpenAiCompatibleModels,
  GROK_API_BASE_URL,
  type McpConnectionManager,
  type ModelProvider,
  ModelStopReason,
  type RuntimeLock,
  readCodexLogin,
  resolveCodexAccessToken,
  resolveGrokAccessToken,
  resolveModel,
  type ShellEnvironmentPolicy,
  type StreamFn,
  type UserShellEnv,
} from "../runtime/index.ts"
import { createSkillsLoader } from "../runtime/skills.ts"
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
import type {
  ApiListProvidersResponse,
  ApiProviderModel,
  ApiProviderSummary,
} from "./protocol.ts"
import type { RequestGate } from "./request-gate.ts"
import {
  createSqliteProjectStore,
  type ProjectStore,
  type SqliteProjectStore,
} from "./sqlite-project-store.ts"
import {
  type ConfigurationSnapshot,
  createUserConfigStore,
  type UserConfigStore,
} from "./user-config.ts"

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

// The C8-D1 initialize handshake identifies the host as name/version, read
// from the package manifest (bundled into the desktop build at build time).
const serverUserAgent = `${packageJson.name}/${packageJson.version}`

export type YakitoriApplicationOptions = {
  readonly activeMateId?: string
  readonly guiStaticDir?: string
  readonly mateDatabasePath?: string
  readonly projectDatabasePath?: string
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
  readonly projectStore: SqliteProjectStore
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
  const projectDatabasePath =
    options.projectDatabasePath ?? join(rootDir, "projects.sqlite")
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
  let projectStoreForCleanup: SqliteProjectStore | undefined

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
    const ownedProjectStore = createSqliteProjectStore({
      databasePath: projectDatabasePath,
    })
    projectStoreForCleanup = ownedProjectStore
    await ensureWorkspaceProject(ownedProjectStore, workspace)
    const userConfig = createUserConfigStore({
      workspaceRoot: workspace,
      ...(options.userConfigPath === undefined
        ? {}
        : { configPath: options.userConfigPath }),
    })
    const routedUserConfig: UserConfigStore = {
      read: () => userConfig.read(),
      readConfiguration: async (input = {}) => {
        if (input.cwd === undefined) return userConfig.readConfiguration(input)
        const root = await resolveProjectConfigRoot(
          ownedProjectStore,
          input.cwd,
        )
        return createSessionUserConfig(root).readConfiguration(input)
      },
      readSnapshot: async (input = {}) => {
        if (input.cwd === undefined) return userConfig.readSnapshot(input)
        const root = await resolveProjectConfigRoot(
          ownedProjectStore,
          input.cwd,
        )
        return createSessionUserConfig(root).readSnapshot(input)
      },
      write: (preference) => userConfig.write(preference),
      writeValue: async (input) => {
        if (input.cwd === undefined) return userConfig.writeValue(input)
        const root = await resolveProjectConfigRoot(
          ownedProjectStore,
          input.cwd,
        )
        return createSessionUserConfig(root).writeValue(input)
      },
    }
    function createSessionUserConfig(root: string): UserConfigStore {
      return createUserConfigStore({
        workspaceRoot: root,
        ...(options.userConfigPath === undefined
          ? {}
          : { configPath: options.userConfigPath }),
      })
    }
    const userConfiguration = await userConfig.readConfiguration()
    const configuredShellEnvironmentPolicy =
      options.shellEnvironmentPolicy ?? userConfiguration.shellEnvironmentPolicy
    const defaultUserShellEnv =
      options.userShellEnv ??
      createUserShellEnv({
        ...(configuredShellEnvironmentPolicy === undefined
          ? {}
          : { shellEnvironmentPolicy: configuredShellEnvironmentPolicy }),
      })
    const createTrustedTools = (userShellEnv: UserShellEnv) =>
      createDefaultTools({
        userShellEnv,
        execCommandLog: (message) => console.log(message),
      })
    const mcpManagers = new Set<McpConnectionManager>()
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
    const injectedProviderNames = new Set([
      ...Object.keys(options.providerStreams ?? {}),
      ...(options.stream === undefined ? [] : [provider.provider]),
    ])
    // Auto-registered providers pick the model per request, so only the
    // primary provider carries its configured default model. The payload is
    // assembled per request: the model directory resolves lazily.
    const modelDirectory =
      options.modelDirectory ?? createModelDirectory(providerRegistry)
    const unavailableModelDirectory: ModelDirectory = {
      async listModels() {
        return []
      },
    }
    const providers = async (): Promise<ApiListProvidersResponse> => {
      const credentialStates = await providerCredentialStates()
      const names = [
        ...new Set([...providerRegistry.providers, "codex", "grok", "kimi"]),
      ]
      const [summaries, userPreference] = await Promise.all([
        Promise.all(
          names.map((name) => {
            const state = credentialStates[name]
            const registered = providerRegistry.providers.includes(name)
            const usesInjectedTransport = injectedProviderNames.has(name)
            const available =
              registered &&
              (usesInjectedTransport ||
                (state?.availability ?? "available") === "available")
            return providerSummary(
              available ? modelDirectory : unavailableModelDirectory,
              name,
              available && name === provider.provider
                ? provider.model
                : undefined,
              {
                availability: available ? "available" : "requires_login",
                ...(!available ||
                usesInjectedTransport ||
                state?.credentialKind === undefined
                  ? {}
                  : { credentialKind: state.credentialKind }),
                ...(state?.rateLimits === undefined
                  ? {}
                  : { rateLimits: state.rateLimits }),
              },
            )
          }),
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
      // Codex bounds only resumable subagent residency. Yakitori's existing
      // live-tree limit is four agents including the root, so at most three
      // completed child runtimes stay resident; rollouts remain resumable.
      maxResidentSubagentThreads: 3,
      createTurnProcessor: async (stored) => {
        const workingDirectory = stored.metadata.workingDirectory ?? workspace
        const configRoot = await resolveProjectConfigRoot(
          ownedProjectStore,
          workingDirectory,
          stored.metadata.projectId,
        )
        const sessionUserConfig = createSessionUserConfig(configRoot)
        const config = await sessionUserConfig.readSnapshot({
          cwd: workingDirectory,
        })
        const sessionConfiguration = config.configuration
        const shellEnvironmentPolicy =
          options.shellEnvironmentPolicy ??
          sessionConfiguration.shellEnvironmentPolicy
        const baseInstructions =
          options.baseInstructions ?? sessionConfiguration.baseInstructions
        const modelContextWindowTokens =
          options.modelContextWindowTokens ??
          sessionConfiguration.modelContextWindowTokens
        const sessionShellEnv =
          options.userShellEnv ??
          createUserShellEnv({
            ...(shellEnvironmentPolicy === undefined
              ? {}
              : { shellEnvironmentPolicy }),
          })
        const toolRegistry = createToolRegistry(
          createTrustedTools(sessionShellEnv),
        )
        const mcpManager = createMcpConnectionManager({
          installTools: (name, tools) => {
            toolRegistry.replaceExternalSource(`mcp:${name}`, tools)
          },
          onBackgroundError: (cause) =>
            reportOperationalFailure(reporter, {
              component: "mcp",
              operation: "background",
              cause,
              sessionId: stored.metadata.id,
            }),
        })
        try {
          await mcpManager.update(
            resolveSessionMcpServers(config, workingDirectory),
          )
        } catch (error) {
          await Promise.allSettled([toolRegistry.dispose(), mcpManager.close()])
          throw error
        }
        let mcpConfiguration = JSON.stringify(
          resolveSessionMcpServers(config, workingDirectory),
        )
        let processor: ReturnType<typeof createTurnProcessor>
        let hookRunner: ReturnType<typeof createHookRunner> | undefined
        try {
          hookRunner =
            sessionConfiguration.hooks === undefined
              ? undefined
              : createHookRunner(sessionConfiguration.hooks)
          processor = createTurnProcessor({
            prepareStepExtensions: async (signal) => {
              const snapshot = await sessionUserConfig.readSnapshot({
                cwd: workingDirectory,
              })
              const servers = resolveSessionMcpServers(
                snapshot,
                workingDirectory,
              )
              const fingerprint = JSON.stringify(servers)
              if (fingerprint !== mcpConfiguration) {
                await mcpManager.update(servers, signal)
                mcpConfiguration = fingerprint
              }
              return snapshot.configuration
            },
            loadModelTransport: async () =>
              (
                await sessionUserConfig.readSnapshot({
                  cwd: workingDirectory,
                })
              ).configuration.modelTransport,
            modelClient: providerRegistry.createClient(),
            provider: provider.provider,
            model: provider.model,
            ...(baseInstructions === undefined ? {} : { baseInstructions }),
            ...(modelContextWindowTokens === undefined
              ? {}
              : { modelContextWindowTokens }),
            ...(sessionConfiguration.modelAutoCompactTokenLimit === undefined
              ? {}
              : {
                  modelAutoCompactTokenLimit:
                    sessionConfiguration.modelAutoCompactTokenLimit,
                }),
            ...(sessionConfiguration.modelAutoCompactTokenLimitScope ===
            undefined
              ? {}
              : {
                  modelAutoCompactTokenLimitScope:
                    sessionConfiguration.modelAutoCompactTokenLimitScope,
                }),
            permissionGate,
            resolveShellName: () => sessionShellEnv.shellName(),
            // Each Session owns both its external catalog and process manager.
            toolRegistry,
            ...(hookRunner === undefined ? {} : { hookRunner }),
            ...(hookRunner === undefined ||
            stored.metadata.workingDirectory === undefined
              ? {}
              : {
                  sessionHookContext: {
                    sessionId: stored.metadata.id,
                    workspaceRoot: stored.metadata.workingDirectory,
                    source: stored.rollout.some(
                      ({ item }) => item.type === "turn_started",
                    )
                      ? "resume"
                      : "startup",
                    isSubagent: isSubagentThread(stored),
                  },
                }),
            agentControl: agentRuntime.registerThread(
              stored,
              sessionConfiguration.rolloutBudget,
            ),
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
          })
        } catch (error) {
          await Promise.allSettled([
            hookRunner?.dispose(),
            toolRegistry.dispose(),
            mcpManager.close(),
          ])
          throw error
        }
        mcpManagers.add(mcpManager)
        return {
          prepare: processor.prepare,
          ...(processor.prepareSteering === undefined
            ? {}
            : { prepareSteering: processor.prepareSteering }),
          start: processor.start,
          async dispose() {
            mcpManagers.delete(mcpManager)
            const processorResult = await Promise.allSettled([
              processor.dispose?.(),
            ])
            const resourceResults = await Promise.allSettled([
              hookRunner?.dispose(),
              mcpManager.close(),
            ])
            const results = [...processorResult, ...resourceResults]
            const errors = results.flatMap((result) =>
              result.status === "rejected" ? [result.reason] : [],
            )
            if (errors.length > 0) {
              throw new AggregateError(
                errors,
                `Failed to dispose Session ${stored.metadata.id}.`,
              )
            }
          },
        }
      },
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

    const skillsLoader = createSkillsLoader()
    const handlers = createThreadServerHandlers({
      manager: threadManager,
      discardThread: (threadId) => agentRuntime.discardThread(threadId),
      store: threadStore,
      eventHub,
      sessionDefaults,
      projectStore: ownedProjectStore,
      resolvePermission: (input) => permissionGate.resolve(input),
      listPendingPermissions: (sessionId) => permissionGate.list(sessionId),
      availableProviders: providerRegistry.providers,
      rolloutAssets,
      listSessionSkills: async ({ workingDirectory, projectId }) => {
        // Resolve the config root the same way the turn-processor path does:
        // with the session's project, not a roots-only scan.
        const root = await resolveProjectConfigRoot(
          ownedProjectStore,
          workingDirectory,
          projectId,
        )
        const snapshot = await createSessionUserConfig(root).readSnapshot({
          cwd: workingDirectory,
        })
        const configuration = snapshot.configuration
        const discovered = await skillsLoader({
          workingDirectory,
          ...(configuration.projectRootMarkers === undefined
            ? {}
            : { projectRootMarkers: configuration.projectRootMarkers }),
          ...(configuration.skills === undefined
            ? {}
            : { configuration: configuration.skills }),
        })
        return discovered.skills
      },
      reportOperationalFailure: reporter,
    })

    let closePromise: Promise<void> | undefined
    return {
      handlers,
      mateKernel,
      mateDatabasePath,
      projectStore: ownedProjectStore,
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
          projectStore: ownedProjectStore,
          providers,
          userConfig: routedUserConfig,
          availableProviders: providerRegistry.providers,
          rolloutAssets,
          reportOperationalFailure: reporter,
          userAgent: serverUserAgent,
          diagnostics: () => {
            const mcp = [...mcpManagers].flatMap((manager) => manager.status())
            return {
              resident_threads: threadManager.residentThreadCount,
              active_turns: threadManager.runningTurnCount,
              mcp_ready_servers: mcp.filter((entry) => entry.state === "ready")
                .length,
              mcp_failed_servers: mcp.filter(
                (entry) => entry.state === "failed",
              ).length,
            }
          },
          ...httpOptions,
          ...(options.guiStaticDir === undefined
            ? {}
            : { staticAssets: { directory: options.guiStaticDir } }),
        })
      },
      probeUserShellEnv() {
        return defaultUserShellEnv.probe()
      },
      async close() {
        closePromise ??= closeApplicationResources(
          threadManager,
          handlers.close,
          ownedMateStore.close,
          ownedProjectStore.close,
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
        projectStoreForCleanup?.close,
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

function resolveSessionMcpServers(
  snapshot: ConfigurationSnapshot,
  workingDirectory: string,
): Readonly<
  Record<string, import("../runtime/mcp-connection-manager.ts").McpServerConfig>
> {
  return Object.fromEntries(
    Object.entries(snapshot.configuration.mcpServers ?? {}).map(
      ([name, config]) => {
        if (!("command" in config)) return [name, config]
        const origin = snapshot.origins[`mcp_servers.${name}.cwd`]
        const baseDirectory =
          origin === undefined ? workingDirectory : dirname(origin.path)
        return [
          name,
          {
            ...config,
            cwd:
              config.cwd === undefined
                ? workingDirectory
                : isAbsolute(config.cwd)
                  ? config.cwd
                  : resolve(baseDirectory, config.cwd),
          },
        ]
      },
    ),
  )
}

function containsDirectory(root: string, directory: string): boolean {
  const pathFromRoot = relative(root, directory)
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  )
}

async function resolveProjectConfigRoot(
  projectStore: ProjectStore,
  cwd: string,
  projectId?: string,
): Promise<string> {
  const canonicalCwd = await realpath(cwd)
  if (projectId !== undefined) {
    const project = await projectStore.readProject(projectId)
    const root =
      project === undefined
        ? undefined
        : closestRoot(project.roots, canonicalCwd)
    return root ?? canonicalCwd
  }

  const roots: string[] = []
  let cursor: string | undefined
  do {
    const page = await projectStore.listProjects({
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    })
    roots.push(...page.projects.flatMap((project) => project.roots))
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return closestRoot(roots, canonicalCwd) ?? canonicalCwd
}

function closestRoot(
  roots: readonly string[],
  cwd: string,
): string | undefined {
  return roots
    .filter((root) => containsDirectory(root, cwd))
    .sort((left, right) => resolve(right).length - resolve(left).length)[0]
}

function isSubagentThread(stored: StoredThread): boolean {
  const agent = stored.metadata.metadata?.agent
  return isRecord(agent) && agent.kind === "subagent"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
  state: Pick<
    ApiProviderSummary,
    "availability" | "credentialKind" | "rateLimits"
  > = {},
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
  if (configuredModel === undefined) return { name, models, ...state }
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
  return { name, defaultModel: configuredModel, models: ordered, ...state }
}

async function providerCredentialStates(): Promise<
  Readonly<
    Record<
      string,
      Readonly<{
        availability: "available" | "requires_login"
        credentialKind?: "api_key" | "oauth"
        rateLimits: Readonly<{ status: "unavailable" }>
      }>
    >
  >
> {
  const codexLogin = await readCodexLogin().catch(() => undefined)
  const grokAvailable =
    process.env.XAI_API_KEY !== undefined ||
    (await resolveGrokAccessToken()
      .then(() => true)
      .catch(() => false))
  return {
    codex: {
      availability:
        codexLogin?.kind === "chatgpt" ? "available" : "requires_login",
      ...(codexLogin?.kind !== "chatgpt" ? {} : { credentialKind: "oauth" }),
      rateLimits: { status: "unavailable" },
    },
    grok: {
      availability: grokAvailable ? "available" : "requires_login",
      ...(grokAvailable
        ? { credentialKind: process.env.XAI_API_KEY ? "api_key" : "oauth" }
        : {}),
      rateLimits: { status: "unavailable" },
    },
    kimi: {
      availability:
        process.env.KIMI_API_KEY === undefined ? "requires_login" : "available",
      ...(process.env.KIMI_API_KEY === undefined
        ? {}
        : { credentialKind: "api_key" }),
      rateLimits: { status: "unavailable" },
    },
  }
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
  const grokAvailable =
    process.env.XAI_API_KEY !== undefined ||
    (await resolveGrokAccessToken()
      .then(() => true)
      .catch(() => false))
  if (grokAvailable) providers.grok ??= createGrokProvider()
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
  if (input.provider === "codex") {
    if (providers.codex === undefined) {
      throw new Error(
        "A Codex ChatGPT login is required when YAKITORI_PROVIDER=codex.",
      )
    }
    if (!model) {
      throw new Error(
        "YAKITORI_MODEL is required when YAKITORI_PROVIDER=codex.",
      )
    }
    return { provider: input.provider, model, providers }
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
      `Provider "${input.provider}" is not configured. Use YAKITORI_PROVIDER=faux|openai|codex|anthropic|grok|kimi or inject a stream.`,
    )
  }
  if (!model) {
    throw new Error(
      `YAKITORI_MODEL is required when YAKITORI_PROVIDER=${input.provider}.`,
    )
  }
  if (!grokAvailable) {
    await resolveGrokAccessToken()
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
      createAttemptStream: () => createOpenAIProvider({ apiKey, model }),
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
    createAttemptStream: () =>
      createAnthropicProvider({
        apiKey,
        model,
        ...(provider === "kimi" ? { baseURL: KIMI_CODE_API_BASE_URL } : {}),
      }),
    continuationScope: createProviderContinuationScope(
      provider,
      baseURL,
      apiKey,
    ),
    ...(provider === "kimi"
      ? {
          models: createDiscoveringModelsManager({
            provider,
            discover: () =>
              discoverOpenAiCompatibleModels({
                provider: "kimi",
                baseUrl: `${KIMI_CODE_API_BASE_URL}/v1`,
                accessToken: apiKey,
              }),
          }),
        }
      : {}),
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
      createTurnStream: () => createCodexProvider(),
      models: createDiscoveringModelsManager({
        provider: "codex",
        async discover() {
          const token = await resolveCodexAccessToken()
          return discoverCodexModels({
            baseUrl: "https://chatgpt.com/backend-api/codex",
            accessToken: token.accessToken,
            ...(token.accountId === undefined
              ? {}
              : { accountId: token.accountId }),
          })
        },
      }),
    })
    return
  }
  if (providers.openai === undefined) {
    providers.openai = createModelProvider({
      info: providerInfo("openai", "openai_responses"),
      createAttemptStream: () =>
        createOpenAIProvider({
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
  closeProjectStore: (() => void) | undefined,
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
    closeProjectStore?.()
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

// The workspace root is always a project (C8-D2 startup default), preserving
// the flat registry's "workspace is always listed" behavior. Idempotent by
// root membership; no idempotency key, because a user-deleted workspace
// project is recreated on the next start rather than reported as deleted.
async function ensureWorkspaceProject(
  store: SqliteProjectStore,
  workspace: string,
): Promise<void> {
  let cursor: string | undefined
  for (;;) {
    const page = await store.listProjects({
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    })
    if (page.projects.some((project) => project.roots.includes(workspace))) {
      return
    }
    if (page.nextCursor === undefined) break
    cursor = page.nextCursor
  }
  await store.createProject({
    name: basename(workspace) || workspace,
    roots: [workspace],
  })
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
  return createModelProvider({
    info: providerInfo("grok", "openai_responses"),
    createAttemptStream: (attempt) => {
      const forceHttp1 =
        attempt.number > 1 &&
        attempt.previousFailure !== undefined &&
        attempt.previousFailure.kind !== "rate_limited"
      const dispatcher = forceHttp1
        ? new UndiciAgent({ allowH2: false })
        : undefined
      return async function* (request) {
        try {
          let apiKey: string
          try {
            apiKey = process.env.XAI_API_KEY ?? (await resolveGrokAccessToken())
          } catch (cause) {
            yield {
              type: "failure",
              failure: {
                kind: "authentication",
                stage: "request_build",
                provider: "grok",
                wireApi: "openai_responses",
                providerCode: "grok_login_unavailable",
                message:
                  "Grok login is unavailable. Run `grok` and log in again, or set XAI_API_KEY, then retry.",
              },
              cause,
            }
            return
          }
          yield* createOpenAIProvider({
            apiKey,
            model: request.target.model,
            baseURL: GROK_API_BASE_URL,
            ...(dispatcher === undefined
              ? {}
              : { fetchOptions: { dispatcher } }),
          })({
            ...request,
            continuationScope: createProviderContinuationScope(
              "grok",
              GROK_API_BASE_URL,
              apiKey,
            ),
          })
        } finally {
          await dispatcher?.close()
        }
      }
    },
    models: createDiscoveringModelsManager({
      provider: "grok",
      async discover() {
        const accessToken =
          process.env.XAI_API_KEY ?? (await resolveGrokAccessToken())
        return discoverOpenAiCompatibleModels({
          provider: "grok",
          baseUrl: GROK_API_BASE_URL,
          accessToken,
        })
      },
    }),
  })
}

function providerInfo(
  id: string,
  wireApi: ModelProvider["info"]["wireApi"],
): ModelProvider["info"] {
  return {
    id,
    wireApi,
    capabilities: { remoteCompaction: id === "codex" },
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
        type: "failure",
        failure: {
          kind: "provider_error",
          stage: "model_event",
          provider: "faux",
          wireApi: "faux",
          providerCode: "faux_error",
          message: "Scripted provider error.",
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
