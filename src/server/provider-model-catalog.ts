import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ConfiguredModel } from "../runtime/provider-presets.ts"
import { ConfigurationError } from "./config-errors.ts"
import {
  type ApiConfiguredProvider,
  requireConfiguredModels,
} from "./provider-configuration.ts"

type Snapshot = NonNullable<ApiConfiguredProvider["catalog"]>

// Magpie keeps discovery separate from exposed model choices. Like the primary
// references' ModelsManager, a stale catalog serves while its single refresh
// runs; endpoint/credential identities never share a persisted result.
export function createProviderModelCatalog(input: {
  directory: string
  identity: string
  discover(): Promise<readonly ConfiguredModel[]>
  changed(): void
  now?: () => number
  ttlMs?: number
}) {
  const now = input.now ?? Date.now
  const ttlMs = input.ttlMs ?? 5 * 60_000
  const path = join(
    input.directory,
    `${createHash("sha256").update(input.identity).digest("hex")}.json`,
  )
  let snapshot: Snapshot = { models: [] }
  let loading: Promise<void> | undefined
  let refreshing: Promise<readonly ConfiguredModel[]> | undefined
  const load = () =>
    (loading ??= (async () => {
      let raw: string
      try {
        raw = await readFile(path, "utf8")
      } catch (error) {
        if (missing(error)) return
        throw error
      }
      let record: unknown
      try {
        record = JSON.parse(raw)
      } catch (error) {
        if (error instanceof SyntaxError) return
        throw error
      }
      if (
        typeof record !== "object" ||
        record === null ||
        !("models" in record) ||
        !Array.isArray(record.models) ||
        !("fetchedAt" in record) ||
        typeof record.fetchedAt !== "number" ||
        !Number.isFinite(record.fetchedAt)
      )
        return
      try {
        snapshot = {
          models: requireConfiguredModels(record.models),
          fetchedAt: record.fetchedAt,
        }
      } catch (error) {
        if (!(error instanceof ConfigurationError)) throw error
      }
    })())
  const seed = async (models: readonly ConfiguredModel[]) => {
    const next = { models, fetchedAt: now() }
    await mkdir(input.directory, { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(next), {
        mode: 0o600,
        flag: "wx",
      })
      await rename(temporary, path)
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!missing(error)) throw error
      })
    }
    snapshot = next
    input.changed()
  }
  const refresh = () =>
    (refreshing ??= (async () => {
      await load()
      try {
        const models = await input.discover()
        await seed(models)
        return models
      } catch (error) {
        if (!(error instanceof ConfigurationError)) throw error
        snapshot = { ...snapshot, error: error.message }
        input.changed()
        throw error
      }
    })().finally(() => {
      refreshing = undefined
    }))
  return {
    snapshot: () => snapshot,
    refresh,
    seed,
    async revalidate() {
      await load()
      if (now() - (snapshot.fetchedAt ?? 0) < ttlMs) return
      await refresh().catch((error: unknown) => {
        if (!(error instanceof ConfigurationError) || !snapshot.models.length)
          throw error
      })
    },
    async models(): Promise<readonly ConfiguredModel[]> {
      await load()
      if (!snapshot.models.length) return refresh()
      return snapshot.models
    },
  }
}

function missing(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  )
}
