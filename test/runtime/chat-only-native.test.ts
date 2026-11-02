import { mergeEffectiveModel } from "../../src/runtime/effective-model.ts"
import { expect, it } from "vitest"
import { toChatCompletionsMessages } from "../../src/runtime/chat-completions-provider.ts"
import { isPortableChatOnlyNative } from "../../src/runtime/chat-only-native.ts"
import type { ModelNativeItem } from "../../src/runtime/model.ts"
import { resolveFallbackModel } from "../../src/runtime/model-catalog.ts"
import { prepareModelRequestPlan } from "../../src/runtime/model-request-plan.ts"

const answer = "A chart of monthly revenue."
const content = [{ type: "text" as const, text: "A chart of monthly revenue." }]
const native: ModelNativeItem = {
  provider: "account",
  model: "vision",
  scope: "owner",
  wireApi: "openai_chat_completions",
  value: { role: "assistant", content: answer },
}

it("admits exactly equivalent text-native history without changing its envelope", () => {
  const message = { role: "assistant" as const, content, native: [native] }
  const before = structuredClone(message)
  const model = {
    ...resolveFallbackModel({ provider: "account", model: "vision" }),
    toolPolicy: "chat_only" as const,
  }
  const planned = prepareModelRequestPlan(
    {
      target: model,
      messages: [message],
      system: [],
      tools: [],
      toolWireProtocol: "eager",
    },
    { model, wireApi: "openai_chat_completions" },
  )
  expect(
    toChatCompletionsMessages(
      planned.request.messages,
      "account",
      "owner",
      "generic",
      "vision",
    ),
  ).toEqual([{ role: "assistant", content: answer }])
  expect(message).toEqual(before)
  expect(planned.request.messages).toEqual([before])
})

it.each([
  { role: "assistant", content: "different text" },
  { role: "system", content: answer },
  { role: "assistant", content: answer, tool_calls: [] },
  { role: "assistant", content: answer, function_call: {} },
  { role: "assistant", content: answer, reasoning_content: "opaque" },
  { role: "assistant", content: answer, annotations: [] },
  { role: "assistant", content: [{ type: "text", text: answer }] },
  { role: "assistant", content: null },
])("rejects non-equivalent or extended native state: %j", (value) => {
  expect(isPortableChatOnlyNative(content, [{ ...native, value }])).toBe(false)
})

it("rejects other protocols, multiple envelopes and non-text portable blocks", () => {
  expect(
    isPortableChatOnlyNative(content, [
      { ...native, wireApi: "openai_responses" },
    ]),
  ).toBe(false)
  expect(isPortableChatOnlyNative(content, [native, native])).toBe(false)
  expect(
    isPortableChatOnlyNative(
      [{ type: "tool_call", id: "call", name: "mutate", input: {} }],
      [native],
    ),
  ).toBe(false)
})

it("does not admit inherited text beside an own native tool payload", () => {
  const value = { role: "assistant", tool_calls: [{ id: "hidden" }] }
  Object.setPrototypeOf(value, { content: answer })
  expect(isPortableChatOnlyNative(content, [{ ...native, value }])).toBe(false)
})

it("keeps a chat-only instruction profile when no explicit instructions exist", () => {
  const base = {
    ...resolveFallbackModel({ provider: "account", model: "vision" }),
    instructionProfileId: "default" as const,
    toolPolicy: "chat_only" as const,
  }
  const configured = mergeEffectiveModel(base, {
    instructionProfileId: "kimi-code",
  })
  expect(configured.instructionProfileId).toBe("default")
})
