import { afterEach, expect, it, vi } from "vitest"
import type { ModelMessage, ModelRequest } from "../../src/runtime/model.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { jpegImageBase64, pngImageBase64 } from "../fixtures/images.ts"

afterEach(() => vi.unstubAllGlobals())

const png = {
  type: "image",
  mediaType: "image/png",
  data: pngImageBase64,
} as const
const jpeg = {
  type: "image",
  mediaType: "image/jpeg",
  data: jpegImageBase64,
} as const
const messages: ModelMessage[] = [
  { role: "user", content: [png] },
  {
    role: "assistant",
    content: [
      { type: "tool_call", id: "a", name: "first", input: {} },
      { type: "tool_call", id: "b", name: "second", input: {} },
    ],
  },
  {
    role: "tool",
    toolCallId: "a",
    content: [
      { type: "text", text: "before" },
      png,
      { type: "text", text: "between" },
      jpeg,
    ],
  },
  { role: "tool", toolCallId: "b", isError: true, content: [jpeg] },
]

async function run(model: string, history = messages) {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      expect(String(url)).toBe(
        "https://generativelanguage.googleapis.com/v1beta/interactions",
      )
      bodies.push(JSON.parse(String(init?.body)))
      const events = [
        {
          event_type: "interaction.created",
          interaction: { id: "interaction", status: "in_progress" },
        },
        {
          event_type: "interaction.completed",
          interaction: { id: "interaction", status: "completed" },
        },
      ]
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        {
          headers: { "content-type": "text/event-stream" },
        },
      )
    }),
  )
  const registry = createProviderRegistry({
    personal: createConfiguredProvider(
      "personal",
      {
        name: "Personal",
        service: "gemini",
        wireApi: "gemini_interactions",
        baseURL: "https://generativelanguage.googleapis.com/v1beta",
        models: [
          {
            id: model,
            // An explicit capability choice may allow an unknown vision model, but
            // never grants Gemini 3's native multimodal function-result contract.
            ...(model === "gemini-3-future"
              ? { inputModalities: ["text", "image"] as const }
              : {}),
          },
        ],
      },
      "test",
    ),
  })
  const request: ModelRequest = {
    target: { provider: "personal", model, instructionProfileId: "default" },
    system: [],
    messages: history,
    tools: [],
    toolWireProtocol: "eager",
  }
  try {
    return { bodies, events: await Array.fromAsync(registry.stream(request)) }
  } finally {
    await registry.close()
  }
}

it.each([
  ["gemini-3.8-flash", true],
  ["gemini-3.1-pro-preview-customtools", true],
  ["gemini-2.5-pro", false],
  ["gemini-2.5-flash", false],
  ["gemini-2.5-flash-lite", false],
  ["gemma-4-31b-it", false],
  ["gemma-4-26b-a4b-it", false],
  ["gemini-3-future", false],
] as const)("sends %s Interactions tool images in the documented schema after a complete parallel batch", async (model, nested) => {
  const before = structuredClone(messages)
  const { bodies, events } = await run(model)
  expect(events.at(-1)?.type).toBe("response")
  expect(bodies).toHaveLength(1)
  const input = bodies[0]?.input
  expect(input).toEqual([
    {
      type: "user_input",
      content: [
        { type: "image", mime_type: "image/png", data: pngImageBase64 },
      ],
    },
    { type: "function_call", id: "a", name: "first", arguments: {} },
    { type: "function_call", id: "b", name: "second", arguments: {} },
    {
      type: "function_result",
      call_id: "a",
      name: "first",
      result: [
        { type: "text", text: "before" },
        nested
          ? { type: "image", mime_type: "image/png", data: pngImageBase64 }
          : {
              type: "text",
              text: "[Image from tool first, call a, content part 2; image follows the function-result batch.]",
            },
        { type: "text", text: "between" },
        nested
          ? { type: "image", mime_type: "image/jpeg", data: jpegImageBase64 }
          : {
              type: "text",
              text: "[Image from tool first, call a, content part 4; image follows the function-result batch.]",
            },
      ],
    },
    {
      type: "function_result",
      call_id: "b",
      name: "second",
      is_error: true,
      result: [
        nested
          ? { type: "image", mime_type: "image/jpeg", data: jpegImageBase64 }
          : {
              type: "text",
              text: "[Image from tool second, call b, content part 1; image follows the function-result batch.]",
            },
      ],
    },
    ...(nested
      ? []
      : [
          {
            type: "user_input",
            content: [
              {
                type: "text",
                text: "[Image from tool first, call a, content part 2]",
              },
              { type: "image", mime_type: "image/png", data: pngImageBase64 },
              {
                type: "text",
                text: "[Image from tool first, call a, content part 4]",
              },
              { type: "image", mime_type: "image/jpeg", data: jpegImageBase64 },
              {
                type: "text",
                text: "[Image from tool second, call b, content part 1]",
              },
              { type: "image", mime_type: "image/jpeg", data: jpegImageBase64 },
            ],
          },
        ]),
  ])
  expect(messages).toEqual(before)
})

it.each([
  false,
  true,
])("rejects incomplete tool-image batches instead of losing images or reordering later user input (interrupted=%s)", async (interrupted) => {
  const history: ModelMessage[] = [
    ...messages.slice(0, 3),
    ...(interrupted
      ? [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: "Next task" }],
          },
        ]
      : []),
  ]
  const { bodies, events } = await run("gemma-4-31b-it", history)
  expect(bodies).toEqual([])
  expect(events.at(-1)).toMatchObject({
    type: "failure",
    failure: {
      kind: "invalid_request",
      stage: "request_build",
      message:
        "Interactions tool images require the complete function-result batch.",
    },
  })
})
