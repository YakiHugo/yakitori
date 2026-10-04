import { ConfigurationError } from "../config-errors.ts"
import {
  type ProviderConfiguration,
  requireProviderConfiguration,
  requireProviderId,
} from "../provider-configuration.ts"
import type {
  ProviderConfigurationResponse,
  ProviderWriteInput,
} from "../provider-service.ts"
import type { RpcMethodDefinition } from "./methods.ts"

export type ProviderRpcParams = {
  "provider/configuration/read": Record<string, never>
  "provider/configuration/write": ProviderWriteInput
  "provider/configuration/delete": Readonly<{ id: string }>
  "provider/configuration/test": ProviderWriteInput
  "provider/configuration/models": ProviderWriteInput
  "provider/subscription/login": Readonly<{ id: string }>
  "provider/subscription/cancel": Readonly<{ id: string }>
  "provider/subscription/import": Readonly<{ id: string; text?: string }>
  "provider/configuration/refresh": Record<string, never>
  "provider/configuration/move": Readonly<{ id: string; beforeId?: string }>
  "provider/configuration/restore": Readonly<{ undoId: string }>
}

export type ProviderRpcResponses = {
  "provider/configuration/read": ProviderConfigurationResponse
  "provider/configuration/write": ProviderConfigurationResponse
  "provider/configuration/delete": ProviderConfigurationResponse
  "provider/configuration/test": Readonly<{ ok: true }>
  "provider/configuration/models": readonly import("../../runtime/provider-presets.ts").ConfiguredModel[]
  "provider/subscription/login": readonly import("../subscription-connections.ts").SubscriptionConnection[]
  "provider/subscription/cancel": readonly import("../subscription-connections.ts").SubscriptionConnection[]
  "provider/subscription/import": readonly import("../subscription-connections.ts").SubscriptionConnection[]
  "provider/configuration/refresh": ProviderConfigurationResponse
  "provider/configuration/move": ProviderConfigurationResponse
  "provider/configuration/restore": ProviderConfigurationResponse
}

export const providerMethods: readonly RpcMethodDefinition[] = [
  {
    method: "provider/subscription/import",
    scope: () => ({ kind: "global", name: "config" }),
    async invoke(params, context) {
      const record = requireRecord(params)
      if (typeof record.id !== "string")
        throw new ConfigurationError("Subscription id is required.")
      if (record.text !== undefined && typeof record.text !== "string")
        throw new ConfigurationError("Account JSON must be a string.")
      return {
        result: await requireService(
          context.providerConfiguration,
        ).importSubscription(record.id, record.text),
      }
    },
  },
  {
    method: "provider/configuration/move",
    scope: () => ({ kind: "global", name: "config" }),
    async invoke(params, context) {
      const record = requireRecord(params)
      return {
        result: await requireService(context.providerConfiguration).move(
          requireProviderId(record.id),
          record.beforeId === undefined
            ? undefined
            : requireProviderId(record.beforeId),
        ),
      }
    },
  },
  {
    method: "provider/configuration/restore",
    scope: () => ({ kind: "global", name: "config" }),
    async invoke(params, context) {
      const record = requireRecord(params)
      if (typeof record.undoId !== "string")
        throw new ConfigurationError("An undo token is required.")
      return {
        result: await requireService(context.providerConfiguration).restore(
          record.undoId,
        ),
      }
    },
  },
  {
    method: "provider/subscription/cancel",
    scope: () => ({ kind: "global", name: "config" }),
    async invoke(params, context) {
      const record = requireRecord(params)
      if (typeof record.id !== "string")
        throw new ConfigurationError("Subscription id is required.")
      return {
        result: await requireService(context.providerConfiguration).cancelLogin(
          record.id,
        ),
      }
    },
  },
  {
    method: "provider/configuration/refresh",
    scope: () => ({ kind: "global", name: "config" }),
    async invoke(_params, context) {
      const service = requireService(context.providerConfiguration)
      await service.reload()
      return { result: await service.read() }
    },
  },
  {
    method: "provider/subscription/login",
    scope: () => ({ kind: "global", name: "config" }),
    async invoke(params, context) {
      const record = requireRecord(params)
      if (typeof record.id !== "string")
        throw new ConfigurationError("Subscription id is required.")
      return {
        result: await requireService(context.providerConfiguration).login(
          record.id,
        ),
      }
    },
  },
  {
    method: "provider/configuration/models",
    scope: () => undefined,
    async invoke(params, context) {
      return {
        result: await requireService(context.providerConfiguration).discover(
          requireWriteInput(params),
        ),
      }
    },
  },
  {
    method: "provider/configuration/read",
    scope: () => ({ kind: "globalSharedRead", name: "config" }),
    async invoke(_params, context) {
      return {
        result: await requireService(context.providerConfiguration).read(),
      }
    },
  },
  {
    method: "provider/configuration/write",
    scope: () => ({ kind: "global", name: "config" }),
    async invoke(params, context) {
      return {
        result: await requireService(context.providerConfiguration).write(
          requireWriteInput(params),
        ),
      }
    },
  },
  {
    method: "provider/configuration/delete",
    scope: () => ({ kind: "global", name: "config" }),
    async invoke(params, context) {
      const record = requireRecord(params)
      return {
        result: await requireService(context.providerConfiguration).delete(
          requireProviderId(record.id),
        ),
      }
    },
  },
  {
    method: "provider/configuration/test",
    // Tests use a snapshot without delaying saves behind a network request.
    scope: () => undefined,
    async invoke(params, context) {
      return {
        result: await requireService(context.providerConfiguration).test(
          requireWriteInput(params),
        ),
      }
    },
  },
]

function requireService(
  value: import("../provider-service.ts").ProviderService | undefined,
) {
  if (value === undefined)
    throw new ConfigurationError("Provider configuration is unavailable.")
  return value
}

function requireWriteInput(params: unknown): Readonly<{
  id?: string
  configuration: ProviderConfiguration
  apiKey?: string
}> {
  const record = requireRecord(params)
  if (record.apiKey !== undefined && typeof record.apiKey !== "string")
    throw new ConfigurationError("apiKey must be a string.")
  return {
    ...(record.id === undefined ? {} : { id: requireProviderId(record.id) }),
    configuration: requireProviderConfiguration(record.configuration),
    ...(record.apiKey === undefined ? {} : { apiKey: record.apiKey }),
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ConfigurationError("Provider parameters must be an object.")
  return value as Record<string, unknown>
}
