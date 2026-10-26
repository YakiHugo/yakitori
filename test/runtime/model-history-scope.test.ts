import { describe, expect, it } from "vitest"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import { createGeminiInteractionsProvider } from "../../src/runtime/gemini-interactions-provider.ts"
import { createGeminiProvider } from "../../src/runtime/gemini-provider.ts"
import type { ModelRequest, ModelWireApi } from "../../src/runtime/model.ts"
import { validateModelHistoryScope } from "../../src/runtime/model-native.ts"
import { createOpenAIProvider } from "../../src/runtime/openai-provider.ts"
import { createAnthropicTestStream } from "./anthropic-test-stream.ts"

const request: ModelRequest = {
  target: {
    provider: "account",
    model: "example",
    instructionProfileId: "generic",
  },
  continuationScope: "owner",
  messages: [
    {
      role: "assistant",
      content: [
        {
          type: "compaction",
          provider: "account",
          model: "example",
          scope: "owner",
          encryptedContent: "checkpoint",
        },
      ],
    },
  ],
  system: [],
  tools: [],
  toolWireProtocol: "eager",
}

describe("opaque history admission", () => {
  it.each([
    "openai_responses",
    "openai_chat_completions",
    "anthropic_messages",
    "gemini_generate_content",
    "gemini_interactions",
  ] as const)("returns a request-build diagnostic before %s sends incompatible opaque history", async (wireApi) => {
    const options = {
      apiKey: "test",
      model: "example",
      baseURL: "http://127.0.0.1:1",
    }
    const stream =
      wireApi === "openai_responses"
        ? createOpenAIProvider(options)
        : wireApi === "openai_chat_completions"
          ? createChatCompletionsProvider(options)
          : wireApi === "anthropic_messages"
            ? createAnthropicTestStream(options)
            : wireApi === "gemini_interactions"
              ? createGeminiInteractionsProvider(options)
              : createGeminiProvider(options)
    const events = []
    for await (const event of stream({
      ...request,
      continuationScope: "other",
    }))
      events.push(event)
    expect(events).toMatchObject([
      {
        type: "failure",
        failure: {
          wireApi,
          stage: "request_build",
          kind: "invalid_request",
          providerCode: "history_incompatible",
        },
      },
    ])
  })
  it("retains a checkpoint only for the same provider, model, API and credential owner", () => {
    expect(() =>
      validateModelHistoryScope(request, "openai_responses"),
    ).not.toThrow()
    expect(request.messages[0]).toMatchObject({
      content: [{ encryptedContent: "checkpoint" }],
    })
  })

  it.each<Readonly<{ request: ModelRequest; wireApi: ModelWireApi }>>([
    {
      request: { ...request, target: { ...request.target, provider: "other" } },
      wireApi: "openai_responses",
    },
    {
      request: { ...request, target: { ...request.target, model: "other" } },
      wireApi: "openai_responses",
    },
    {
      request: { ...request, continuationScope: "other" },
      wireApi: "openai_responses",
    },
    { request, wireApi: "openai_chat_completions" },
  ])("rejects an incompatible checkpoint without silently discarding history", (input) => {
    expect(() =>
      validateModelHistoryScope(input.request, input.wireApi),
    ).toThrowError(expect.objectContaining({ code: "history_incompatible" }))
  })

  it("also fences native checkpoints without a display projection", () => {
    const native: ModelRequest = {
      ...request,
      messages: [
        {
          role: "assistant",
          content: [],
          native: [
            {
              provider: "account",
              model: "example",
              scope: "owner",
              wireApi: "openai_responses",
              value: { type: "compaction", encrypted_content: "checkpoint" },
            },
          ],
        },
      ],
    }
    expect(() =>
      validateModelHistoryScope(native, "openai_responses"),
    ).not.toThrow()
    expect(() =>
      validateModelHistoryScope(
        { ...native, continuationScope: "other" },
        "openai_responses",
      ),
    ).toThrowError(expect.objectContaining({ code: "history_incompatible" }))
  })

  it("allows ordinary native output to use the existing portable text and tool projection", () => {
    const portable: ModelRequest = {
      ...request,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Previous answer" }],
          native: [
            {
              provider: "other",
              model: "other",
              scope: "other",
              wireApi: "anthropic_messages",
              value: {
                type: "thinking",
                thinking: "Thought",
                signature: "signed",
              },
            },
          ],
        },
      ],
    }
    expect(() =>
      validateModelHistoryScope(portable, "openai_responses"),
    ).not.toThrow()
  })
})
