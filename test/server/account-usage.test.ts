import { expect, it, vi } from "vitest"
import { providerServices } from "../../src/runtime/provider-services.ts"
import { readAccountUsage } from "../../src/server/account-usage.ts"

it("does not send a compatible endpoint's key to a service billing API", async () => {
  const service = providerServices.find((service) => service.id === "kimi-code")
  if (!service) throw new Error("Missing Kimi service")
  const fetch = vi.spyOn(globalThis, "fetch")
  const result = await readAccountUsage({
    id: "account_relay",
    connected: true,
    apiKey: "relay-key",
    configuration: {
      name: "Relay",
      service: service.id,
      authentication: "stored",
      baseURL: "https://relay.example/messages",
      wireApi: service.wireApi,
      models: [],
    },
  })
  expect(result.subscription).toMatchObject({
    provider: "account_relay",
    usage: { status: "unavailable", reason: "not_supported" },
  })
  expect(fetch).not.toHaveBeenCalled()
})
