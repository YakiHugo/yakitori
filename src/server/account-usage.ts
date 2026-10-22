import type { ApiReadSubscriptionResponse } from "../protocol/application.ts"
import type { ProviderConfiguration } from "../protocol/providers.ts"
import { resolveCodexAccessToken } from "../runtime/codex-credentials.ts"
import { readCodexUsage } from "../runtime/codex-usage.ts"
import { resolveGrokCredentials } from "../runtime/grok-credentials.ts"
import { readGrokUsage } from "../runtime/grok-usage.ts"
import { readKimiUsage } from "../runtime/kimi-usage.ts"
import { providerServices } from "../runtime/provider-services.ts"
import { ConfigurationError } from "./config-errors.ts"

export async function readAccountUsage(input: {
  id: string
  configuration: ProviderConfiguration
  connected: boolean
  apiKey?: string
}): Promise<ApiReadSubscriptionResponse> {
  const { configuration: config } = input
  const oauth =
    config.authentication === "codex_cli" ||
    config.authentication === "grok_cli"
  const subscription: ApiReadSubscriptionResponse["subscription"] = {
    provider: input.id,
    displayName: config.name,
    availability: input.connected ? "available" : "requires_login",
    ...(config.authentication === "none"
      ? {}
      : { credentialKind: oauth ? ("oauth" as const) : ("api_key" as const) }),
    usage: { status: "unavailable", reason: "not_supported" },
  }
  if (!input.connected) return { subscription, fetchedAt: Date.now() }
  const path = config.credentialPath
  if (oauth && !path)
    throw new ConfigurationError("The account has no credential source.")
  let snapshot: Awaited<ReturnType<typeof readCodexUsage>> | undefined
  try {
    if (config.authentication === "codex_cli") {
      const token = await resolveCodexAccessToken({ path: path as string })
      if (token.accountId !== config.credentialOwner)
        throw new ConfigurationError(
          "The Codex account changed. Reconnect it before reading usage.",
        )
      snapshot = await readCodexUsage({ resolveAccessToken: async () => token })
    } else if (config.authentication === "grok_cli") {
      const credentials = await resolveGrokCredentials({ path: path as string })
      if (`account:${credentials.userId}` !== config.credentialOwner)
        throw new ConfigurationError(
          "The Grok account changed. Reconnect it before reading usage.",
        )
      snapshot = await readGrokUsage({
        resolveCredentials: async () => credentials,
      })
    } else if (config.service === "kimi-code" && input.apiKey) {
      const service = providerServices.find(
        (service) => service.id === config.service,
      )
      if (
        service &&
        config.wireApi === service.wireApi &&
        new URL(config.baseURL).href.replace(/\/$/, "") ===
          new URL(service.baseURL).href.replace(/\/$/, "")
      )
        snapshot = await readKimiUsage(input.apiKey)
    }
  } catch (error) {
    if (
      !(
        error instanceof TypeError ||
        error instanceof SyntaxError ||
        (error instanceof DOMException &&
          ["AbortError", "TimeoutError"].includes(error.name)) ||
        (error instanceof Error &&
          /^(Codex usage|Grok billing|Kimi usage)/.test(error.message))
      )
    )
      throw error
    return {
      subscription: {
        ...subscription,
        usage: { status: "unavailable", reason: "temporarily_unavailable" },
      },
      fetchedAt: Date.now(),
    }
  }
  return {
    subscription: snapshot
      ? {
          ...subscription,
          ...(snapshot.plan === undefined ? {} : { plan: snapshot.plan }),
          usage: { status: "available", buckets: snapshot.buckets },
        }
      : subscription,
    fetchedAt: Date.now(),
  }
}
