import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  CODEX_API_BASE_URL,
  directoryAllowlist,
  GROK_API_BASE_URL,
  listCatalogModels,
  resolveCodexAccessToken,
  resolveGrokAccessToken,
} from "../runtime/index.ts"
import anthropicSnapshot from "./catalogs/anthropic-models.snapshot.json" with {
  type: "json",
}
import codexSnapshot from "./catalogs/codex-models.snapshot.json" with {
  type: "json",
}
import grokSnapshot from "./catalogs/grok-models.snapshot.json" with {
  type: "json",
}

export type DirectoryModel = {
  readonly id: string
  readonly displayName: string
  readonly description?: string
  readonly efforts?: readonly string[]
  readonly defaultEffort?: string
  readonly speeds?: readonly string[]
}

export type ModelDirectory = {
  listModels(provider: string): Promise<readonly DirectoryModel[]>
}

const DEFAULT_TTL_MS = 3_600_000
const FETCH_TIMEOUT_MS = 15_000
const MODELS_DEV_API_URL = "https://models.dev/api.json"
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models"
const ANTHROPIC_VERSION = "2023-06-01"
const REASONING_EFFORTS = ["low", "medium", "high"] as const

// models.dev provider key for the public OpenAI catalog (exception: no first-
// party picker list on the public API).
const OPENAI_MODELS_DEV_KEY = "openai"

// Non-chat model families a coding agent never drives.
const DENIED_ID_PREFIXES = [
  "dall-e",
  "embedding",
  "gpt-audio",
  "gpt-image",
  "gpt-realtime",
  "grok-imagine",
  "omni-moderation",
  "sora",
  "transcribe",
  "tts",
  "whisper",
]

type CacheFile = {
  readonly providers: Readonly<
    Record<string, { readonly fetchedAt: number; readonly models: readonly DirectoryModel[] }>
  >
}

type MemoryEntry = {
  readonly at: number
  readonly models: readonly DirectoryModel[]
}

export type ModelDirectoryOptions = {
  readonly fetchFn?: typeof fetch
  readonly now?: () => number
  readonly ttlMs?: number
  readonly cachePath?: string
  readonly clientVersion?: string
  readonly anthropicApiKey?: string | (() => string | undefined)
  readonly resolveCodexAuth?: () => Promise<
    | {
        readonly accessToken: string
        readonly accountId?: string | undefined
      }
    | undefined
  >
  readonly resolveGrokToken?: () => Promise<string | undefined>
  /** Test seam: skip disk I/O when set (in-memory only). */
  readonly disableDiskCache?: boolean
}

export function defaultModelCatalogCachePath(): string {
  return join(
    process.env.YAKITORI_HOME ?? join(homedir(), ".yakitori"),
    "model-catalogs.json",
  )
}

