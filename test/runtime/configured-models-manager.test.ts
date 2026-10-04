import { describe, expect, it } from "vitest"
import { createConfiguredModelsManager } from "../../src/runtime/configured-models-manager.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"

describe("configured models manager", () => {
  it("lists only configured models and routes known metadata through the connection ID", async () => {
    const manager = createConfiguredModelsManager({
      provider: "openai-work",
      catalogProvider: "openai",
      wireApi: "openai_responses",
      models: [{ id: "gpt-6-sol" }],
    })

    await manager.refresh()
    const models = await manager.listModels()
    expect(models.map((model) => model.model)).toEqual(["gpt-6-sol"])
    expect(models[0]).toMatchObject({
      efforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
    })
    expect(
      manager.resolve({ provider: "openai-work", model: "gpt-6-sol" }),
    ).toMatchObject({
      provider: "openai-work",
      model: "gpt-6-sol",
      instructionProfileId: "gpt-6-sol",
      inputModalities: ["text", "image"],
      applyPatchToolType: "custom",
      supportsCustomTools: true,
      supportsNativeToolSearch: true,
      usedFallbackModelMetadata: false,
    })
    expect(
      manager.capacity({ provider: "openai-work", model: "gpt-6-sol" }),
    ).toEqual({
      contextWindowTokens: 1_050_000,
      maxContextWindowTokens: 1_050_000,
      effectiveContextWindowPercent: 100,
      contextWindowScope: "total",
    })
    expect(() =>
      manager.validate({ provider: "openai", model: "gpt-6-sol" }),
    ).toThrow("cannot resolve provider openai")
    expect(() =>
      manager.resolve({ provider: "openai-work", model: "gpt-6-astra" }),
    ).toThrow("is not configured")
  })

  it("does not infer catalog capabilities from a connection name or model prefix", () => {
    const namedLikeCatalog = createConfiguredModelsManager({
      provider: "openai",
      models: [{ id: "gpt-6-sol" }],
    })
    const unknownVersion = createConfiguredModelsManager({
      provider: "work",
      catalogProvider: "openai",
      models: [{ id: "gpt-6-sol-custom" }],
    })

    for (const [manager, model] of [
      [namedLikeCatalog, "gpt-6-sol"],
      [unknownVersion, "gpt-6-sol-custom"],
    ] as const) {
      const selection = { provider: manager.provider, model }
      expect(manager.resolve(selection)).toMatchObject({
        instructionProfileId: "default",
        inputModalities: ["text"],
        shellToolType: "unified_exec",
        fileEditingToolType: "edit_write",
        supportsNativeToolSearch: false,
        supportsCustomTools: false,
        usedFallbackModelMetadata: true,
      })
      expect(manager.capacity(selection)).toBeUndefined()
      expect(() => manager.validate({ ...selection, effort: "high" })).toThrow(
        "Reasoning effort high is not supported",
      )
      expect(() => manager.validate({ ...selection, speed: "fast" })).toThrow(
        "Speed fast is not supported",
      )
    }
  })

  it("applies explicit model facts without inventing capacity or effort levels", async () => {
    const manager = createConfiguredModelsManager({
      provider: "custom-api",
      models: [
        {
          id: "vision-code",
          displayName: "Work model",
          contextWindowTokens: 200_000,
          maxOutputTokens: 8_000,
          inputModalities: ["text", "image"],
          efforts: ["low", "max"],
          defaultEffort: "max",
          instructionProfileId: "claude-sonnet-4-6",
        },
      ],
    })
    const selection = { provider: "custom-api", model: "vision-code" }

    expect(manager.resolve(selection)).toMatchObject({
      instructionProfileId: "claude-sonnet-4-6",
      maxOutputTokens: 8_000,
      inputModalities: ["text", "image"],
    })
    expect(manager.capacity(selection)).toEqual({
      contextWindowTokens: 200_000,
      maxContextWindowTokens: 200_000,
      effectiveContextWindowPercent: 100,
      contextWindowScope: "total",
    })
    expect((await manager.listModels())[0]).toMatchObject({
      displayName: "Work model",
      efforts: ["low", "max"],
      defaultEffort: "max",
      effortStyle: "levels",
    })
    expect(() =>
      manager.validate({ ...selection, effort: "max" }),
    ).not.toThrow()
    expect(() => manager.validate({ ...selection, effort: "medium" })).toThrow(
      "Reasoning effort medium is not supported",
    )
  })

  it("lets configuration replace inherited limits and disable inherited effort controls", async () => {
    const manager = createConfiguredModelsManager({
      provider: "work",
      catalogProvider: "openai",
      models: [
        {
          id: "gpt-6-sol",
          contextWindowTokens: 100_000,
          maxOutputTokens: 4_000,
          inputModalities: ["text"],
          efforts: [],
        },
      ],
    })
    const selection = { provider: "work", model: "gpt-6-sol" }

    expect(manager.resolve(selection)).toMatchObject({
      inputModalities: ["text"],
      maxOutputTokens: 4_000,
    })
    expect(manager.capacity(selection)?.contextWindowTokens).toBe(100_000)
    expect((await manager.listModels())[0]).toMatchObject({
      efforts: [],
      effortStyle: "none",
    })
    expect((await manager.listModels())[0]?.defaultEffort).toBeUndefined()
    expect(() => manager.validate({ ...selection, effort: "medium" })).toThrow(
      "Reasoning effort medium is not supported",
    )
  })

  it("caps Responses tool capabilities and speeds when the connection uses Chat Completions", async () => {
    const manager = createConfiguredModelsManager({
      provider: "chat-gateway",
      catalogProvider: "openai",
      wireApi: "openai_chat_completions",
      models: [{ id: "gpt-6-sol" }],
    })
    const model = manager.resolve({
      provider: "chat-gateway",
      model: "gpt-6-sol",
    })

    expect(model).toMatchObject({
      instructionProfileId: "gpt-6-sol",
      fileEditingToolType: "edit_write",
      supportsCustomTools: false,
      supportsNativeToolSearch: false,
    })
    expect(model.applyPatchToolType).toBeUndefined()
    expect((await manager.listModels())[0]?.speeds).toBeUndefined()
    expect(() =>
      manager.validate({
        provider: "chat-gateway",
        model: "gpt-6-sol",
        speed: "fast",
      }),
    ).toThrow("Speed fast is not supported")
  })

  it("retains native Messages tool search only for an exact Anthropic model", () => {
    const anthropic = createConfiguredModelsManager({
      provider: "claude-work",
      catalogProvider: "anthropic",
      wireApi: "anthropic_messages",
      models: [{ id: "claude-sonnet-4-6" }, { id: "claude-custom" }],
    })
    const responsesModel = createConfiguredModelsManager({
      provider: "messages-gateway",
      catalogProvider: "openai",
      wireApi: "anthropic_messages",
      models: [{ id: "gpt-6-sol" }],
    })

    expect(
      anthropic.resolve({
        provider: "claude-work",
        model: "claude-sonnet-4-6",
      }),
    ).toMatchObject({
      supportsNativeToolSearch: true,
      supportsCustomTools: false,
      fileEditingToolType: "edit_write",
    })
    expect(
      anthropic.resolve({ provider: "claude-work", model: "claude-custom" })
        .supportsNativeToolSearch,
    ).toBe(false)
    expect(
      responsesModel.resolve({
        provider: "messages-gateway",
        model: "gpt-6-sol",
      }).supportsNativeToolSearch,
    ).toBe(false)
  })

  it("declares the required Messages output budget and respects a configured output ceiling", () => {
    const manager = createConfiguredModelsManager({
      provider: "messages-gateway",
      wireApi: "anthropic_messages",
      models: [
        { id: "custom" },
        {
          id: "small-output",
          contextWindowTokens: 64_000,
          maxOutputTokens: 4_000,
        },
      ],
    })

    expect(
      manager.resolve({ provider: "messages-gateway", model: "custom" })
        .defaultOutputTokens,
    ).toBe(32_000)
    expect(
      manager.resolve({ provider: "messages-gateway", model: "small-output" }),
    ).toMatchObject({ defaultOutputTokens: 4_000, maxOutputTokens: 4_000 })
    const selection = { provider: "messages-gateway", model: "small-output" }
    const session = SessionConfiguration.create(
      {
        selection,
        workspaceRoot: "/workspace",
        enabledTools: [],
        approvalPolicy: "always_approve",
        promptCacheKey: "cache",
      },
      manager,
    )
    const step = session.resolveStep(selection, manager)
    expect(step.maxOutputTokens).toBe(4_000)
    expect(step.modelCapacity?.inputContextLimitTokens).toBe(60_000)
    const chat = createConfiguredModelsManager({
      provider: "chat-gateway",
      wireApi: "openai_chat_completions",
      models: [{ id: "custom" }],
    })
    expect(
      chat.resolve({ provider: "chat-gateway", model: "custom" })
        .defaultOutputTokens,
    ).toBeUndefined()
  })

  it("retains vendor instructions and editing tools without enabling unsupported native Responses schemas", () => {
    const xai = createConfiguredModelsManager({
      provider: "xai-work",
      catalogProvider: "grok",
      wireApi: "openai_responses",
      models: [{ id: "grok-4.7" }],
    })
    const messagesModel = createConfiguredModelsManager({
      provider: "responses-gateway",
      catalogProvider: "anthropic",
      wireApi: "openai_responses",
      models: [{ id: "claude-sonnet-4-6" }],
    })

    expect(
      xai.resolve({ provider: "xai-work", model: "grok-4.7" }),
    ).toMatchObject({
      instructionProfileId: "grok-4.7",
      fileEditingToolType: "search_replace",
      shellToolType: "unified_exec",
      supportsNativeToolSearch: false,
      supportsCustomTools: false,
    })
    expect(
      messagesModel.resolve({
        provider: "responses-gateway",
        model: "claude-sonnet-4-6",
      }),
    ).toMatchObject({
      instructionProfileId: "claude-sonnet-4-6",
      fileEditingToolType: "edit_write",
      supportsNativeToolSearch: false,
      supportsCustomTools: false,
    })
  })

  it("rejects defaults outside the model's configured effort levels", () => {
    expect(() =>
      createConfiguredModelsManager({
        provider: "work",
        models: [{ id: "custom", efforts: ["low"], defaultEffort: "high" }],
      }),
    ).toThrow("Default effort high is not supported")
  })

  it("rejects empty and repeated model IDs before exposing a directory", () => {
    expect(() =>
      createConfiguredModelsManager({
        provider: "work",
        models: [{ id: " " }],
      }),
    ).toThrow("Invalid or duplicate configured model ID")
    expect(() =>
      createConfiguredModelsManager({
        provider: "work",
        models: [{ id: "custom" }, { id: "custom" }],
      }),
    ).toThrow("Invalid or duplicate configured model ID")
  })
})
