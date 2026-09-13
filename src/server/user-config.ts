import { mcpServersFromConfig } from "./mcp-configuration.ts"
import { createHash, randomUUID } from "node:crypto"
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { flock } from "fs-ext"
import {
  parse,
  TomlError,
  stringify,
  type TomlTable,
  type TomlTableWithoutBigInt,
  type TomlValue,
  type TomlValueWithoutBigInt,
} from "smol-toml"
import { ConfigurationError } from "./config-errors.ts"
import { resolveYakitoriHome } from "./env-file.ts"
import type {
  AutoCompactTokenLimitScope,
  ModelRequestPolicy,
  ModelTransportPolicy,
} from "../kernel/events.ts"
import {
  type HookConfiguration,
  HookEvent,
  type HookHandler,
  type HookMatcherGroup,
} from "../runtime/hooks.ts"
import type { McpServerConfig } from "../runtime/mcp-config.ts"
import { MAX_TIMER_DELAY_MS } from "../runtime/model-request.ts"
import type { RolloutBudgetConfig } from "../runtime/rollout-budget.ts"
import type { SkillConfiguration } from "../runtime/skills.ts"
import type { ShellEnvironmentPolicy } from "../runtime/user-shell-env.ts"
import type { ApiUserModelPreference } from "./protocol.ts"

export type UserConfigStore = {
  read(): Promise<ApiUserModelPreference | undefined>
  readConfiguration(input?: ConfigReadInput): Promise<UserConfiguration>
  readSnapshot(input?: ConfigReadInput): Promise<ConfigurationSnapshot>
  write(preference: ApiUserModelPreference): Promise<ApiUserModelPreference>
  writeValue(input: ConfigValueWrite): Promise<ConfigurationSnapshot>
}

export type ConfigReadInput = Readonly<{ cwd?: string }>

export type ConfigLayerSource = "user" | "project"

export type ConfigLayerSnapshot = Readonly<{
  source: ConfigLayerSource
  path: string
  version: string
  disabledReason?: string
}>

export type ConfigOrigin = Readonly<{
  source: ConfigLayerSource
  path: string
  version: string
}>

export type ConfigurationSnapshot = Readonly<{
  configuration: UserConfiguration
  // JSON has no bigint representation. TOML integers outside its safe range
  // are exposed as exact base-10 strings on the RPC wire.
  effective: TomlTableWithoutBigInt
  origins: Readonly<Record<string, ConfigOrigin>>
  layers: readonly ConfigLayerSnapshot[]
}>

export type ConfigValueWrite = Readonly<{
  keyPath: readonly string[]
  value: unknown
  expectedVersion?: string
  cwd?: string
}>

export class ConfigVersionConflictError extends Error {
  constructor() {
    super("Configuration was modified since last read. Fetch it and retry.")
    this.name = "ConfigVersionConflictError"
  }
}

export type UserConfiguration = Readonly<{
  rolloutBudget?: RolloutBudgetConfig
  preference?: ApiUserModelPreference
  baseInstructions?: string
  modelContextWindowTokens?: number
  modelAutoCompactTokenLimit?: number
  modelAutoCompactTokenLimitScope?: AutoCompactTokenLimitScope
  modelTransport?: ModelTransportPolicy
  shellEnvironmentPolicy?: Partial<ShellEnvironmentPolicy>
  mcpServers?: Readonly<Record<string, McpServerConfig>>
  hooks?: HookConfiguration
  skills?: SkillConfiguration
  projectRootMarkers?: readonly string[]
  projectInstructionFilenames?: readonly string[]
}>

export function createUserConfigStore(
  options: {
    readonly configPath?: string
    readonly workspaceRoot?: string
  } = {},
): UserConfigStore {
  const configPath = options.configPath ?? defaultUserConfigPath()
  const workspaceRoot = options.workspaceRoot
  let pendingWrite = Promise.resolve()

  return {
    async read() {
      return (await readConfigurationSnapshot(configPath, {})).configuration
        .preference
    },
    async readConfiguration(input = {}) {
      return (
        await readConfigurationSnapshot(configPath, {
          ...input,
          ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
        })
      ).configuration
    },
    async readSnapshot(input = {}) {
      return readConfigurationSnapshot(configPath, {
        ...input,
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      })
    },
    write(preference) {
      const write = pendingWrite.then(
        () =>
          withConfigWriteLock(configPath, () =>
            writePreference(configPath, preference),
          ),
        () =>
          withConfigWriteLock(configPath, () =>
            writePreference(configPath, preference),
          ),
      )
      pendingWrite = write.then(
        () => undefined,
        () => undefined,
      )
      return write
    },
    writeValue(input) {
      const write = pendingWrite.then(
        () =>
          withConfigWriteLock(configPath, () =>
            writeConfigValue(configPath, input, workspaceRoot),
          ),
        () =>
          withConfigWriteLock(configPath, () =>
            writeConfigValue(configPath, input, workspaceRoot),
          ),
      )
      pendingWrite = write.then(
        () => undefined,
        () => undefined,
      )
      return write
    },
  }
}

