import { expect, it } from "vitest"
import type { ProviderConfiguration } from "../../src/protocol/providers.ts"
import type { ModelProviderCapabilities } from "../../src/runtime/model-provider.ts"
import { createGrokProvider } from "../../src/runtime/grok-provider.ts"
import { resolveProviderBackend } from "../../src/runtime/provider-backend.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { requireProviderConfiguration } from "../../src/server/provider-configuration.ts"

type EndpointContract = Pick<
  ProviderConfiguration,
  "service" | "baseURL" | "wireApi"
> & {
  profile: Record<string, string>
  capabilities: ModelProviderCapabilities
}

it.each([
  {
    service: "openai",
    baseURL: "https://API.OPENAI.COM:443/v1/",
    wireApi: "openai_responses",
    profile: { responseProfile: "openai" },
    capabilities: {
      remoteCompaction: "responses_compact",
      nativePdf: true,
      tools: {
        supportsCustomTools: true,
        nativeDeferredProtocol: "openai_deferred",
      },
    },
  },
  {
    service: "openai",
    baseURL: "https://api.openai.com/v1",
    wireApi: "openai_chat_completions",
    profile: { chatCompletionsFlavor: "generic" },
    capabilities: {
      remoteCompaction: false,
      nativePdf: true,
      tools: { supportsCustomTools: false },
    },
  },
  {
    service: "codex",
    baseURL: "https://CHATGPT.COM:443/backend-api/codex/",
    wireApi: "openai_responses",
    profile: { responseProfile: "openai" },
    capabilities: {
      remoteCompaction: "codex_remote",
      nativePdf: false,
      tools: {
        supportsCustomTools: true,
        nativeDeferredProtocol: "openai_deferred",
      },
    },
  },
  {
    service: "anthropic",
    baseURL: "https://api.anthropic.com/",
    wireApi: "anthropic_messages",
    profile: { anthropicProfile: "anthropic" },
    capabilities: {
      remoteCompaction: false,
      nativePdf: true,
      tools: {
        supportsCustomTools: false,
        nativeDeferredProtocol: "anthropic_deferred",
      },
    },
  },
  ...(
    [
      {
        baseURL: "https://generativelanguage.googleapis.com/v1beta/",
        wireApi: "gemini_generate_content",
      },
      {
        baseURL: "https://generativelanguage.googleapis.com/v1beta/",
        wireApi: "gemini_interactions",
      },
      {
        baseURL: "https://generativelanguage.googleapis.com/v1/",
        wireApi: "gemini_interactions",
      },
    ] as const
  ).map((endpoint) => ({
    ...endpoint,
    service: "gemini",
    profile: { chatCompletionsFlavor: "gemini" },
    capabilities: {
      remoteCompaction: false as const,
      nativePdf: true,
      tools: { supportsCustomTools: false },
    },
  })),
  {
    service: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    wireApi: "openai_chat_completions",
    profile: { chatCompletionsFlavor: "gemini" },
    capabilities: {
      remoteCompaction: false,
      nativePdf: false,
      tools: { supportsCustomTools: false },
    },
  },
  {
    service: "kimi-code",
    baseURL: "https://api.kimi.com/coding/v1/",
    wireApi: "anthropic_messages",
    profile: { anthropicProfile: "kimi-code" },
    capabilities: {
      remoteCompaction: false,
      nativePdf: false,
      tools: { supportsCustomTools: false },
    },
  },
  {
    service: "moonshot",
    baseURL: "https://api.moonshot.ai/v1/",
    wireApi: "openai_responses",
    profile: { responseProfile: "kimi" },
    capabilities: {
      remoteCompaction: false,
      nativePdf: false,
      tools: { supportsCustomTools: false },
    },
  },
  ...(["openai_responses", "openai_chat_completions"] as const).map(
    (wireApi) => ({
      service: "xai",
      baseURL: "https://api.x.ai/v1/",
      wireApi,
      profile: { responseProfile: "grok" },
      capabilities: {
        remoteCompaction: false as const,
        nativePdf: false,
        tools: { supportsCustomTools: false },
      },
    }),
  ),
] satisfies EndpointContract[])("resolves the explicit $service $wireApi endpoint contract", (endpoint) => {
  const backend = resolveProviderBackend(endpoint)
  expect(backend).toMatchObject({
    serviceId: endpoint.service,
    ...endpoint.profile,
  })
  expect(backend.capabilities).toEqual(endpoint.capabilities)
})

it.each([
  "https://relay.example/v1beta",
  "https://generativelanguage.googleapis.com/proxy/v1beta",
  "https://generativelanguage.googleapis.com/v1beta/openai",
])("keeps unconfirmed Interactions endpoints generic: %s", (baseURL) => {
  const backend = resolveProviderBackend({
    service: "gemini",
    baseURL,
    wireApi: "gemini_interactions",
  })
  expect(backend.serviceId).toBeUndefined()
  expect(backend.capabilities.nativePdf).toBe(false)
})

