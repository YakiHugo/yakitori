import { describe, expect, it } from "vitest"
import { chatCompletionsIncompatibility } from "../../src/runtime/chat-completions-compatibility.ts"
import type { ModelMessage, ModelRequest } from "../../src/runtime/model.ts"

const official = { baseURL: "https://api.openai.com/v1", model: "fallback" }
const tools: ModelRequest["tools"] = [
  { name: "read_file", description: "Read a file", inputSchema: {} },
]
const assistantCall: ModelMessage = {
  role: "assistant",
  content: [
    { type: "tool_call", id: "call_read", name: "read_file", input: {} },
  ],
}
const toolResult: ModelMessage = {
  role: "tool",
  toolCallId: "call_read",
  content: [{ type: "text", text: "File contents" }],
}

describe("OpenAI Chat Completions compatibility", () => {
  it.each([
    "gpt-6-astra",
    "gpt-6.1-sol",
  ])("%s permits plain chat but directs tools and tool history to Responses", (model) => {
    expect(chatCompletionsIncompatibility(official, request(model))).toBe(
      undefined,
    )
    for (const toolInput of [
      { tools },
      { messages: [assistantCall] },
      { messages: [toolResult] },
    ]) {
      const input = request(model, toolInput)
      expect(chatCompletionsIncompatibility(official, input)).toContain(
        `${model} requires the Responses API`,
      )
    }
  })

  it.each([
    "gpt-6-sol",
    "gpt-6-luna",
  ])("%s requires an explicit none effort for tools without changing effort", (model) => {
    for (const effort of [undefined, "low", "medium", "high", "none"]) {
      for (const toolInput of [
        { tools },
        { messages: [assistantCall] },
        { messages: [toolResult] },
      ]) {
        const input = request(model, toolInput, effort)
        Object.freeze(input.target)
        const error = chatCompletionsIncompatibility(official, input)
        if (effort === "none") expect(error).toBeUndefined()
        else {
          expect(error).toContain('reasoning_effort "none"')
          expect(error).toContain("Select the Responses API")
        }
        expect(input.target.effort).toBe(effort)
      }
      expect(
        chatCompletionsIncompatibility(official, request(model, {}, effort)),
      ).toBeUndefined()
    }
  })

  it("directs GPT-5.1-Codex to Responses even without tools", () => {
    for (const input of [
      request("gpt-5.1-codex"),
      request("gpt-5.1-codex", { tools }, "none"),
    ]) {
      expect(chatCompletionsIncompatibility(official, input)).toContain(
        "gpt-5.1-codex is available only through the Responses API",
      )
    }
  })

  it.each([
    "https://api.openai.com/v1/",
    "https://API.OPENAI.COM:443/v1",
  ])("recognizes the official endpoint spelling %s", (baseURL) => {
    expect(
      chatCompletionsIncompatibility(
        { ...official, baseURL },
        request("gpt-6-astra", { tools }),
      ),
    ).toContain("requires the Responses API")
  })

  it.each([
    "https://custom.example/v1",
    "https://api.openai.com.custom.example/v1",
    "https://api.openai.com@custom.example/v1",
    "https://custom.example/api.openai.com/v1",
    "https://api.openai.com/proxy/v1",
    "https://api.openai.com/v10",
    "https://api.openai.com:8443/v1",
    "http://api.openai.com/v1",
    "invalid URL",
  ])("leaves nonstandard endpoint %s to its own provider", (baseURL) => {
    expect(
      chatCompletionsIncompatibility(
        { ...official, baseURL },
        request("gpt-5.1-codex", { tools }),
      ),
    ).toBeUndefined()
  })

  it.each([
    "gpt-5",
    "gpt-6-astra-custom",
    "gpt-6.1-sol-custom",
    "gpt-6-sol-custom",
    "gpt-6-luna-custom",
    "gpt-5.1-codex-custom",
    "unknown-model",
  ])("does not infer restrictions for model %s", (model) => {
    expect(
      chatCompletionsIncompatibility(official, request(model, { tools })),
    ).toBeUndefined()
  })

  it("uses the request model before the configured fallback", () => {
    const options = { ...official, model: "gpt-5.1-codex" }
    expect(
      chatCompletionsIncompatibility(options, request("", { tools })),
    ).toContain("gpt-5.1-codex is available only through the Responses API")
    expect(
      chatCompletionsIncompatibility(options, request("gpt-5", { tools })),
    ).toBeUndefined()
  })
})

function request(
  model: string,
  overrides: Partial<Pick<ModelRequest, "messages" | "tools">> = {},
  effort?: string,
): ModelRequest {
  return {
    target: {
      provider: "custom-provider-name",
      model,
      instructionProfileId: "default",
      ...(effort === undefined ? {} : { effort }),
    },
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    toolWireProtocol: "eager",
    ...overrides,
  }
}