function defaultUserConfigPath(): string {
  return join(resolveYakitoriHome(), "config.toml")
}

async function writePreference(
  configPath: string,
  preference: ApiUserModelPreference,
): Promise<ApiUserModelPreference> {
  const document = await readConfigDocument(configPath)
  const value = {
    ...(document?.value ?? {}),
    provider: preference.provider,
    model: preference.model,
    effort: preference.effort,
    speed: preference.speed,
  }
  const content = stringify(value)
  const candidate = parseConfigDocument(configPath, content)
  await readConfigurationSnapshot(configPath, {}, candidate)
  const current = await readFile(configPath, "utf8").catch((error) => {
    if (isMissingFile(error)) return ""
    throw error
  })
  if (fingerprint(current) !== (document?.version ?? fingerprint("")))
    throw new ConfigVersionConflictError()
  await writeAtomically(configPath, content)
  return preference
}

async function writeConfigValue(
  configPath: string,
  input: ConfigValueWrite,
  workspaceRoot: string | undefined,
): Promise<ConfigurationSnapshot> {
  if (
    input.keyPath.length === 0 ||
    input.keyPath.some(
      (segment) =>
        segment.trim() === "" || unsafeConfigPathSegments.has(segment),
    )
  ) {
    throw new ConfigurationError(
      "Configuration keyPath contains an invalid segment.",
    )
  }
  const document = await readConfigDocument(configPath)
  const version = document?.version ?? fingerprint("")
  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== version
  ) {
    throw new ConfigVersionConflictError()
  }
  const value = structuredClone(document?.value ?? {})
  let target = value
  for (const segment of input.keyPath.slice(0, -1)) {
    const current = Object.hasOwn(target, segment) ? target[segment] : undefined
    if (current !== undefined && !isTomlTable(current)) {
      throw new ConfigurationError(
        `Configuration path ${input.keyPath.join(".")} crosses a non-table value.`,
      )
    }
    const next: TomlTable = current ?? {}
    target[segment] = next
    target = next
  }
  const leaf = input.keyPath.at(-1)
  if (leaf === undefined) throw new Error("Configuration keyPath is empty.")
  target[leaf] = configurationValue(input.value)
  const content = stringify(value)
  const candidate = parseConfigDocument(configPath, content)
  // Validate the user layer even when the selected project overrides its values.
  await readConfigurationSnapshot(configPath, {}, candidate)
  const snapshot = await readConfigurationSnapshot(
    configPath,
    {
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    },
    candidate,
  )

  // Check again immediately before the atomic rename. The in-process queue
  // serializes Yakitori writers; the version catches edits from another
  // process or editor between read and write.
  const current = await readFile(configPath, "utf8").catch((error) => {
    if (isMissingFile(error)) return ""
    throw error
  })
  if (fingerprint(current) !== version) throw new ConfigVersionConflictError()
  await writeAtomically(configPath, content)
  return snapshot
}

const unsafeConfigPathSegments = new Set([
  "__proto__",
  "constructor",
  "prototype",
])

function configurationValue(value: unknown): TomlValue {
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(configurationValue)
  if (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (unsafeConfigPathSegments.has(key))
          throw new ConfigurationError(
            "Configuration value contains an invalid key.",
          )
        return [key, configurationValue(entry)]
      }),
    )
  }
  throw new ConfigurationError(
    "Configuration values must be TOML-compatible JSON values; null is not supported.",
  )
}

async function withConfigWriteLock<T>(
  configPath: string,
  write: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(configPath), { recursive: true })
  const lock = await open(`${configPath}.yakitori.lock`, "a+", 0o600)
  try {
    await flockPromise(lock.fd, "ex")
    try {
      return await write()
    } finally {
      await flockPromise(lock.fd, "un")
    }
  } finally {
    await lock.close()
  }
}

function flockPromise(
  fileDescriptor: number,
  operation: "ex" | "un",
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    flock(fileDescriptor, operation, (error) => {
      if (error === null) resolvePromise()
      else rejectPromise(error)
    })
  })
}

async function writeAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, "utf8")
    await rename(temporary, path)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch (cleanupError) {
      if (!isMissingFile(cleanupError)) {
        throw new AggregateError(
          [error, cleanupError],
          "Config write and temporary-file cleanup both failed.",
          { cause: error },
        )
      }
    }
    throw error
  }
}

type ConfigDocument = {
  readonly content: string
  readonly path: string
  readonly value: TomlTable
  readonly version: string
}

async function readConfigDocument(
  configPath: string,
): Promise<ConfigDocument | undefined> {
  let content: string
  try {
    content = await readFile(configPath, "utf8")
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }

  return parseConfigDocument(configPath, content)
}