export function createModelDirectory(
  input: ModelDirectoryOptions = {},
): ModelDirectory {
  const fetchFn = input.fetchFn ?? fetch
  const now = input.now ?? Date.now
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS
  const cachePath = input.cachePath ?? defaultModelCatalogCachePath()
  const clientVersion = input.clientVersion ?? packageVersion()
  const memory = new Map<string, MemoryEntry>()
  const pending = new Map<string, Promise<readonly DirectoryModel[]>>()
  // Disk file is loaded lazily once; subsequent writes update this mirror so
  // concurrent per-provider refreshes do not drop sibling entries. Cross-
  // process races use atomic rename (last-writer-wins). No file lock: a single
  // server already holds runtime.lock, and opencode-style Flock targets multi-
  // CLI concurrency we do not have.
  let diskMirror: CacheFile | undefined
  let diskMirrorLoaded = false

  const anthropicKey = (): string | undefined => {
    if (typeof input.anthropicApiKey === "function") {
      return input.anthropicApiKey()
    }
    if (input.anthropicApiKey !== undefined) return input.anthropicApiKey
    return process.env.ANTHROPIC_API_KEY
  }

  const resolveCodexAuth =
    input.resolveCodexAuth ??
    (async () => {
      try {
        return await resolveCodexAccessToken()
      } catch {
        return undefined
      }
    })

  const resolveGrokToken =
    input.resolveGrokToken ??
    (async () => {
      try {
        return await resolveGrokAccessToken()
      } catch {
        return undefined
      }
    })

  async function loadDiskMirror(): Promise<CacheFile> {
    if (diskMirrorLoaded) return diskMirror ?? { providers: {} }
    diskMirrorLoaded = true
    if (input.disableDiskCache) {
      diskMirror = { providers: {} }
      return diskMirror
    }
    try {
      const raw = await readFile(cachePath, "utf8")
      diskMirror = sanitizeCacheFile(JSON.parse(raw))
    } catch {
      diskMirror = { providers: {} }
    }
    return diskMirror
  }

  async function writeDiskProvider(
    provider: string,
    models: readonly DirectoryModel[],
    fetchedAt: number,
  ): Promise<void> {
    if (input.disableDiskCache) return
    const current = await loadDiskMirror()
    const next: CacheFile = {
      providers: {
        ...current.providers,
        [provider]: { fetchedAt, models },
      },
    }
    diskMirror = next
    try {
      await mkdir(dirname(cachePath), { recursive: true })
      const tmp = `${cachePath}.${process.pid}.${now()}.tmp`
      await writeFile(tmp, `${JSON.stringify(next)}\n`, "utf8")
      await rename(tmp, cachePath)
    } catch (error) {
      console.warn("model catalog disk cache write failed.", error)
    }
  }

  async function listModels(
    provider: string,
  ): Promise<readonly DirectoryModel[]> {
    const key = provider.toLowerCase()
    const inFlight = pending.get(key)
    if (inFlight !== undefined) return inFlight

    const work = loadProvider(key).finally(() => {
      pending.delete(key)
    })
    pending.set(key, work)
    return work
  }

  async function loadProvider(
    provider: string,
  ): Promise<readonly DirectoryModel[]> {
    // Curated-only providers never hit the network.
    if (provider === "kimi" || provider === "faux") {
      return curatedModels(provider)
    }

    const mem = memory.get(provider)
    if (mem !== undefined && now() - mem.at < ttlMs) {
      return mem.models
    }

    const disk = await loadDiskMirror()
    const diskEntry = disk.providers[provider]
    if (diskEntry !== undefined && now() - diskEntry.fetchedAt < ttlMs) {
      memory.set(provider, { at: diskEntry.fetchedAt, models: diskEntry.models })
      return diskEntry.models
    }

    try {
      const live = await fetchLive(provider)
      if (live !== undefined && live.length > 0) {
        const at = now()
        memory.set(provider, { at, models: live })
        await writeDiskProvider(provider, live, at)
        return live
      }
    } catch (error) {
      console.warn(
        `model catalog live fetch failed for ${provider}; falling back.`,
        error,
      )
    }

    if (mem !== undefined) return mem.models
    if (diskEntry !== undefined) return diskEntry.models
    return snapshotOrCurated(provider)
  }

  async function fetchLive(
    provider: string,
  ): Promise<readonly DirectoryModel[] | undefined> {
    switch (provider) {
      case "codex":
        return fetchCodexModels(
          fetchFn,
          clientVersion,
          await resolveCodexAuth(),
        )
      case "anthropic":
        return fetchAnthropicModels(fetchFn, anthropicKey())
      case "grok":
        return fetchGrokModels(fetchFn, await resolveGrokToken())
      case "openai":
        return fetchOpenAIModels(fetchFn)
      default:
        return undefined
    }
  }

  return { listModels }
}

async function fetchCodexModels(
  fetchFn: typeof fetch,
  clientVersion: string,
  auth:
    | {
        readonly accessToken: string
        readonly accountId?: string | undefined
      }
    | undefined,
): Promise<readonly DirectoryModel[] | undefined> {
  if (auth === undefined) return undefined
  const url = new URL(`${CODEX_API_BASE_URL}/models`)
  url.searchParams.set("client_version", clientVersion)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
  }
  if (auth.accountId !== undefined && auth.accountId.length > 0) {
    headers["chatgpt-account-id"] = auth.accountId
  }
  const response = await fetchFn(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`codex models request failed with HTTP ${response.status}.`)
  }
  return parseCodexModelsPayload(await response.json())
}

function parseCodexModelsPayload(value: unknown): readonly DirectoryModel[] {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    throw new Error("codex models payload must be an object with models[].")
  }
  return value.models.flatMap((entry) => {
    if (!isRecord(entry)) return []
    if (entry.visibility !== "list") return []
    const id =
      typeof entry.slug === "string" && entry.slug.length > 0
        ? entry.slug
        : undefined
    if (id === undefined) return []
    const displayName =
      typeof entry.display_name === "string" && entry.display_name.length > 0
        ? entry.display_name
        : id
    const efforts = parseCodexEfforts(entry.supported_reasoning_levels)
    const defaultEffort =
      typeof entry.default_reasoning_level === "string" &&
      entry.default_reasoning_level.length > 0
        ? entry.default_reasoning_level
        : undefined
    const speeds = parseCodexSpeeds(entry.service_tiers)
    return [
      {
        id,
        displayName,
        ...(typeof entry.description === "string" &&
        entry.description.length > 0
          ? { description: entry.description }
          : {}),
        ...(efforts === undefined ? {} : { efforts }),
        ...(defaultEffort === undefined ? {} : { defaultEffort }),
        ...(speeds === undefined ? {} : { speeds }),
      },
    ]
  })
}

