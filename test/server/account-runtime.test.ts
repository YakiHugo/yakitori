import { expect, it } from "vitest"
import { createInjectedModelProvider } from "../../src/runtime/model-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createAccountRuntime } from "../../src/server/account-runtime.ts"

it("rejects conflicting account ownership without replacing the previously published accounts", async () => {
  const registry = createProviderRegistry({})
  const runtime = createAccountRuntime(registry)
  const personal = createInjectedModelProvider(
    "personal",
    async function* () {},
  )
  const work = createInjectedModelProvider("work", async function* () {})
  try {
    await runtime.publish("api", { personal })
    await runtime.publish("oauth", { work })
    expect(registry.providers).toEqual(["personal", "work"])
    expect(() =>
      runtime.publish("oauth", {
        personal: createInjectedModelProvider(
          "personal",
          async function* () {},
        ),
      }),
    ).toThrow("more than one owner")
    expect(registry.models("personal")).toBeDefined()
    expect(registry.models("work")).toBeDefined()
    await runtime.publish("api", {})
    expect(registry.providers).toEqual(["work"])
  } finally {
    await registry.close()
  }
})
