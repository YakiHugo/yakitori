import { expect, it } from "vitest"
import { createConfiguredModelsManager } from "../../src/runtime/configured-models-manager.ts"
import { discoveredModelKind } from "../../src/runtime/model-kind.ts"

it.each([
  ["whisper-1", "other"],
  ["tts-1-hd", "other"],
  ["text-embedding-3-large", "other"],
  ["omni-moderation-latest", "other"],
  ["gpt-4o-mini-tts-2025-03-20", "other"],
  ["gpt-4o-transcribe-diarize", "other"],
  ["gpt-realtime-mini-2025-12-15", "other"],
  ["gpt-4o-realtime-preview", "other"],
  ["gpt-realtime-whisper", "other"],
  ["gpt-image-1-mini", "image"],
  ["chatgpt-image-latest", "image"],
  ["dall-e-3", "image"],
  ["sora-2-pro", "video"],
  ["babbage-002", "other"],
])("classifies native %s without hiding same-named custom models", (id, kind) => {
  expect(discoveredModelKind({ id }, "openai", "openai_responses")).toBe(kind)
  expect(discoveredModelKind({ id })).toBeUndefined()
})

it("does not confuse image input or unknown chat IDs with generation models", () => {
  for (const id of ["gpt-99", "gpt-vision-custom", "my-image-helper"]) {
    expect(
      discoveredModelKind({ id }, "openai", "openai_responses"),
    ).toBeUndefined()
  }
  expect(
    discoveredModelKind({
      id: "custom",
      kind: "chat",
      input_modalities: ["text", "image"],
    }),
  ).toBe("chat")
})

it("keeps audio chat on Chat Completions but excludes it from Responses", () => {
  for (const id of ["gpt-audio-1.5", "gpt-4o-audio-preview"]) {
    expect(
      discoveredModelKind({ id }, "openai", "openai_chat_completions"),
    ).toBeUndefined()
    expect(discoveredModelKind({ id }, "openai", "openai_responses")).toBe(
      "other",
    )
  }
})

it("prevents manual visibility from making native non-chat models executable", async () => {
  const manager = createConfiguredModelsManager({
    provider: "personal",
    serviceId: "openai",
    catalogProvider: "openai",
    wireApi: "openai_responses",
    models: [
      { id: "whisper-1", visible: true, kind: "chat" },
      { id: "gpt-99", visible: false },
      { id: "my-custom-model", visible: true },
    ],
  })
  expect(
    (await manager.listModels({ includeHidden: true })).map(
      (model) => model.model,
    ),
  ).toEqual(["gpt-99", "my-custom-model"])
  expect((await manager.listModels()).map((model) => model.model)).toEqual([
    "my-custom-model",
  ])
  expect(() =>
    manager.resolve({ provider: "personal", model: "whisper-1" }),
  ).toThrow("not a chat model")
  expect(manager.resolve({ provider: "personal", model: "gpt-99" }).model).toBe(
    "gpt-99",
  )
})

it("keeps native xAI image models non-chat for service and catalog identities", async () => {
  for (const serviceId of ["xai", "grok"]) {
    const manager = createConfiguredModelsManager({
      provider: "work",
      serviceId,
      wireApi: "openai_responses",
      models: [{ id: "grok-imagine-image", kind: "chat", visible: true }],
    })
    expect(await manager.listModels({ includeHidden: true })).toEqual([])
    expect(() =>
      manager.resolve({ provider: "work", model: "grok-imagine-image" }),
    ).toThrow("not a chat model")
  }
})