function parseCodexEfforts(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const efforts = value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.effort !== "string") return []
    return entry.effort.length > 0 ? [entry.effort] : []
  })
  return efforts.length > 0 ? efforts : undefined
}

function parseCodexSpeeds(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const tiers = value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") return []
    return entry.id.length > 0 ? [entry.id] : []
  })
  // Picker always offers the server default ("standard") plus declared tiers.
  return tiers.length > 0 ? ["standard", ...tiers] : undefined
}

async function fetchAnthropicModels(
  fetchFn: typeof fetch,
  apiKey: string | undefined,
): Promise<readonly DirectoryModel[] | undefined> {
  if (apiKey === undefined || apiKey.length === 0) return undefined
  const response = await fetchFn(ANTHROPIC_MODELS_URL, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(
      `anthropic models request failed with HTTP ${response.status}.`,
    )
  }
  return parseAnthropicModelsPayload(await response.json())
}

function parseAnthropicModelsPayload(
  value: unknown,
): readonly DirectoryModel[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error("anthropic models payload must be an object with data[].")
  }
  const allowlist = directoryAllowlist("anthropic")
  const parsed = value.data.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") return []
    const id = entry.id
    const displayName =
      typeof entry.display_name === "string" && entry.display_name.length > 0
        ? entry.display_name
        : id
    const efforts = anthropicEffortsForModel(id)
    return [
      {
        id,
        displayName,
        ...(efforts === undefined ? {} : { efforts }),
      },
    ]
  })
  return applyAllowlist(parsed, allowlist)
}

// Claude Code gates effort to Opus/Sonnet 4.6+; Haiku and older models omit it.
function anthropicEffortsForModel(id: string): readonly string[] | undefined {
  const lower = id.toLowerCase()
  if (lower.includes("haiku")) return undefined
  const match = lower.match(/claude-(?:opus|sonnet)-(\d+)(?:[-.](\d+))?/u)
  if (match === null) return undefined
  const major = Number(match[1])
  const minor = Number(match[2] ?? "0")
  if (Number.isNaN(major) || Number.isNaN(minor)) return undefined
  if (major > 4 || (major === 4 && minor >= 6)) return REASONING_EFFORTS
  return undefined
}

