import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ApiUserModelPreference } from "./protocol.ts"

const preferenceKeys = new Set(["provider", "model", "effort", "speed"])

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
  const content = serializeConfig(preference, document?.unknownLines ?? [])
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
  readonly unknownLines: readonly string[]
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
    return parseConfig(content)
  } catch (error) {
    console.warn(`Ignoring malformed user config at ${configPath}.`, error)
    return undefined
  }
}

function parseConfig(content: string): ConfigDocument {
  const values = new Map<string, string>()
  const unknownLines: string[] = []
  let inTable = false

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) {
      unknownLines.push(line)
      continue
    }
    if (/^\[[^\]]+\](?:\s*#.*)?$/.test(trimmed)) {
      inTable = true
      unknownLines.push(line)
      continue
    }

    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(trimmed)
    if (assignment === null) throw new Error(`Invalid TOML line: ${line}`)
    const key = assignment[1]
    if (key === undefined || inTable || !preferenceKeys.has(key)) {
      unknownLines.push(line)
      continue
    }
    const value = parseTomlString(assignment[2] ?? "")
    values.set(key, value)
  }

  const provider = values.get("provider")
  const model = values.get("model")
  if (provider === undefined && model === undefined) return { unknownLines }
  if (provider === undefined || model === undefined) {
    throw new Error("provider and model must be configured together.")
  }
  if (provider.trim() === "" || model.trim() === "") {
    throw new Error("provider and model must be non-empty strings.")
  }
  const effort = values.get("effort")
  const speed = values.get("speed")
  if (effort?.trim() === "" || speed?.trim() === "") {
    throw new Error("effort and speed must be non-empty when configured.")
  }
  return {
    preference: {
      provider,
      model,
      ...(effort === undefined ? {} : { effort }),
      ...(speed === undefined ? {} : { speed }),
    },
    unknownLines,
  }
}

function parseTomlString(value: string): string {
  const match = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(value)
  if (match?.[1] === undefined) {
    throw new Error("User model preferences must be TOML strings.")
  }
  const parsed: unknown = JSON.parse(match[1])
  if (typeof parsed !== "string") {
    throw new Error("User model preferences must be TOML strings.")
  }
  return parsed
}

function serializeConfig(
  preference: ApiUserModelPreference,
  unknownLines: readonly string[],
): string {
  const preferenceLines = [
    `provider = ${JSON.stringify(preference.provider)}`,
    `model = ${JSON.stringify(preference.model)}`,
    ...(preference.effort === undefined
      ? []
      : [`effort = ${JSON.stringify(preference.effort)}`]),
    ...(preference.speed === undefined
      ? []
      : [`speed = ${JSON.stringify(preference.speed)}`]),
  ]
  const preserved = trimBlankEdges(unknownLines)
  return `${[...preferenceLines, ...(preserved.length === 0 ? [] : ["", ...preserved])].join("\n")}\n`
}

function trimBlankEdges(lines: readonly string[]): readonly string[] {
  const first = lines.findIndex((line) => line.trim() !== "")
  if (first < 0) return []
  let last = lines.length - 1
  while (last > first && lines[last]?.trim() === "") last -= 1
  return lines.slice(first, last + 1)
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  )
}