function parseConfigDocument(path: string, content: string): ConfigDocument {
  try {
    return {
      content,
      path,
      value: parse(content, { integersAsBigInt: "asNeeded" }),
      version: fingerprint(content),
    }
  } catch (cause) {
    if (!(cause instanceof TomlError)) throw cause
    // TomlError.message includes a source code excerpt. Configuration files may
    // contain credentials, so only return the parser summary and source range.
    const detail = cause.message
      .split(/\r?\n/, 1)[0]
      ?.replace(/^Invalid TOML document:\s*/, "")
    throw new ConfigurationError(
      detail === undefined || detail.length === 0
        ? "Invalid TOML document."
        : `TOML parse error at line ${String(cause.line)}, column ${String(cause.column)}: ${detail}`,
      {
        code: "syntax",
        path,
        range: {
          start: { line: cause.line, column: cause.column },
          end: { line: cause.line, column: cause.column },
        },
        cause,
      },
    )
  }
}

type LoadedConfigLayer = Readonly<{
  source: ConfigLayerSource
  path: string
  content: string
  value: TomlTable
  version: string
  disabledReason?: string
}>

async function readConfigurationSnapshot(
  configPath: string,
  input: ConfigReadInput & Readonly<{ workspaceRoot?: string }>,
  candidate?: ConfigDocument,
): Promise<ConfigurationSnapshot> {
  const user = candidate ?? (await readConfigDocument(configPath))
  const layers: LoadedConfigLayer[] = [
    {
      source: "user",
      path: configPath,
      content: user?.content ?? "",
      value: user?.value ?? {},
      version: user?.version ?? fingerprint(""),
    },
  ]
  const trust = await projectTrustPaths(user?.value ?? {})

  if (input.cwd !== undefined) {
    const workspaceRoot = await realpath(input.workspaceRoot ?? input.cwd)
    const cwd = await realpath(input.cwd)
    requireInside(workspaceRoot, cwd, "Configuration cwd")
    for (const directory of directoriesFromRoot(workspaceRoot, cwd)) {
      const projectPath = join(directory, ".yakitori", "config.toml")
      const layer = await readProjectLayer(projectPath, trust)
      if (layer !== undefined) layers.push(layer)
    }
  }

  const origins: Record<string, ConfigOrigin> = {}
  let effective: TomlTable = {}
  for (const layer of layers) {
    if (layer.disabledReason !== undefined) continue
    effective = mergeTables(effective, layer.value)
    recordOrigins(layer.value, "", layer, origins)
  }
  const instructionOrigin = origins.model_instructions_file
  let configuration: UserConfiguration
  try {
    configuration = await configurationFromConfig(
      effective,
      instructionOrigin === undefined
        ? dirname(configPath)
        : dirname(instructionOrigin.path),
      {
        paths: dirname(origins["skills.paths"]?.path ?? configPath),
        config: dirname(origins["skills.config"]?.path ?? configPath),
      },
    )
  } catch (error) {
    if (!(error instanceof ConfigurationError) || error.path !== undefined) {
      throw error
    }
    throw locateConfigurationError(error, layers, origins)
  }
  return {
    configuration,
    effective: jsonSafeTomlTable(effective),
    origins,
    layers: layers.map(({ source, path, version, disabledReason }) => ({
      source,
      path,
      version,
      ...(disabledReason === undefined ? {} : { disabledReason }),
    })),
  }
}

async function readProjectLayer(
  path: string,
  projectTrust: ReadonlyMap<string, ProjectTrustLevel>,
): Promise<LoadedConfigLayer | undefined> {
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
  const projectDirectory = dirname(dirname(path))
  const trustLevel = projectTrustLevel(projectDirectory, projectTrust)
  if (trustLevel !== "trusted") {
    return {
      source: "project",
      path,
      content,
      value: {},
      version: fingerprint(content),
      disabledReason:
        trustLevel === "untrusted"
          ? "project is explicitly untrusted"
          : "project is not trusted",
    }
  }
  const { value } = parseConfigDocument(path, content)
  return {
    source: "project",
    path,
    content,
    value,
    version: fingerprint(content),
  }
}

type ProjectTrustLevel = "trusted" | "untrusted"

async function projectTrustPaths(
  value: TomlTable,
): Promise<ReadonlyMap<string, ProjectTrustLevel>> {
  const projects = value.projects
  if (!isTomlTable(projects)) return new Map()
  return new Map(
    await Promise.all(
      Object.entries(projects).flatMap(([path, entry]) =>
        isTomlTable(entry) &&
        (entry.trust_level === "trusted" || entry.trust_level === "untrusted")
          ? [normalizeProjectTrustPath(path, entry.trust_level)]
          : [],
      ),
    ),
  )
}

async function normalizeProjectTrustPath(
  path: string,
  trustLevel: ProjectTrustLevel,
): Promise<readonly [string, ProjectTrustLevel]> {
  if (!isAbsolute(path)) {
    throw new ConfigurationError(`Project trust path must be absolute: ${path}`)
  }
  const normalized = await realpath(path).catch((error) => {
    if (isMissingFile(error)) return resolve(path)
    throw error
  })
  return [normalized, trustLevel]
}

function projectTrustLevel(
  projectDirectory: string,
  projectTrust: ReadonlyMap<string, ProjectTrustLevel>,
): ProjectTrustLevel | undefined {
  let match: { path: string; level: ProjectTrustLevel } | undefined
  for (const [candidate, level] of projectTrust) {
    if (
      (projectDirectory === candidate ||
        projectDirectory.startsWith(`${candidate}${sep}`)) &&
      (match === undefined || candidate.length > match.path.length)
    ) {
      match = { path: candidate, level }
    }
  }
  return match?.level
}

