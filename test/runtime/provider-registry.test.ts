import { describe, expect, it } from "vitest"
import {
  createConfiguredModelsManager,
  createModelProvider,
  createProviderContinuationScope,
  createProviderRegistry,
  createStaticModelsManager,
  type ModelRequest,
  type ModelStreamEvent,
} from "../../src/runtime/index.ts"
import {
  createDiscoveringModelsManager,
  type DiscoveredModel,
} from "../../src/runtime/models-manager.ts"

describe("provider registry", () => {
  it("applies provider replacements to future Turns while retaining active transports", async () => {
    const seen: string[] = []
    const registry = createProviderRegistry()
    const registration = registry.register("test", {
      personal: createModelProvider({
        info: {
          id: "personal",
          wireApi: "openai_responses",
          capabilities: { remoteCompaction: false, nativePdf: true },
        },
        stream: () => responseStream(seen, "old"),
      }),
    })
    const available = registry.providers
    const client = registry.createClient()
    const active = client.startTurn("personal")
    const replacing = registration.replace({
      personal: createModelProvider({
        info: {
          id: "personal",
          wireApi: "openai_responses",
          capabilities: { remoteCompaction: false, nativePdf: false },
        },
        stream: () => responseStream(seen, "new"),
      }),
      work: () => responseStream(seen, "work"),
    })
    const next = client.startTurn("personal")
    expect(active.nativePdf).toBe(true)
    expect(next.nativePdf).toBe(false)
    for await (const event of active.stream(request("personal", "model")))
      void event
    for await (const event of next.stream(request("personal", "model")))
      void event
    expect(seen).toEqual(["old", "new"])
    expect(available).toEqual(["personal", "work"])
    const withdrawing = registration.replace({})
    expect(client.hasProvider("personal")).toBe(false)
    expect(() => client.startTurn("personal")).toThrow("not registered")
    for await (const event of active.stream(request("personal", "model")))
      void event
    expect(seen).toEqual(["old", "new", "old"])
    await client.close()
    await replacing
    await withdrawing
    await registry.close()
  })

  it("keeps active Turn facts and request defaults while discovery updates later Turns", async () => {
    let upstream: readonly DiscoveredModel[] = [
      {
        id: "claude-sonnet-4-6",
        contextWindowTokens: 64_000,
        maxOutputTokens: 4_000,
        efforts: ["low"],
        defaultEffort: "low",
        imageDetailModes: ["high"],
      },
    ]
    const models = createDiscoveringModelsManager({
      provider: "work",
      catalogProvider: "anthropic",
      identity: async () => "account",
      discover: async () => upstream,
    })
    const seen: {
      effort: string | undefined
      defaultEffort: string | undefined
      output: number | undefined
    }[] = []
    const registry = createProviderRegistry({
      work: createModelProvider({
        info: {
          id: "work",
          wireApi: "anthropic_messages",
          capabilities: { remoteCompaction: false },
        },
        models,
        stream: async function* (input) {
          seen.push({
            effort: input.target.effort,
            defaultEffort: input.reasoning?.defaultEffort,
            output: input.maxOutputTokens,
          })
          yield {
            type: "response",
            response: { stopReason: "end_turn", content: [] },
          }
        },
      }),
    })
    const client = registry.createClient()
    try {
      const active = client.startTurn("work")
      await active.models.refresh()
      for await (const event of active.stream(
        request("work", "claude-sonnet-4-6"),
      ))
        void event
      upstream = [
        {
          id: "claude-sonnet-4-6",
          contextWindowTokens: 128_000,
          maxOutputTokens: 8_000,
          efforts: ["high"],
          defaultEffort: "high",
          imageDetailModes: ["original"],
        },
      ]
      await models.refresh({ force: true })
      const next = client.startTurn("work")
      await next.models.refresh()
      const selection = { provider: "work", model: "claude-sonnet-4-6" }
      expect(active.models.capacity(selection)?.contextWindowTokens).toBe(
        64_000,
      )
      expect(next.models.capacity(selection)?.contextWindowTokens).toBe(128_000)
      expect(active.models.resolve(selection).imageDetailModes).toEqual([
        "high",
      ])
      expect(next.models.resolve(selection).imageDetailModes).toEqual([
        "original",
      ])
      for (const turn of [active, next])
        for await (const event of turn.stream(
          request("work", "claude-sonnet-4-6"),
        ))
          void event
      expect(seen).toEqual([
        { effort: "low", defaultEffort: "low", output: 4_000 },
        { effort: "low", defaultEffort: "low", output: 4_000 },
        { effort: "high", defaultEffort: "high", output: 8_000 },
      ])
    } finally {
      await client.close()
      await registry.close()
    }
  })

  it("preserves custom Turn models and capabilities through the registry", async () => {
    const providerModels = createConfiguredModelsManager({
      provider: "openai",
      models: [{ id: "provider-model" }],
    })
    const turnModels = createConfiguredModelsManager({
      provider: "openai",
      models: [{ id: "turn-model" }],
    })
    const registry = createProviderRegistry({
      openai: {
        info: {
          id: "openai",
          wireApi: "openai_responses",
          capabilities: {
            remoteCompaction: "responses_compact",
            nativePdf: true,
            tools: {
              supportsCustomTools: true,
              nativeDeferredProtocol: "openai_deferred",
            },
          },
        },
        models: providerModels,
        startTurn() {
          return {
            models: turnModels,
            wireApi: "openai_chat_completions",
            remoteCompaction: false,
            nativePdf: false,
            toolCapabilities: { supportsCustomTools: false },
            stream: () => responseStream([], "unused"),
            close() {},
          }
        },
      },
    })
    const session = registry.createClient().startTurn("openai")
    try {
      expect(session.wireApi).toBe("openai_chat_completions")
      expect(session.remoteCompaction).toBe(false)
      expect(session.nativePdf).toBe(false)
      expect(session.toolCapabilities).toEqual({ supportsCustomTools: false })
      expect(
        session.models.resolve({ provider: "openai", model: "turn-model" })
          .model,
      ).toBe("turn-model")
      expect(() =>
        session.models.validate({
          provider: "openai",
          model: "provider-model",
        }),
      ).toThrow("not configured")
    } finally {
      await session.close()
      await registry.close()
    }
  })

  it("derives stable continuation scopes from provider configuration", () => {
    const scope = createProviderContinuationScope(
      "openai",
      "https://api.openai.com/v1",
      "secret-a",
    )

    expect(
      createProviderContinuationScope(
        "openai",
        "https://api.openai.com/v1",
        "secret-a",
      ),
    ).toBe(scope)
    expect(scope).not.toContain("secret-a")
    expect(
      createProviderContinuationScope(
        "openai",
        "https://api.openai.com/v1",
        "secret-b",
      ),
    ).not.toBe(scope)
  })

  it("routes requests by their resolved target", async () => {
    const seen: string[] = []
    const registry = createProviderRegistry({
      anthropic: (request) =>
        responseStream(seen, `anthropic:${request.target.model}`),
      openai: (request) =>
        responseStream(seen, `openai:${request.target.model}`),
    })

    for await (const _event of registry.stream(request("anthropic", "claude")))
      void _event
    for await (const _event of registry.stream(request("openai", "gpt")))
      void _event

    expect(registry.providers).toEqual(["anthropic", "openai"])
    expect(seen).toEqual(["anthropic:claude", "openai:gpt"])
  })

  it("rejects an unregistered provider before transport", () => {
    const registry = createProviderRegistry({})

    expect(() => registry.stream(request("missing", "model"))).toThrow(
      "Provider missing is not registered",
    )
  })

  it("keeps transport state Turn-scoped while accepting Step model changes", async () => {
    const seen: string[] = []
    const registry = createProviderRegistry({
      openai: createModelProvider({
        info: {
          id: "openai",
          wireApi: "openai_responses",
          capabilities: { remoteCompaction: false },
          retry: { maxAttempts: 1 },
        },
        stream: (request) => responseStream(seen, request.target.model),
      }),
    })
    const client = registry.createClient()
    const session = client.startTurn("openai")

    for await (const _event of session.stream(request("openai", "gpt-a")))
      void _event
    for await (const _event of session.stream(request("openai", "gpt-b")))
      void _event

    expect(seen).toEqual(["gpt-a", "gpt-b"])
    expect(() => session.stream(request("anthropic", "claude"))).toThrow(
      "Turn transport for openai cannot stream target anthropic/claude",
    )
    await session.close()
    await client.close()
  })

  it("rebuilds attempt transport with the previous classified failure", async () => {
    const attempts: NonNullable<ModelRequest["attempt"]>[] = []
    const provider = createModelProvider({
      info: {
        id: "openai",
        wireApi: "openai_responses",
        capabilities: { remoteCompaction: false },
        retry: { sleep: async () => {}, random: () => 0 },
      },
      createAttemptStream(attempt) {
        attempts.push(attempt)
        return async function* () {
          if (attempt.number === 1) {
            yield {
              type: "failure",
              failure: {
                kind: "connection_failed",
                stage: "connect",
                provider: "openai",
                wireApi: "openai_responses",
                message: "connect failed",
              },
            }
            return
          }
          yield* responseStream([], "recovered")
        }
      },
    })
    const session = provider.startTurn({ maxAttempts: 2 })

    const events: ModelStreamEvent[] = []
    for await (const event of session.stream(request("openai", "gpt"))) {
      events.push(event)
    }

    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toMatchObject({
      number: 2,
      maxAttempts: 2,
      previousFailure: {
        kind: "connection_failed",
        attempt: 1,
        retryDecision: "retry",
      },
    })
    expect(events.at(-1)).toMatchObject({ type: "response" })
  })

  it("enforces the Turn provider fence for custom provider implementations", () => {
    let enteredTransport = false
    const registry = createProviderRegistry({
      openai: {
        info: {
          id: "openai",
          wireApi: "openai_responses",
          capabilities: { remoteCompaction: false },
        },
        models: createModelProvider({
          info: {
            id: "openai",
            wireApi: "openai_responses",
            capabilities: { remoteCompaction: false },
          },
          stream: () => responseStream([], "unused"),
        }).models,
        startTurn() {
          return {
            models: createStaticModelsManager("openai"),
            stream() {
              enteredTransport = true
              return responseStream([], "unexpected")
            },
            close() {},
          }
        },
      },
    })
    const session = registry.createClient().startTurn("openai")

    expect(() => session.stream(request("anthropic", "claude"))).toThrow(
      "Turn transport for openai cannot stream target anthropic/claude",
    )
    expect(enteredTransport).toBe(false)
  })

  it("closes every outstanding Turn once when its Session closes", async () => {
    const closed: number[] = []
    let turns = 0
    const registry = createProviderRegistry({
      openai: {
        info: {
          id: "openai",
          wireApi: "openai_responses",
          capabilities: { remoteCompaction: false },
        },
        models: createModelProvider({
          info: {
            id: "openai",
            wireApi: "openai_responses",
            capabilities: { remoteCompaction: false },
          },
          stream: () => responseStream([], "unused"),
        }).models,
        startTurn() {
          const turn = ++turns
          return {
            models: createStaticModelsManager("openai"),
            stream: () => responseStream([], "unused"),
            close() {
              closed.push(turn)
            },
          }
        },
      },
    })
    const client = registry.createClient()
    const session = client.startTurn("openai")
    const second = client.startTurn("openai")

    const closing = client.close()
    expect(client.close()).toBe(closing)
    await closing
    await session.close()
    await second.close()

    expect(closed).toEqual([1, 2])
    expect(() => client.startTurn("openai")).toThrow("Model client is closed")
  })

  it("does not send a request when its Turn closes during catalog preparation", async () => {
    let beginRefresh = () => {}
    let finishRefresh = () => {}
    const started = new Promise<void>((resolve) => {
      beginRefresh = resolve
    })
    const refreshing = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const seen: string[] = []
    const models = createDiscoveringModelsManager({
      provider: "grok",
      catalogProvider: "grok",
      identity: async () => "bound-account",
      async discover() {
        beginRefresh()
        await refreshing
        return [{ id: "grok-4.7" }]
      },
    })
    const registry = createProviderRegistry({
      grok: createModelProvider({
        info: {
          id: "grok",
          wireApi: "openai_responses",
          capabilities: { remoteCompaction: false },
        },
        models,
        stream: () => responseStream(seen, "inference"),
      }),
    })
    const client = registry.createClient()
    const turn = client.startTurn("grok")
    const pending = (async () => {
      for await (const event of turn.stream(request("grok", "grok-4.7")))
        void event
    })()
    try {
      await started
      await turn.close()
      finishRefresh()
      await expect(pending).rejects.toThrow("Model Turn is closed")
      expect(seen).toEqual([])
    } finally {
      finishRefresh()
      await client.close()
      await registry.close()
    }
  })

  it("finishes every outstanding Turn cleanup before reporting Session cleanup failure", async () => {
    const closed: number[] = []
    let turns = 0
    const provider = createModelProvider({
      info: {
        id: "openai",
        wireApi: "openai_responses",
        capabilities: { remoteCompaction: false },
      },
      stream: () => responseStream([], "unused"),
    })
    const client = createProviderRegistry({
      openai: {
        ...provider,
        startTurn() {
          const turn = ++turns
          return {
            models: provider.models,
            stream: () => responseStream([], "unused"),
            async close() {
              closed.push(turn)
              if (turn === 1) throw new Error("Turn cleanup failed")
            },
          }
        },
      },
    }).createClient()
    client.startTurn("openai")
    client.startTurn("openai")
    const closing = client.close()
    expect(client.close()).toBe(closing)
    await expect(closing).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: "Turn cleanup failed" })],
    })
    expect(closed).toEqual([1, 2])
  })

  it("reports Turn cleanup failure from a single request stream", async () => {
    const registry = createProviderRegistry({
      openai: {
        info: {
          id: "openai",
          wireApi: "openai_responses",
          capabilities: { remoteCompaction: false },
        },
        models: createModelProvider({
          info: {
            id: "openai",
            wireApi: "openai_responses",
            capabilities: { remoteCompaction: false },
          },
          stream: () => responseStream([], "unused"),
        }).models,
        startTurn() {
          return {
            models: createStaticModelsManager("openai"),
            stream: () => responseStream([], "done"),
            close() {
              throw new Error("Turn cleanup failed")
            },
          }
        },
      },
    })

    await expect(
      (async () => {
        for await (const _event of registry.stream(request("openai", "gpt")))
          void _event
      })(),
    ).rejects.toThrow("Turn cleanup failed")
  })
})

function request(provider: string, model: string): ModelRequest {
  return {
    target: { provider, model, instructionProfileId: "default" },
    system: [],
    messages: [],
    tools: [],
    toolWireProtocol: "eager",
  }
}

async function* responseStream(
  seen: string[],
  model: string,
): AsyncGenerator<ModelStreamEvent> {
  seen.push(model)
  yield {
    type: "response",
    response: { stopReason: "end_turn", content: [] },
  }
}
