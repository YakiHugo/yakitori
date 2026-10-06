import { describe, expect, it } from "vitest"
import {
  createModelProvider,
  createProviderContinuationScope,
  createProviderRegistry,
  createStaticModelsManager,
  type ModelRequest,
  type ModelStreamEvent,
} from "../../src/runtime/index.ts"

describe("provider registry", () => {
  it("applies provider replacements to future Turns while retaining active transports", async () => {
    const seen: string[] = []
    const registry = createProviderRegistry({
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
    registry.replace({
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
    registry.replace({})
    expect(client.hasProvider("personal")).toBe(false)
    expect(() => client.startTurn("personal")).toThrow("not registered")
    for await (const event of active.stream(request("personal", "model")))
      void event
    expect(seen).toEqual(["old", "new", "old"])
    await client.close()
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