function directoriesFromRoot(root: string, cwd: string): readonly string[] {
  const directories = [cwd]
  let current = cwd
  while (current !== root) {
    current = dirname(current)
    directories.push(current)
  }
  return directories.reverse()
}

function requireInside(root: string, path: string, label: string): void {
  const child = relative(root, path)
  if (child === "" || (!child.startsWith(`..${sep}`) && child !== "..")) return
  throw new ConfigurationError(`${label} is outside the workspace: ${path}`)
}

function mergeTables(base: TomlTable, overlay: TomlTable): TomlTable {
  const merged: TomlTable = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    const previous = merged[key]
    merged[key] =
      isTomlTable(previous) && isTomlTable(value)
        ? mergeTables(previous, value)
        : structuredClone(value)
  }
  return merged
}

function recordOrigins(
  value: TomlTable,
  prefix: string,
  layer: LoadedConfigLayer,
  origins: Record<string, ConfigOrigin>,
): void {
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix === "" ? key : `${prefix}.${key}`
    if (isTomlTable(entry)) {
      recordOrigins(entry, path, layer, origins)
      continue
    }
    origins[path] = {
      source: layer.source,
      path: layer.path,
      version: layer.version,
    }
  }
}

function jsonSafeTomlTable(value: TomlTable): TomlTableWithoutBigInt {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      jsonSafeTomlValue(entry),
    ]),
  )
}

function jsonSafeTomlValue(value: TomlValue): TomlValueWithoutBigInt {
  if (typeof value === "bigint") return value.toString(10)
  if (Array.isArray(value)) return value.map(jsonSafeTomlValue)
  if (value instanceof Date) return value
  if (isTomlTable(value)) return jsonSafeTomlTable(value)
  return value
}

function fingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

async function configurationFromConfig(
  value: TomlTable,
  baseDirectory: string,
  skillDirectories = { paths: baseDirectory, config: baseDirectory },
): Promise<UserConfiguration> {
  const preference = preferenceFromConfig(value)
  const baseInstructions = await baseInstructionsFromConfig(
    value,
    baseDirectory,
  )
  const shellEnvironmentPolicy = shellEnvironmentPolicyFromConfig(value)
  const rolloutBudget = rolloutBudgetFromConfig(value)
  const mcpServers = mcpServersFromConfig(value)
  const hooks = hooksFromConfig(value)
  const instructionConfiguration = instructionsFromConfig(
    value,
    skillDirectories,
  )
  const modelContextWindowTokens = value.model_context_window
  if (
    modelContextWindowTokens !== undefined &&
    (typeof modelContextWindowTokens !== "number" ||
      !Number.isSafeInteger(modelContextWindowTokens) ||
      modelContextWindowTokens <= 0)
  ) {
    throw new ConfigurationError(
      "model_context_window must be a positive integer.",
    )
  }
  const modelAutoCompactTokenLimit = value.model_auto_compact_token_limit
  if (
    modelAutoCompactTokenLimit !== undefined &&
    (typeof modelAutoCompactTokenLimit !== "number" ||
      !Number.isSafeInteger(modelAutoCompactTokenLimit) ||
      modelAutoCompactTokenLimit <= 0)
  ) {
    throw new ConfigurationError(
      "model_auto_compact_token_limit must be a positive integer.",
    )
  }
  const modelAutoCompactTokenLimitScope =
    value.model_auto_compact_token_limit_scope
  const modelTransport = modelTransportFromConfig(value.model_transport)
  if (
    modelAutoCompactTokenLimitScope !== undefined &&
    modelAutoCompactTokenLimitScope !== "total" &&
    modelAutoCompactTokenLimitScope !== "body_after_prefix"
  ) {
    throw new ConfigurationError(
      'model_auto_compact_token_limit_scope must be "total" or "body_after_prefix".',
    )
  }
  return {
    ...instructionConfiguration,
    ...(preference === undefined ? {} : { preference }),
    ...(rolloutBudget === undefined ? {} : { rolloutBudget }),
    ...(baseInstructions === undefined ? {} : { baseInstructions }),
    ...(modelContextWindowTokens === undefined
      ? {}
      : { modelContextWindowTokens }),
    ...(modelAutoCompactTokenLimit === undefined
      ? {}
      : { modelAutoCompactTokenLimit }),
    ...(modelAutoCompactTokenLimitScope === undefined
      ? {}
      : { modelAutoCompactTokenLimitScope }),
    ...(modelTransport === undefined ? {} : { modelTransport }),
    ...(shellEnvironmentPolicy === undefined ? {} : { shellEnvironmentPolicy }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
    ...(hooks === undefined ? {} : { hooks }),
  }
}

function modelTransportFromConfig(
  value: TomlValue | undefined,
): ModelTransportPolicy | undefined {
  if (value === undefined) return undefined
  if (!isTomlTable(value)) {
    throw new ConfigurationError("model_transport must be a table.", {
      keyPath: "model_transport",
    })
  }
  const defaults = modelRequestPolicyFromTable(value, "model_transport", [
    "providers",
  ])
  const configuredProviders = value.providers
  if (configuredProviders === undefined) return defaults
  if (!isTomlTable(configuredProviders)) {
    throw new ConfigurationError("model_transport.providers must be a table.", {
      keyPath: "model_transport.providers",
    })
  }
  const providers = Object.fromEntries(
    Object.entries(configuredProviders).map(([provider, configured]) => {
      if (provider.trim().length === 0 || !isTomlTable(configured)) {
        throw new ConfigurationError(
          `model_transport.providers.${provider} must be a table.`,
          { keyPath: `model_transport.providers.${provider}` },
        )
      }
      return [
        provider,
        modelRequestPolicyFromTable(
          configured,
          `model_transport.providers.${provider}`,
        ),
      ]
    }),
  )
  return { ...defaults, providers }
}

function modelRequestPolicyFromTable(
  value: TomlTable,
  keyPath: string,
  additionalFields: readonly string[] = [],
): ModelRequestPolicy {
  const fields = {
    max_attempts: "maxAttempts",
    rate_limit_max_attempts: "rateLimitMaxAttempts",
    stream_idle_timeout_ms: "streamIdleTimeoutMs",
  } as const
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key) && !additionalFields.includes(key)) {
      throw new ConfigurationError(`Unknown ${keyPath} field: ${key}.`, {
        code: "unknown_field",
        keyPath: `${keyPath}.${key}`,
      })
    }
  }
  const result: Record<string, number> = {}
  for (const [configName, propertyName] of Object.entries(fields)) {
    const configured = value[configName]
    if (configured === undefined) continue
    if (
      typeof configured !== "number" ||
      !Number.isSafeInteger(configured) ||
      configured <= 0 ||
      (configName === "stream_idle_timeout_ms" &&
        configured > MAX_TIMER_DELAY_MS)
    ) {
      throw new ConfigurationError(
        configName === "stream_idle_timeout_ms"
          ? `${keyPath}.${configName} must be an integer between 1 and ${String(MAX_TIMER_DELAY_MS)} milliseconds.`
          : `${keyPath}.${configName} must be a positive integer.`,
        { keyPath: `${keyPath}.${configName}` },
      )
    }
    result[propertyName] = configured
  }
  return result
}

