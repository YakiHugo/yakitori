import { describe, expect, it } from "vitest"
import {
  createModelProvider,
  createProviderContinuationScope,
  createProviderRegistry,
  type ModelRequest,
  type ModelStreamEvent,
} from "../../src/runtime/index.ts"

describe("provider registry", () => {
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
      anthropic: (request) => responseStream(seen, request.target.model),
      openai: (request) => responseStream(seen, request.target.model),
    })

    for await (const _event of registry.stream(request("anthropic", "claude")))
      void _event
    for await (const _event of registry.stream(request("openai", "gpt")))
      void _event

    expect(registry.providers).toEqual(["anthropic", "openai"])
    expect(seen).toEqual(["claude", "gpt"])
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
        createClient() {
          return {
            startTurn() {
              return {
                stream() {
                  enteredTransport = true
                  return responseStream([], "unexpected")
                },
                close() {},
              }
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

  it("closes outstanding Turn sessions before provider clients", async () => {
    const events: string[] = []
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
        createClient() {
          return {
            startTurn() {
              return {
                stream: () => responseStream([], "unused"),
                close() {
                  events.push("turn")
                },
              }
            },
            close() {
              events.push("provider")
            },
          }
        },
      },
    })
    const client = registry.createClient()
    const session = client.startTurn("openai")

    await client.close()
    await session.close()

    expect(events).toEqual(["turn", "provider"])
  })

  it("closes a compatibility-stream client when Turn cleanup fails", async () => {
    let clientClosed = false
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
        createClient() {
          return {
            startTurn() {
              return {
                stream: () => responseStream([], "done"),
                close() {
                  throw new Error("Turn cleanup failed")
                },
              }
            },
            close() {
              clientClosed = true
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
    ).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: "Turn cleanup failed" })],
    })
    expect(clientClosed).toBe(true)
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
