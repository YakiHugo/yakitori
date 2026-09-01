import { describe, expect, it } from "vitest"
import {
  createProviderRegistry,
  type ModelRequest,
  type ModelStreamEvent,
} from "../../src/runtime/index.ts"

describe("provider registry", () => {
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