function locateConfigurationError(
  error: ConfigurationError,
  layers: readonly LoadedConfigLayer[],
  origins: Readonly<Record<string, ConfigOrigin>>,
): ConfigurationError {
  const keyPath = error.keyPath ?? inferConfigurationKey(error.message, origins)
  const origin = keyPath === undefined ? undefined : origins[keyPath]
  const located =
    keyPath === undefined
      ? undefined
      : [...layers]
          .reverse()
          .filter((candidate) => candidate.disabledReason === undefined)
          .map((candidate) => ({
            layer: candidate,
            range: findConfigKeyRange(candidate.content, keyPath),
          }))
          .find((candidate) => candidate.range !== undefined)
  const layer =
    located?.layer ??
    layers.find((candidate) => candidate.path === origin?.path) ??
    [...layers]
      .reverse()
      .find((candidate) => candidate.disabledReason === undefined)
  if (layer === undefined) return error
  const range = located?.range
  return new ConfigurationError(error.message, {
    code: error.code,
    path: layer.path,
    ...(range === undefined ? {} : { range }),
    ...(keyPath === undefined ? {} : { keyPath }),
    cause: error.cause ?? error,
  })
}

function inferConfigurationKey(
  message: string,
  origins: Readonly<Record<string, ConfigOrigin>>,
): string | undefined {
  const originKey = Object.keys(origins)
    .sort((left, right) => right.length - left.length)
    .find(
      (key) =>
        message.startsWith(key) ||
        message.startsWith(`${key.split(".").at(-1) ?? key} `),
    )
  if (originKey !== undefined) return originKey
  return /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/.exec(message)?.[0]
}

