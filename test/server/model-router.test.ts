import { describe, expect, it } from "vitest"
import type { ConfiguredModel } from "../../src/protocol/providers.ts"
import { createConfiguredModelsManager } from "../../src/runtime/configured-models-manager.ts"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import {
  type AccountModelSource,
  createModelRouter,
} from "../../src/server/model-router.ts"

function account(id: string, models: readonly ConfiguredModel[]) {
  return createModelProvider({
    info: {
      id,
      wireApi: "openai_chat_completions",
      capabilities: { remoteCompaction: false },
    },
    models: createConfiguredModelsManager({ provider: id, models }),
    stream: async function* () {},
  })
}

function source(
  accountId: string,
  namespace: string,
  model: string,
  patch: Partial<AccountModelSource> = {},
): AccountModelSource {
  return {
    accountId,
    namespace,
    serviceName: namespace,
    summary: {
      name: accountId,
      availability: "available",
      models: [
        {
          id: model,
          displayName: "Shared label",
          instructionProfileId: "default",
        },
      ],
    },
    ...patch,
  }
}

describe("account model routing", () => {
  it("groups explicit model identities and keeps the account-specific upstream IDs", async () => {
    const registry = createProviderRegistry({
      personal: account("personal", [{ id: "model-x" }]),
      work: account("work", [{ id: "deployment-42" }]),
      other: account("other", [{ id: "unrelated" }]),
    })
    const router = createModelRouter({
      registry,
      readAccounts: async () => [
        source("personal", "vendor", "model-x"),
        source("work", "relay", "deployment-42", {
          identities: {
            "deployment-42": { namespace: "vendor", model: "model-x" },
          },
        }),
        source("other", "other-vendor", "unrelated"),
      ],
    })
    await router.refresh()
    expect(
      router
        .list()
        .find((group) => group.name === "vendor")
        ?.models.map((model) => model.id),
    ).toEqual(["model-x"])
    expect(
      router
        .list()
        .find((group) => group.name === "other-vendor")
        ?.models.map((model) => model.id),
    ).toEqual(["unrelated"])
    expect(router.route({ provider: "vendor", model: "model-x" })).toEqual({
      provider: "personal",
      model: "model-x",
    })
    expect(
      router.route(
        { provider: "vendor", model: "model-x" },
        { preferredAccount: "work" },
      ),
    ).toEqual({ provider: "work", model: "deployment-42" })
    expect(router.selectionFor("work", "deployment-42")).toEqual({
      provider: "vendor",
      model: "model-x",
    })
    await registry.close()
  })

  it("keeps a hidden chat model routable without advertising it in the picker", async () => {
    const registry = createProviderRegistry({
      personal: account("personal", [{ id: "model-x", visible: false }]),
    })
    const router = createModelRouter({
      registry,
      readAccounts: async () => [
        source("personal", "vendor", "model-x", {
          summary: {
            name: "personal",
            availability: "available",
            models: [
              {
                id: "model-x",
                instructionProfileId: "default",
                visible: false,
              },
            ],
          },
        }),
      ],
    })
    await router.refresh()
    expect(
      router.list().find((group) => group.name === "vendor")?.models,
    ).toEqual([expect.objectContaining({ id: "model-x", visible: false })])
    expect(router.route({ provider: "vendor", model: "model-x" })).toEqual({
      provider: "personal",
      model: "model-x",
    })
    await registry.close()
  })

  it("waits for the newer account projection when an admission refresh is superseded", async () => {
    const registry = createProviderRegistry({
      live: account("live", [{ id: "model-x" }]),
    })
    const pending: ((sources: readonly AccountModelSource[]) => void)[] = []
    const router = createModelRouter({
      registry,
      readAccounts: () => new Promise((resolve) => pending.push(resolve)),
    })
    let ready = false
    const first = router.refresh().then(() => {
      ready = true
    })
    const newer = router.refresh()
    pending[0]?.([])
    await Promise.resolve()
    await Promise.resolve()
    expect(ready).toBe(false)
    pending[1]?.([source("live", "vendor", "model-x")])
    await Promise.all([first, newer])
    expect(
      router.route({ provider: "vendor", model: "model-x" }).provider,
    ).toBe("live")
    await registry.close()
  })

  it("filters capabilities on each account instead of routing by their merged display capabilities", async () => {
    const registry = createProviderRegistry({
      text: account("text", [
        {
          id: "model-x",
          inputModalities: ["text"],
          efforts: ["low"],
          contextWindowTokens: 32_000,
        },
      ]),
      vision: account("vision", [
        {
          id: "model-x",
          inputModalities: ["text", "image"],
          efforts: ["high"],
          contextWindowTokens: 128_000,
        },
      ]),
    })
    const router = createModelRouter({
      registry,
      readAccounts: async () => [
        source("text", "vendor", "model-x"),
        source("vision", "vendor", "model-x"),
      ],
    })
    await router.refresh()
    const selection = { provider: "vendor", model: "model-x" }
    const route = router.route(
      { ...selection, effort: "high" },
      { preferredAccount: "text", inputModalities: ["image"] },
    )
    expect(route.provider).toBe("vision")
    expect(
      registry.models(route.provider).capacity(route)?.contextWindowTokens,
    ).toBe(128_000)
    expect(router.route(selection, { preferredAccount: "text" }).provider).toBe(
      "text",
    )
    expect(() =>
      router.route(
        { ...selection, effort: "low" },
        { inputModalities: ["image"] },
      ),
    ).toThrow("requested capabilities")
    await registry.close()
  })

  it("never routes to an account removed after the catalog was read", async () => {
    const registry = createProviderRegistry()
    const registration = registry.register("accounts", {
      one: account("one", [{ id: "model-x" }]),
      two: account("two", [{ id: "model-x" }]),
    })
    const router = createModelRouter({
      registry,
      readAccounts: async () => [
        source("one", "vendor", "model-x"),
        source("two", "vendor", "model-x"),
      ],
    })
    await router.refresh()
    await registration.replace({ two: account("two", [{ id: "model-x" }]) })
    expect(
      router.route(
        { provider: "vendor", model: "model-x" },
        { preferredAccount: "one" },
      ).provider,
    ).toBe("two")
    await registration.replace({})
    expect(() =>
      router.route({ provider: "vendor", model: "model-x" }),
    ).toThrow("No account can run")
    await registry.close()
  })

  it("ignores an older catalog read that finishes after a newer publication", async () => {
    const registry = createProviderRegistry({
      live: account("live", [{ id: "model-x" }]),
    })
    let complete: (sources: readonly AccountModelSource[]) => void = () => {
      throw new Error("Read not started")
    }
    let first = true
    const router = createModelRouter({
      registry,
      readAccounts() {
        if (first) {
          first = false
          return new Promise((resolve) => {
            complete = resolve
          })
        }
        return Promise.resolve([source("live", "vendor", "model-x")])
      },
    })
    const stale = router.refresh()
    await router.refresh()
    complete([source("removed", "old-vendor", "old-model")])
    await stale
    expect(router.namespaces).toEqual(["vendor"])
    expect(
      router.route({ provider: "vendor", model: "model-x" }).provider,
    ).toBe("live")
    expect(router.accounts().map((account) => account.name)).toEqual(["live"])
    await registry.close()
  })
  it("previews executable combinations and explains incompatible account choices", async () => {
    const registry = createProviderRegistry({
      text: account("text", [
        {
          id: "model-x",
          efforts: ["low"],
          defaultEffort: "low",
          inputModalities: ["text"],
          contextWindowTokens: 32_000,
        },
      ]),
      vision: account("vision", [
        {
          id: "deployment",
          efforts: ["high"],
          defaultEffort: "high",
          inputModalities: ["text", "image"],
          imageDetailModes: ["high", "original"],
          contextWindowTokens: 128_000,
        },
      ]),
    })
    const router = createModelRouter({
      registry,
      readAccounts: async () => [
        source("text", "vendor", "model-x", {
          summary: {
            name: "text",
            models: [
              {
                id: "model-x",
                instructionProfileId: "default",
                efforts: ["low"],
                defaultEffort: "low",
              },
            ],
          },
        }),
        source("vision", "relay", "deployment", {
          identities: { deployment: { namespace: "vendor", model: "model-x" } },
          summary: {
            name: "vision",
            models: [
              {
                id: "deployment",
                instructionProfileId: "default",
                efforts: ["high"],
                defaultEffort: "high",
              },
            ],
          },
        }),
      ],
    })
    try {
      await router.refresh()
      const selection = { provider: "vendor", model: "model-x" }
      expect(
        router.list().find((group) => group.name === "vendor")?.models[0]
          ?.defaultEffort,
      ).toBeUndefined()
      const rejected = router.preview(
        { ...selection, effort: "low" },
        { inputModalities: ["image"] },
      )
      expect(rejected.available).toBe(false)
      expect(rejected.efforts).toEqual(["high"])
      expect(rejected.rejections.map((reason) => reason.code)).toEqual([
        "unsupported_modality",
        "unsupported_effort",
      ])
      const accepted = router.preview(
        { ...selection, effort: "high" },
        {
          inputModalities: ["image"],
          imageDetail: "original",
          contextWindowTokens: 64_000,
        },
      )
      expect(accepted).toMatchObject({
        available: true,
        target: { provider: "vision", model: "deployment", effort: "high" },
        defaultEffort: "high",
      })
      expect(
        router.route(
          { ...selection, effort: "high" },
          {
            inputModalities: ["image"],
            imageDetail: "original",
            contextWindowTokens: 64_000,
          },
        ),
      ).toEqual(accepted.target)
      expect(() =>
        router.route(
          { ...selection, effort: "low" },
          { inputModalities: ["image"] },
        ),
      ).toThrow("requested capabilities")
      expect(
        router.route(selection, { contextWindowTokens: 64_000 }).provider,
      ).toBe("vision")
    } finally {
      await registry.close()
    }
  })
  it("admits a context override up to the member's confirmed maximum", async () => {
    const registry = createProviderRegistry({
      one: account("one", [
        {
          id: "model-x",
          contextWindowTokens: 32_000,
          maxContextWindowTokens: 128_000,
        },
      ]),
    })
    const router = createModelRouter({
      registry,
      readAccounts: async () => [source("one", "vendor", "model-x")],
    })
    try {
      await router.refresh()
      expect(
        router.preview(
          { provider: "vendor", model: "model-x" },
          { contextWindowTokens: 64_000 },
        ).available,
      ).toBe(true)
      expect(
        router.preview(
          { provider: "vendor", model: "model-x" },
          { contextWindowTokens: 256_000 },
        ),
      ).toMatchObject({
        available: false,
        rejections: [expect.objectContaining({ code: "budget_exceeded" })],
      })
    } finally {
      await registry.close()
    }
  })
})
