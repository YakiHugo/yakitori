import {
  directoryAllowlist,
  listCatalogModels,
  type PromptId,
  resolveModel,
} from "../runtime/index.ts"

export type DirectoryModel = {
  readonly id: string
  readonly displayName: string
  readonly family: PromptId
  readonly efforts?: readonly string[]
  readonly speeds?: readonly string[]
}

export type ModelDirectory = {
  listModels(provider: string): Promise<readonly DirectoryModel[]>
}

const MODELS_DEV_API_URL = "https://models.dev/api.json"
const DEFAULT_TTL_MS = 3_600_000

// models.dev provider keys differ from yakitori provider names; providers
// absent here (faux, kimi, codex) serve the curated catalog instead — kimi's
// managed coding endpoint and the codex ChatGPT backend have their own model
// sets that models.dev does not describe.
const PROVIDER_KEYS: Readonly<Record<string, string>> = {
  anthropic: "anthropic",
  grok: "xai",
  openai: "openai",
}

// Only adapters that can map a reasoning effort onto the request.
const EFFORT_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "grok",
  "openai",
])
const REASONING_EFFORTS = ["low", "medium", "high"] as const

// The public OpenAI Responses API accepts service_tier on reasoning models;
// grok/anthropic get no speed tiers.
const SPEED_TIER_PROVIDER = "openai"
const SPEED_TIERS = ["standard", "fast"] as const

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

type RawDirectoryModel = {
  readonly id: string
  readonly name: string
  readonly reasoning: boolean
}

export function createModelDirectory(input?: {
  readonly fetchFn?: typeof fetch
  readonly now?: () => number
  readonly ttlMs?: number
}): ModelDirectory {
  const fetchFn = input?.fetchFn ?? fetch
  const now = input?.now ?? Date.now
  const ttlMs = input?.ttlMs ?? DEFAULT_TTL_MS
  // Last-good payload is kept past its TTL: a transient fetch failure falls
  // back to the stale directory before degrading to the curated list.
  let cached:
    | { readonly at: number; readonly payload: DirectoryPayload }
    | undefined
  let pending: Promise<DirectoryPayload> | undefined

  const load = (): Promise<DirectoryPayload> => {
    if (cached !== undefined && now() - cached.at < ttlMs) {
      return Promise.resolve(cached.payload)
    }
    pending ??= fetchDirectory(fetchFn)
      .then((payload) => {
        cached = { at: now(), payload }
        return payload
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }

  return {
    async listModels(provider) {
      const key = PROVIDER_KEYS[provider]
      if (key === undefined) return curatedModels(provider)
      try {
        const models = (await load()).get(key)
        if (models === undefined) return curatedModels(provider)
        return mapDirectoryModels(provider, models)
      } catch (error) {
        const stale = cached?.payload.get(key)
        if (stale !== undefined) {
          console.warn("models.dev refresh failed; serving stale cache.", error)
          return mapDirectoryModels(provider, stale)
        }
        console.warn(
          "models.dev unavailable; serving curated catalog entries.",
          error,
        )
        return curatedModels(provider)
      }
    },
  }
}

function mapDirectoryModels(
  provider: string,
  models: readonly RawDirectoryModel[],
): readonly DirectoryModel[] {
  return applyAllowlist(models, directoryAllowlist(provider)).map((model) => ({
    id: model.id,
    displayName: model.name,
    family: resolveModel({ provider, model: model.id }).promptId,
    ...(EFFORT_PROVIDERS.has(provider) && model.reasoning
      ? { efforts: REASONING_EFFORTS }
      : {}),
    ...(provider === SPEED_TIER_PROVIDER && model.reasoning
      ? { speeds: SPEED_TIERS }
      : {}),
  }))
}

type DirectoryPayload = ReadonlyMap<string, readonly RawDirectoryModel[]>

async function fetchDirectory(
  fetchFn: typeof fetch,
): Promise<DirectoryPayload> {
  // Bounded wait: a hung models.dev connection must not stall /providers
  // (and with it the GUI picker) indefinitely.
  const response = await fetchFn(MODELS_DEV_API_URL, {
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new Error(`models.dev request failed with HTTP ${response.status}.`)
  }
  return sanitizePayload(await response.json())
}

// The models.dev payload is an external integration surface: treat it as
// untyped data and drop anything malformed or not coding-relevant.
function sanitizePayload(value: unknown): DirectoryPayload {
  if (!isRecord(value)) throw new Error("models.dev payload must be an object.")
  const payload = new Map<string, readonly RawDirectoryModel[]>()
  for (const [providerKey, entry] of Object.entries(value)) {
    if (!isRecord(entry) || !isRecord(entry.models)) continue
    payload.set(
      providerKey,
      Object.entries(entry.models).flatMap(([id, model]) => {
        const parsed = sanitizeModel(id, model)
        return parsed === undefined ? [] : [parsed]
      }),
    )
  }
  return payload
}

function sanitizeModel(
  id: string,
  value: unknown,
): RawDirectoryModel | undefined {
  if (!isRecord(value)) return undefined
  if (value.tool_call !== true) return undefined
  if (value.status === "deprecated" || value.status === "alpha")
    return undefined
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
    family: entry.promptId,
    ...(entry.efforts === undefined ? {} : { efforts: entry.efforts }),
    ...(entry.speeds === undefined ? {} : { speeds: entry.speeds }),
  }))
}

// Allowlist order is display order; ids absent from the directory drop out.
// Providers without an allowlist entry keep every sanitized model.
function applyAllowlist(
  models: readonly RawDirectoryModel[],
  allowlist: readonly string[] | undefined,
): readonly RawDirectoryModel[] {
  if (allowlist === undefined) return models
  return allowlist.flatMap((id) => {
    const found = models.find((model) => model.id === id)
    return found === undefined ? [] : [found]
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