function findConfigKeyRange(
  content: string,
  keyPath: string,
): import("./config-errors.ts").ConfigTextRange | undefined {
  const expected = keyPath.split(".")
  const lines = content.split(/\r?\n/)
  let tablePath: readonly string[] = []
  let enclosingTable: import("./config-errors.ts").ConfigTextRange | undefined
  let enclosingDepth = 0
  for (const [index, line] of lines.entries()) {
    const table = /^\s*\[(?!\[)(.+)\]\s*(?:#.*)?$/.exec(line)
    const arrayTable = /^\s*\[\[(.+)\]\]\s*(?:#.*)?$/.exec(line)
    const tableKey = parseTomlDottedKey(table?.[1] ?? arrayTable?.[1])
    if (tableKey !== undefined) {
      tablePath = tableKey
      if (samePath(tablePath, expected)) {
        const raw = table?.[1] ?? arrayTable?.[1]
        if (raw === undefined) continue
        const column = line.indexOf(raw) + 1
        return {
          start: { line: index + 1, column },
          end: { line: index + 1, column: column + raw.length },
        }
      }
      if (
        tablePath.length > enclosingDepth &&
        tablePath.every((segment, pathIndex) => segment === expected[pathIndex])
      ) {
        const raw = table?.[1] ?? arrayTable?.[1]
        if (raw !== undefined) {
          const column = line.indexOf(raw) + 1
          enclosingTable = {
            start: { line: index + 1, column },
            end: { line: index + 1, column: column + raw.length },
          }
          enclosingDepth = tablePath.length
        }
      }
      continue
    }

    const assignment =
      /^(\s*)((?:"(?:\\.|[^"])*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.\s*(?:"(?:\\.|[^"])*"|'[^']*'|[A-Za-z0-9_-]+))*)\s*=/.exec(
        line,
      )
    const raw = assignment?.[2]
    const assignmentPath = parseTomlDottedKey(raw)
    if (
      raw === undefined ||
      assignmentPath === undefined ||
      !samePath([...tablePath, ...assignmentPath], expected)
    ) {
      continue
    }
    const column = (assignment?.[1]?.length ?? 0) + 1
    return {
      start: { line: index + 1, column },
      end: { line: index + 1, column: column + raw.length },
    }
  }
  return enclosingTable
}

function parseTomlDottedKey(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  const segments: string[] = []
  let index = 0
  while (index < raw.length) {
    while (/\s/.test(raw[index] ?? "")) index += 1
    const quote = raw[index]
    if (quote === '"' || quote === "'") {
      index += 1
      let value = ""
      for (;;) {
        const character = raw[index]
        if (character === undefined) return undefined
        if (character === quote) {
          index += 1
          break
        }
        if (quote === '"' && character === "\\") {
          const escaped = raw[index + 1]
          if (escaped === undefined) return undefined
          value += escaped
          index += 2
          continue
        }
        value += character
        index += 1
      }
      segments.push(value)
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(raw.slice(index))
      if (match === null) return undefined
      segments.push(match[0])
      index += match[0].length
    }
    while (/\s/.test(raw[index] ?? "")) index += 1
    if (index === raw.length) return segments
    if (raw[index] !== ".") return undefined
    index += 1
  }
  return segments.length === 0 ? undefined : segments
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  )
}

function instructionsFromConfig(
  value: TomlTable,
  directories: Readonly<{ paths: string; config: string }>,
): Readonly<{
  skills?: SkillConfiguration
  projectRootMarkers?: readonly string[]
  projectInstructionFilenames?: readonly string[]
}> {
  const readStringList = (
    value: unknown,
    field: string,
  ): string[] | undefined => {
    if (value === undefined) return undefined
    if (!Array.isArray(value)) {
      throw new ConfigurationError(
        `${field} must be an array of nonempty strings.`,
      )
    }
    return value.map((item) => {
      if (typeof item !== "string" || item.trim() === "") {
        throw new ConfigurationError(
          `${field} must be an array of nonempty strings.`,
        )
      }
      return item
    })
  }
  const result: {
    skills?: SkillConfiguration
    projectRootMarkers?: string[]
    projectInstructionFilenames?: string[]
  } = {}
  const markers = readStringList(
    value.project_root_markers,
    "project_root_markers",
  )
  const filenames = readStringList(
    value.project_doc_fallback_filenames,
    "project_doc_fallback_filenames",
  )
  for (const name of [...(markers ?? []), ...(filenames ?? [])]) {
    if (name === "." || name === ".." || /[/\\]/.test(name)) {
      throw new ConfigurationError(
        "Instruction marker and fallback names must be single filenames.",
      )
    }
  }
  if (markers !== undefined) result.projectRootMarkers = markers
  if (filenames !== undefined) result.projectInstructionFilenames = filenames

  const configured = value.skills
  if (configured === undefined) return result
  if (!isTomlTable(configured))
    throw new ConfigurationError("skills must be a table.")
  const resolveSkillPath = (raw: string, baseDirectory: string) =>
    raw.startsWith("~/")
      ? resolve(homedir(), raw.slice(2))
      : resolve(baseDirectory, raw)
  const paths = readStringList(configured.paths, "skills.paths")?.map((raw) =>
    resolveSkillPath(raw, directories.paths),
  )
  const rules = configured.config
  if (rules !== undefined && !Array.isArray(rules)) {
    throw new ConfigurationError("skills.config must be an array of tables.")
  }
  const config = (rules ?? []).map((rule) => {
    if (!isTomlTable(rule) || typeof rule.enabled !== "boolean") {
      throw new ConfigurationError(
        "Each skills.config entry must be a table with a boolean enabled field.",
      )
    }
    if (rule.name !== undefined) {
      if (
        typeof rule.name !== "string" ||
        rule.name.trim() === "" ||
        rule.path !== undefined
      ) {
        throw new ConfigurationError(
          "A skills.config name selector requires a nonempty name and no path.",
        )
      }
      return { name: rule.name, enabled: rule.enabled }
    }
    if (typeof rule.path !== "string" || rule.path.trim() === "") {
      throw new ConfigurationError(
        "A skills.config path selector requires a nonempty path.",
      )
    }
    return {
      path: resolveSkillPath(rule.path, directories.config),
      enabled: rule.enabled,
    }
  })
  result.skills = paths === undefined ? { config } : { paths, config }
  return result
}