it.each([
  { service: "openai", baseURL: "https://relay.example/v1" },
  { service: "openai", baseURL: "https://api.openai.com/proxy/v1" },
  { service: "openai", baseURL: "https://api.openai.com/v1//" },
  { service: "generic", baseURL: "https://api.openai.com/v1" },
  { service: "kimi-code", baseURL: "https://api.kimi.com/coding" },
])("keeps an unconfirmed protocol or endpoint generic: %j", (endpoint) => {
  const configuration = requireProviderConfiguration({
    ...endpoint,
    name: "OpenAI",
    preset: "openai",
    wireApi: "openai_responses",
    authentication: "none",
    models: [],
  })
  const backend = resolveProviderBackend(configuration)
  expect(backend.serviceId).toBeUndefined()
  expect(backend.catalogProvider).toBeUndefined()
  expect(backend.capabilities).toEqual({
    remoteCompaction: false,
    nativePdf: false,
    tools: { supportsCustomTools: false },
  })
})

it.each([
  {
    service: "codex",
    baseURL: "https://chatgpt.com/backend-api/codex",
    wireApi: "openai_chat_completions",
  },
  {
    service: "codex",
    baseURL: "https://relay.example/backend-api/codex",
    wireApi: "openai_responses",
  },
  {
    service: "openai",
    baseURL: "https://api.openai.com/v1",
    wireApi: "anthropic_messages",
  },
  {
    service: "anthropic",
    baseURL: "https://api.anthropic.com",
    wireApi: "openai_responses",
  },
  {
    service: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    wireApi: "openai_chat_completions",
  },
  {
    service: "xai",
    baseURL: "https://relay.example/v1",
    wireApi: "openai_responses",
  },
  {
    service: "moonshot",
    baseURL: "https://api.moonshot.ai/v1",
    wireApi: "openai_chat_completions",
  },
] as const)("does not grant features or vendor profiles to a mismatched endpoint: %j", (configuration) => {
  const backend = resolveProviderBackend(configuration)
  expect(backend.serviceId).toBeUndefined()
  expect(backend.capabilities).toEqual({
    remoteCompaction: false,
    nativePdf: false,
    tools: { supportsCustomTools: false },
  })
  expect(backend.responseProfile).toBe("openai")
  expect(backend.anthropicProfile).toBe("generic")
  expect(backend.chatCompletionsFlavor).toBe("generic")
})

it("shares the Grok backend contract across API keys and CLI credentials", () => {
  const api = createConfiguredProvider(
    "api-account",
    requireProviderConfiguration({
      name: "My API account",
      service: "xai",
      wireApi: "openai_responses",
      baseURL: "https://api.x.ai/v1",
      models: [],
    }),
    "fixture-key",
  )
  const cli = createGrokProvider("/unused-model-cache", {
    id: "cli-account",
    credentialsPath: "/unused-credentials",
    ownerIdentity: "fixture-owner",
  })
  expect(api.info.capabilities).toEqual({
    remoteCompaction: false,
    nativePdf: false,
    tools: { supportsCustomTools: false },
  })
  expect(cli.info.capabilities).toEqual(api.info.capabilities)
})

it("retains Grok model facts on its official Chat Completions endpoint", () => {
  const provider = createConfiguredProvider(
    "grok-chat",
    requireProviderConfiguration({
      name: "Grok Chat account",
      service: "xai",
      wireApi: "openai_chat_completions",
      baseURL: "https://api.x.ai/v1",
      models: [{ id: "grok-4.7" }],
    }),
    "fixture-key",
  )
  expect(provider.info.serviceId).toBe("xai")
  const model = provider.models.resolve({
    provider: "grok-chat",
    model: "grok-4.7",
  })
  expect(model.usedFallbackModelMetadata).toBe(false)
  expect(model.inputModalities).toEqual(["text", "image"])
  expect(model.efforts).toContain("high")
  expect(model.supportsNativeToolSearch).toBe(false)
  expect(model.supportsCustomTools).toBe(false)
})

const cliConfiguration = {
  name: "CLI account",
  service: "xai",
  wireApi: "openai_responses",
  baseURL: "https://api.x.ai/v1",
  authentication: "grok_cli",
  credentialPath: "/credentials/auth.json",
  credentialOwner: "fixture-owner",
  models: [],
} as const

it.each([
  { service: "kimi-code" },
  { service: "generic" },
  { authentication: "codex_cli" },
  { wireApi: "openai_chat_completions" },
  { baseURL: "https://relay.example/v1" },
  { baseURL: "https://api.x.ai/another/v1" },
])("rejects a CLI identity that contradicts its backend: %j", (override) => {
  expect(() =>
    requireProviderConfiguration({ ...cliConfiguration, ...override }),
  ).toThrow("matching service, documented endpoint and protocol")
})

it.each([
  {
    ...cliConfiguration,
    baseURL: "https://API.X.AI:443/v1/",
  },
  {
    ...cliConfiguration,
    service: "codex",
    authentication: "codex_cli",
    baseURL: "https://CHATGPT.COM:443/backend-api/codex/",
  },
] satisfies ProviderConfiguration[])("accepts a normalized CLI endpoint for $service", (configuration) => {
  expect(requireProviderConfiguration(configuration)).toEqual(configuration)
})

it("rejects Codex service configuration without its CLI credential source", () => {
  expect(() =>
    requireProviderConfiguration({
      ...cliConfiguration,
      service: "codex",
      authentication: "stored",
      baseURL: "https://chatgpt.com/backend-api/codex",
    }),
  ).toThrow("Codex service requires CLI authentication")
})