async function fetchGrokModels(
  fetchFn: typeof fetch,
  token: string | undefined,
): Promise<readonly DirectoryModel[] | undefined> {
  if (token === undefined || token.length === 0) return undefined
  const response = await fetchFn(`${GROK_API_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`grok models request failed with HTTP ${response.status}.`)
  }
  return parseGrokModelsPayload(await response.json())
}

function parseGrokModelsPayload(value: unknown): readonly DirectoryModel[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error("grok models payload must be an object with data[].")
  }
  const allowlist = directoryAllowlist("grok")
  const parsed = value.data.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") return []
    const id = entry.id
    return [
      {
        id,
        displayName: id,
        efforts: REASONING_EFFORTS,
      },
    ]
  })
  return applyAllowlist(parsed, allowlist)
}

async function fetchOpenAIModels(
  fetchFn: typeof fetch,
): Promise<readonly DirectoryModel[]> {
  const response = await fetchFn(MODELS_DEV_API_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`models.dev request failed with HTTP ${response.status}.`)
  }
  const payload = sanitizeModelsDevPayload(await response.json())
  const models = payload.get(OPENAI_MODELS_DEV_KEY)
  if (models === undefined) {
    throw new Error("models.dev payload has no openai provider entry.")
  }
  // Public OpenAI API has no first-party picker list; models.dev + allowlist
  // is the documented exception. Speed tiers are not declared per model here
  // (codex declares service_tiers per entry; public priority support is
  // unverified), so speeds stay omitted.
  return applyAllowlist(models, directoryAllowlist("openai")).map((model) => ({
    id: model.id,
    displayName: model.name,
    ...(model.reasoning ? { efforts: REASONING_EFFORTS } : {}),
  }))
}

type RawModelsDevModel = {
  readonly id: string
  readonly name: string
  readonly reasoning: boolean
}

function sanitizeModelsDevPayload(
  value: unknown,
): ReadonlyMap<string, readonly RawModelsDevModel[]> {
  if (!isRecord(value)) throw new Error("models.dev payload must be an object.")
  const payload = new Map<string, readonly RawModelsDevModel[]>()
  for (const [providerKey, entry] of Object.entries(value)) {
    if (!isRecord(entry) || !isRecord(entry.models)) continue
    payload.set(
      providerKey,
      Object.entries(entry.models).flatMap(([id, model]) => {
        const parsed = sanitizeModelsDevModel(id, model)
        return parsed === undefined ? [] : [parsed]
      }),
    )
  }
  return payload
}

function sanitizeModelsDevModel(
  id: string,
  value: unknown,
): RawModelsDevModel | undefined {
  if (!isRecord(value)) return undefined
  if (value.tool_call !== true) return undefined
  if (value.status === "deprecated" || value.status === "alpha") {
    return undefined
  }
  if (DENIED_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) {
    return undefined
  }
  const modalities = value.modalities
  if (
    !isRecord(modalities) ||
    !Array.isArray(modalities.input) ||
    !modalities.input.includes("text")
  ) {
    return undefined
  }
  return {
    id,
    name:
      typeof value.name === "string" && value.name.length > 0 ? value.name : id,
    reasoning: value.reasoning === true,
  }
}

function curatedModels(provider: string): readonly DirectoryModel[] {
  return listCatalogModels(provider).map((entry) => ({
    id: entry.model,
    displayName: entry.displayName ?? entry.model,
    ...(entry.efforts === undefined ? {} : { efforts: entry.efforts }),
    ...(entry.speeds === undefined ? {} : { speeds: entry.speeds }),
  }))
}

function snapshotOrCurated(provider: string): readonly DirectoryModel[] {
  const snapshot = bundledSnapshot(provider)
  if (snapshot !== undefined) return snapshot
  return curatedModels(provider)
}

function bundledSnapshot(
  provider: string,
): readonly DirectoryModel[] | undefined {
  switch (provider) {
    case "codex":
      return snapshotModels(codexSnapshot)
    case "anthropic":
      return snapshotModels(anthropicSnapshot)
    case "grok":
      return snapshotModels(grokSnapshot)
    default:
      return undefined
  }
}

function snapshotModels(snapshot: {
  readonly models: readonly unknown[]
}): readonly DirectoryModel[] {
  return snapshot.models.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") return []
    const model: DirectoryModel = {
      id: entry.id,
      displayName:
        typeof entry.displayName === "string" && entry.displayName.length > 0
          ? entry.displayName
          : entry.id,
      ...(typeof entry.description === "string" && entry.description.length > 0
        ? { description: entry.description }
        : {}),
      ...(Array.isArray(entry.efforts)
        ? { efforts: entry.efforts.filter((v): v is string => typeof v === "string") }
        : {}),
      ...(typeof entry.defaultEffort === "string" &&
      entry.defaultEffort.length > 0
        ? { defaultEffort: entry.defaultEffort }
        : {}),
      ...(Array.isArray(entry.speeds)
        ? { speeds: entry.speeds.filter((v): v is string => typeof v === "string") }
        : {}),
    }
    return [model]
  })
}

// Allowlist order is display order; ids absent from the directory drop out.
// Providers without an allowlist entry keep every sanitized model.
function applyAllowlist<T extends { readonly id: string }>(
  models: readonly T[],
  allowlist: readonly string[] | undefined,
): readonly T[] {
  if (allowlist === undefined) return models
  return allowlist.flatMap((id) => {
    const found = models.find((model) => model.id === id)
    return found === undefined ? [] : [found]
  })
}

function sanitizeCacheFile(value: unknown): CacheFile {
  if (!isRecord(value) || !isRecord(value.providers)) return { providers: {} }
  const providers: Record<
    string,
    { readonly fetchedAt: number; readonly models: readonly DirectoryModel[] }
  > = {}
  for (const [key, entry] of Object.entries(value.providers)) {
    if (!isRecord(entry) || typeof entry.fetchedAt !== "number") continue
    if (!Array.isArray(entry.models)) continue
    const models = entry.models.flatMap((model) => {
      if (!isRecord(model) || typeof model.id !== "string") return []
      return [
        {
          id: model.id,
          displayName:
            typeof model.displayName === "string" &&
            model.displayName.length > 0
              ? model.displayName
              : model.id,
          ...(typeof model.description === "string" &&
          model.description.length > 0
            ? { description: model.description }
            : {}),
          ...(Array.isArray(model.efforts)
            ? {
                efforts: model.efforts.filter(
                  (v): v is string => typeof v === "string",
                ),
              }
            : {}),
          ...(typeof model.defaultEffort === "string" &&
          model.defaultEffort.length > 0
            ? { defaultEffort: model.defaultEffort }
            : {}),
          ...(Array.isArray(model.speeds)
            ? {
                speeds: model.speeds.filter(
                  (v): v is string => typeof v === "string",
                ),
              }
            : {}),
        } satisfies DirectoryModel,
      ]
    })
    providers[key] = { fetchedAt: entry.fetchedAt, models }
  }
  return { providers }
}

function packageVersion(): string {
  // Bundled clients report a stable version string; package.json is 0.0.0
  // until a release process pins it.
  return process.env.YAKITORI_VERSION ?? "0.0.0"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