function hooksFromConfig(value: TomlTable): HookConfiguration | undefined {
  const configured = value.hooks
  if (configured === undefined) return undefined
  if (!isTomlTable(configured)) {
    throw new ConfigurationError("hooks must be a table.")
  }
  const events = Object.values(HookEvent)
  const result: Partial<Record<HookEvent, readonly HookMatcherGroup[]>> = {}
  for (const [name, groups] of Object.entries(configured)) {
    if (!events.includes(name as HookEvent)) continue
    if (!Array.isArray(groups)) {
      throw new ConfigurationError(`hooks.${name} must be an array of tables.`)
    }
    result[name as HookEvent] = groups.map((group, groupIndex) => {
      if (!isTomlTable(group) || !Array.isArray(group.hooks)) {
        throw new ConfigurationError(
          `hooks.${name}[${String(groupIndex)}] must contain hooks.`,
        )
      }
      if (group.matcher !== undefined && typeof group.matcher !== "string") {
        throw new ConfigurationError(`hooks.${name}.matcher must be a string.`)
      }
      return {
        ...(group.matcher === undefined ? {} : { matcher: group.matcher }),
        hooks: group.hooks.map((handler, handlerIndex) =>
          hookHandlerFromConfig(
            handler,
            `${name}[${String(groupIndex)}].hooks[${String(handlerIndex)}]`,
          ),
        ),
      }
    })
  }
  return result
}

function hookHandlerFromConfig(value: unknown, path: string): HookHandler {
  if (!isTomlTable(value) || value.type !== "command") {
    throw new ConfigurationError(`hooks.${path} must be a command hook.`)
  }
  if (typeof value.command !== "string" || value.command.trim() === "") {
    throw new ConfigurationError(`hooks.${path}.command is required.`)
  }
  const timeoutMs = value.timeout_ms
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0)
  ) {
    throw new ConfigurationError(`hooks.${path}.timeout_ms is invalid.`)
  }
  if (value.async !== undefined && typeof value.async !== "boolean") {
    throw new ConfigurationError(`hooks.${path}.async must be a boolean.`)
  }
  if (
    value.trusted_hash !== undefined &&
    typeof value.trusted_hash !== "string"
  ) {
    throw new ConfigurationError(`hooks.${path}.trusted_hash must be a string.`)
  }
  return {
    type: "command",
    command: value.command,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(value.async === undefined ? {} : { async: value.async }),
    ...(value.trusted_hash === undefined
      ? {}
      : { trustedHash: value.trusted_hash }),
  }
}

function rolloutBudgetFromConfig(
  value: TomlTable,
): RolloutBudgetConfig | undefined {
  const features = value.features
  if (features === undefined) return undefined
  if (!isTomlTable(features))
    throw new ConfigurationError("features must be a table.")
  const config = features.rollout_budget
  if (config === undefined || config === false) return undefined
  if (!isTomlTable(config))
    throw new ConfigurationError(
      "features.rollout_budget must be a table with a limit when enabled.",
    )
  if (config.enabled === false) return undefined
  if (config.enabled !== true)
    throw new ConfigurationError(
      "features.rollout_budget.enabled must be a boolean.",
    )
  const allowed = new Set([
    "enabled",
    "limit_tokens",
    "reminder_at_remaining_tokens",
    "sampling_token_weight",
    "prefill_token_weight",
  ])
  for (const key of Object.keys(config)) {
    if (!allowed.has(key))
      throw new ConfigurationError(`Unknown rollout_budget field: ${key}`)
  }
  const limitTokens = config.limit_tokens
  if (
    typeof limitTokens !== "number" ||
    !Number.isSafeInteger(limitTokens) ||
    limitTokens <= 0
  ) {
    throw new ConfigurationError(
      "rollout_budget.limit_tokens must be a positive integer.",
    )
  }
  const thresholds = config.reminder_at_remaining_tokens
  if (
    !Array.isArray(thresholds) ||
    !thresholds.every(
      (value): value is number =>
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value > 0 &&
        value < limitTokens,
    )
  ) {
    throw new ConfigurationError(
      "rollout_budget.reminder_at_remaining_tokens must contain positive integers below limit_tokens.",
    )
  }
  const samplingTokenWeight = config.sampling_token_weight ?? 1
  const prefillTokenWeight = config.prefill_token_weight ?? 1
  if (
    typeof samplingTokenWeight !== "number" ||
    !Number.isFinite(samplingTokenWeight) ||
    samplingTokenWeight < 0 ||
    typeof prefillTokenWeight !== "number" ||
    !Number.isFinite(prefillTokenWeight) ||
    prefillTokenWeight < 0
  ) {
    throw new ConfigurationError(
      "Rollout token weights must be finite and non-negative.",
    )
  }
  return {
    limitTokens,
    reminderAtRemainingTokens: thresholds,
    samplingTokenWeight,
    prefillTokenWeight,
  }
}

