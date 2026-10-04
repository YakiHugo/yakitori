import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ConfigurationError } from "./config-errors.ts"
import {
  providerConfigValue,
  providersFromConfig,
  requireProviderId,
  type StoredProviderConfiguration,
} from "./provider-configuration.ts"

// Immutable changes retain credential references, never credential contents.
// An undo is applicable only while this connection still matches its result;
// another UI/model/file edit must not be overwritten by an old undo token.
export function createProviderConfigurationHistory(directory: string) {
  return {
    async record(
      id: string,
      before: StoredProviderConfiguration | undefined,
      after: StoredProviderConfiguration | undefined,
    ) {
      const token = `undo_${randomUUID()}`
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(
        join(directory, `${token}.json`),
        JSON.stringify({
          id,
          before: before ? providerConfigValue(before) : null,
          after: after ? providerConfigValue(after) : null,
        }),
        { mode: 0o600, flag: "wx" },
      )
      return token
    },
    async read(
      token: string,
      current: Readonly<Record<string, StoredProviderConfiguration>>,
    ) {
      if (!/^undo_[a-f0-9-]{36}$/.test(token))
        throw new ConfigurationError("Invalid undo token.")
      let raw: string
      try {
        raw = await readFile(join(directory, `${token}.json`), "utf8")
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          throw new ConfigurationError("This undo token is unavailable.")
        throw error
      }
      const record: unknown = JSON.parse(raw)
      if (
        typeof record !== "object" ||
        record === null ||
        !("id" in record) ||
        !("before" in record) ||
        !("after" in record)
      )
        throw new ConfigurationError("Invalid provider history.")
      const id = requireProviderId(record.id)
      const before =
        record.before === null
          ? undefined
          : providersFromConfig({ [id]: record.before })[id]
      const after =
        record.after === null
          ? undefined
          : providersFromConfig({ [id]: record.after })[id]
      if (
        JSON.stringify(
          current[id] ? providerConfigValue(current[id]) : null,
        ) !== JSON.stringify(after ? providerConfigValue(after) : null)
      )
        throw new ConfigurationError(
          "This connection changed after that operation. Inspect it before making another change.",
        )
      return { id, before }
    },
  }
}
