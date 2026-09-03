import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { parse, stringify, type TomlTable } from "smol-toml"
import type { ShellEnvironmentPolicy } from "../runtime/user-shell-env.ts"
import {
  consoleOperationalFailureReporter,
  type OperationalFailureReporter,
  reportOperationalFailure,
} from "./operational-errors.ts"
import type { ApiUserModelPreference } from "./protocol.ts"

export type UserConfigStore = {
  read(): Promise<ApiUserModelPreference | undefined>
  readConfiguration(): Promise<UserConfiguration>
  write(preference: ApiUserModelPreference): Promise<ApiUserModelPreference>
}

export type UserConfiguration = Readonly<{
  preference?: ApiUserModelPreference
  baseInstructions?: string
  modelContextWindowTokens?: number
  shellEnvironmentPolicy?: Partial<ShellEnvironmentPolicy>
}>

export function createUserConfigStore(
  options: {
    readonly configPath?: string
    readonly reportOperationalFailure?: OperationalFailureReporter
  } = {},
): UserConfigStore {
  const configPath = options.configPath ?? defaultUserConfigPath()
  const reporter =
    options.reportOperationalFailure ?? consoleOperationalFailureReporter
  let pendingWrite = Promise.resolve()

  return {
    async read() {
      const document = await readConfigDocument(configPath, reporter)
      return document?.configuration.preference
    },
    async readConfiguration() {
      const document = await readConfigDocument(configPath, reporter)
      return document?.configuration ?? {}
    },
    write(preference) {
      const write = pendingWrite.then(
        () => writePreference(configPath, preference, reporter),
        () => writePreference(configPath, preference, reporter),
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
  return join(
    process.env.YAKITORI_HOME ?? join(homedir(), ".yakitori"),
    "config.toml",
  )
}

async function writePreference(
  configPath: string,
  preference: ApiUserModelPreference,
  reporter: OperationalFailureReporter,
): Promise<ApiUserModelPreference> {
  const document = await readConfigDocument(configPath, reporter)
  const content = stringify({
    ...(document?.value ?? {}),
    provider: preference.provider,
    model: preference.model,
    ...(preference.effort === undefined
      ? { effort: undefined }
      : { effort: preference.effort }),
    ...(preference.speed === undefined
      ? { speed: undefined }
      : { speed: preference.speed }),
  })
  await mkdir(dirname(configPath), { recursive: true })
  const temporary = `${configPath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, "utf8")
    await rename(temporary, configPath)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch (cleanupError) {
      if (!isMissingFile(cleanupError)) {
        throw new AggregateError(
          [error, cleanupError],
          "User config write and temporary-file cleanup both failed.",
          { cause: error },
        )
      }
    }
    throw error
  }
  return preference
}

type ConfigDocument = {
  readonly configuration: UserConfiguration
  readonly value: TomlTable
}

async function readConfigDocument(
  configPath: string,
  reporter: OperationalFailureReporter,
): Promise<ConfigDocument | undefined> {
  let content: string
  try {
    content = await readFile(configPath, "utf8")
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }

  try {
    const value = parse(content, { integersAsBigInt: "asNeeded" })
    return {
      value,
      // Relative paths in config resolve against the config file's
      // directory, not the server process cwd.
      configuration: await configurationFromConfig(value, dirname(configPath)),
    }
  } catch (error) {
    if (
      error instanceof ModelInstructionsConfigError ||
      error instanceof ShellEnvironmentPolicyConfigError
    ) {
      throw error
    }
    reportOperationalFailure(reporter, {
      component: "user-config",
      operation: "parse",
      cause: error,
    })
    return undefined
  }
}

async function configurationFromConfig(
  value: TomlTable,
  baseDirectory: string,
): Promise<UserConfiguration> {
  const preference = preferenceFromConfig(value)
  const baseInstructions = await baseInstructionsFromConfig(
    value,
    baseDirectory,
  )
  const shellEnvironmentPolicy = shellEnvironmentPolicyFromConfig(value)
  const modelContextWindowTokens = value.model_context_window
  if (
    modelContextWindowTokens !== undefined &&
    (typeof modelContextWindowTokens !== "number" ||
      !Number.isSafeInteger(modelContextWindowTokens) ||
      modelContextWindowTokens <= 0)
  ) {
    throw new Error("model_context_window must be a positive integer.")
  }
  return {
    ...(preference === undefined ? {} : { preference }),
    ...(baseInstructions === undefined ? {} : { baseInstructions }),
    ...(modelContextWindowTokens === undefined
      ? {}
      : { modelContextWindowTokens }),
    ...(shellEnvironmentPolicy === undefined ? {} : { shellEnvironmentPolicy }),
  }
}

function shellEnvironmentPolicyFromConfig(
  value: TomlTable,
): Partial<ShellEnvironmentPolicy> | undefined {
  const configured = value.shell_environment_policy
  if (configured === undefined) return undefined
  if (!isTomlTable(configured)) {
    throw new ShellEnvironmentPolicyConfigError(
      "shell_environment_policy must be a table.",
    )
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
    throw new ShellEnvironmentPolicyConfigError(
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
    throw new ShellEnvironmentPolicyConfigError(
      'shell_environment_policy.inherit must be "all", "core", or "none".',
    )
  }
  const ignoreDefaultExcludes = configured.ignore_default_excludes
  if (
    ignoreDefaultExcludes !== undefined &&
    typeof ignoreDefaultExcludes !== "boolean"
  ) {
    throw new ShellEnvironmentPolicyConfigError(
      "shell_environment_policy.ignore_default_excludes must be a boolean.",
    )
  }
  const exclude = stringArray(configured.exclude, "exclude")
  const includeOnly = stringArray(configured.include_only, "include_only")
  const set = configured.set
  if (set !== undefined && !isTomlTable(set)) {
    throw new ShellEnvironmentPolicyConfigError(
      "shell_environment_policy.set must be a table.",
    )
  }
  const environmentSet =
    set === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(set).map(([name, entry]) => {
            if (typeof entry !== "string") {
              throw new ShellEnvironmentPolicyConfigError(
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
    throw new ShellEnvironmentPolicyConfigError(
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
    throw new Error("model_instructions_file must be a non-empty string.")
  }
  if (typeof configuredPath === "string") {
    const path = isAbsolute(configuredPath)
      ? configuredPath
      : resolve(baseDirectory, configuredPath)
    let content: string
    try {
      content = await readFile(path, "utf8")
    } catch (cause) {
      throw new ModelInstructionsConfigError(
        `Failed to read model instructions file ${path}.`,
        { cause },
      )
    }
    const text = content.trim()
    if (text.length === 0) {
      throw new ModelInstructionsConfigError(
        `Model instructions file is empty: ${path}.`,
      )
    }
    return text
  }
  const instructions = value.instructions
  if (instructions === undefined) return undefined
  if (typeof instructions !== "string" || instructions.trim() === "") {
    throw new Error("instructions must be a non-empty string.")
  }
  return instructions.trim()
}

class ModelInstructionsConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ModelInstructionsConfigError"
  }
}

class ShellEnvironmentPolicyConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ShellEnvironmentPolicyConfigError"
  }
}

function preferenceFromConfig(
  value: TomlTable,
): ApiUserModelPreference | undefined {
  const provider = value.provider
  const model = value.model
  if (provider === undefined && model === undefined) return undefined
  if (provider === undefined || model === undefined) {
    throw new Error("provider and model must be configured together.")
  }
  if (
    typeof provider !== "string" ||
    typeof model !== "string" ||
    provider.trim() === "" ||
    model.trim() === ""
  ) {
    throw new Error("provider and model must be non-empty strings.")
  }
  const effort = value.effort
  const speed = value.speed
  if (
    (effort !== undefined &&
      (typeof effort !== "string" || effort.trim() === "")) ||
    (speed !== undefined && (typeof speed !== "string" || speed.trim() === ""))
  ) {
    throw new Error("effort and speed must be non-empty when configured.")
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