function shellEnvironmentPolicyFromConfig(
  value: TomlTable,
): Partial<ShellEnvironmentPolicy> | undefined {
  const configured = value.shell_environment_policy
  if (configured === undefined) return undefined
  if (!isTomlTable(configured)) {
    throw new ConfigurationError("shell_environment_policy must be a table.")
  }
  const allowedFields = new Set([
    "inherit",
    "ignore_default_excludes",
    "exclude",
    "set",
    "include_only",
  ])
  const unknownField = Object.keys(configured).find(
    (field) => !allowedFields.has(field),
  )
  if (unknownField !== undefined) {
    throw new ConfigurationError(
      `Unknown shell_environment_policy field: ${unknownField}`,
    )
  }
  const inherit = configured.inherit
  if (
    inherit !== undefined &&
    inherit !== "all" &&
    inherit !== "core" &&
    inherit !== "none"
  ) {
    throw new ConfigurationError(
      'shell_environment_policy.inherit must be "all", "core", or "none".',
    )
  }
  const ignoreDefaultExcludes = configured.ignore_default_excludes
  if (
    ignoreDefaultExcludes !== undefined &&
    typeof ignoreDefaultExcludes !== "boolean"
  ) {
    throw new ConfigurationError(
      "shell_environment_policy.ignore_default_excludes must be a boolean.",
    )
  }
  const exclude = stringArray(configured.exclude, "exclude")
  const includeOnly = stringArray(configured.include_only, "include_only")
  const set = configured.set
  if (set !== undefined && !isTomlTable(set)) {
    throw new ConfigurationError(
      "shell_environment_policy.set must be a table.",
    )
  }
  const environmentSet =
    set === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(set).map(([name, entry]) => {
            if (typeof entry !== "string") {
              throw new ConfigurationError(
                `shell_environment_policy.set.${name} must be a string.`,
              )
            }
            return [name, entry]
          }),
        )
  return {
    ...(inherit === undefined ? {} : { inherit }),
    ...(ignoreDefaultExcludes === undefined ? {} : { ignoreDefaultExcludes }),
    ...(exclude === undefined ? {} : { exclude }),
    ...(environmentSet === undefined ? {} : { set: environmentSet }),
    ...(includeOnly === undefined ? {} : { includeOnly }),
  }
}

function stringArray(
  value: unknown,
  field: "exclude" | "include_only",
): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new ConfigurationError(
      `shell_environment_policy.${field} must be an array of strings.`,
    )
  }
  return value
}

function isTomlTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function baseInstructionsFromConfig(
  value: TomlTable,
  baseDirectory: string,
): Promise<string | undefined> {
  const configuredPath = value.model_instructions_file
  if (
    configuredPath !== undefined &&
    (typeof configuredPath !== "string" || configuredPath.trim() === "")
  ) {
    throw new ConfigurationError(
      "model_instructions_file must be a non-empty string.",
    )
  }
  if (typeof configuredPath === "string") {
    const path = isAbsolute(configuredPath)
      ? configuredPath
      : resolve(baseDirectory, configuredPath)
    let content: string
    try {
      content = await readFile(path, "utf8")
    } catch (cause) {
      if (
        !(cause instanceof Error) ||
        !("code" in cause) ||
        !["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EISDIR"].includes(
          String(cause.code),
        )
      )
        throw cause
      throw new ConfigurationError(
        `Failed to read model instructions file ${path}.`,
        { cause, path },
      )
    }
    const text = content.trim()
    if (text.length === 0) {
      throw new ConfigurationError(`Model instructions file is empty: ${path}.`)
    }
    return text
  }
  const instructions = value.instructions
  if (instructions === undefined) return undefined
  if (typeof instructions !== "string" || instructions.trim() === "") {
    throw new ConfigurationError("instructions must be a non-empty string.")
  }
  return instructions.trim()
}

function preferenceFromConfig(
  value: TomlTable,
): ApiUserModelPreference | undefined {
  const provider = value.provider
  const model = value.model
  if (provider === undefined && model === undefined) return undefined
  if (provider === undefined || model === undefined) {
    throw new ConfigurationError(
      "provider and model must be configured together.",
    )
  }
  if (
    typeof provider !== "string" ||
    typeof model !== "string" ||
    provider.trim() === "" ||
    model.trim() === ""
  ) {
    throw new ConfigurationError(
      "provider and model must be non-empty strings.",
    )
  }
  const effort = value.effort
  const speed = value.speed
  if (
    (effort !== undefined &&
      (typeof effort !== "string" || effort.trim() === "")) ||
    (speed !== undefined && (typeof speed !== "string" || speed.trim() === ""))
  ) {
    throw new ConfigurationError(
      "effort and speed must be non-empty when configured.",
    )
  }
  return {
    provider,
    model,
    ...(effort === undefined ? {} : { effort }),
    ...(speed === undefined ? {} : { speed }),
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  )
}
