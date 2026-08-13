import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parse, stringify, type TomlTable } from "smol-toml"
import type { ApiUserModelPreference } from "./protocol.ts"

export type UserConfigStore = {
  read(): Promise<ApiUserModelPreference | undefined>
  write(preference: ApiUserModelPreference): Promise<ApiUserModelPreference>
}

export function createUserConfigStore(
  options: { readonly configPath?: string } = {},
): UserConfigStore {
  const configPath = options.configPath ?? defaultUserConfigPath()
  let pendingWrite = Promise.resolve()

  return {
    async read() {
      const document = await readConfigDocument(configPath)
      return document?.preference
    },
    write(preference) {
      const write = pendingWrite.then(
        () => writePreference(configPath, preference),
        () => writePreference(configPath, preference),
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
): Promise<ApiUserModelPreference> {
  const document = await readConfigDocument(configPath)
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
  readonly preference?: ApiUserModelPreference
  readonly value: TomlTable
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

  try {
    const value = parse(content, { integersAsBigInt: "asNeeded" })
    return { value, ...preferenceFromConfig(value) }
  } catch (error) {
    console.warn(`Ignoring malformed user config at ${configPath}.`, error)
    return undefined
  }
}

function preferenceFromConfig(value: TomlTable): {
  readonly preference?: ApiUserModelPreference
} {
  const provider = value.provider
  const model = value.model
  if (provider === undefined && model === undefined) return {}
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
    preference: {
      provider,
      model,
      ...(effort === undefined ? {} : { effort }),
      ...(speed === undefined ? {} : { speed }),
    },
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
