import { describe, expect, it } from "vitest"
import type { JsonObject } from "../../src/kernel/index.ts"
import { toGeminiInteractionInput } from "../../src/runtime/gemini-interactions-input.ts"
import { createGeminiInteractionOutput } from "../../src/runtime/gemini-interactions-output.ts"
import {
  type ModelRequest,
  type ModelResponse,
  ModelStopReason,
} from "../../src/runtime/model.ts"

const request: ModelRequest = {
  target: {
    provider: "gemini",
    model: "gemini-3.8-flash",
    instructionProfileId: "default",
  },
  continuationScope: "account",
  system: [],
  messages: [],
  tools: [],
  toolWireProtocol: "eager",
}

// Current step.* schema and incremental semantics, fetched 2026-10-26:
// https://ai.google.dev/static/api/interactions.openapi.json
// https://ai.google.dev/gemini-api/docs/streaming
describe("Interactions hosted step continuation", () => {
  it("replays complete hosted code and results assembled from multiple deltas", () => {
    const response = finishSteps([
      {
        start: {
          type: "code_execution_call",
          id: "code-1",
          arguments: {},
          signature: "",
          provider_extension: { retained: true },
        },
        deltas: [
          {
            type: "code_execution_call",
            arguments: { language: "python", code: "print(" },
          },
          {
            type: "code_execution_call",
            arguments: { language: "python", code: "42)" },
            signature: "Y29kZS1zaWduYXR1cmU=",
          },
        ],
      },
      {
        start: {
          type: "code_execution_result",
          call_id: "code-1",
          result: "",
          signature: "",
        },
        deltas: [
          { type: "code_execution_result", result: "4" },
          {
            type: "code_execution_result",
            result: "2\n",
            is_error: false,
            signature: "cmVzdWx0LXNpZ25hdHVyZQ==",
          },
        ],
      },
    ])
    expectNativeReplay(response, [
      {
        type: "code_execution_call",
        id: "code-1",
        arguments: { language: "python", code: "print(42)" },
        signature: "Y29kZS1zaWduYXR1cmU=",
        provider_extension: { retained: true },
      },
      {
        type: "code_execution_result",
        call_id: "code-1",
        result: "42\n",
        signature: "cmVzdWx0LXNpZ25hdHVyZQ==",
        is_error: false,
      },
    ])
  })

  it("retains repeated MCP identities and opaque JSON when replaying hosted calls", () => {
    const identity = { name: "lookup", server_name: "knowledge" }
    const response = finishSteps([
      {
        start: {
          type: "mcp_server_tool_call",
          id: "mcp-1",
          ...identity,
          arguments: {},
        },
        deltas: [
          {
            type: "mcp_server_tool_call",
            ...identity,
            arguments: { query: "first", filter: { category: "docs" } },
          },
          {
            type: "mcp_server_tool_call",
            ...identity,
            arguments: { query: "final", limit: 2 },
          },
        ],
      },
      {
        start: {
          type: "mcp_server_tool_result",
          call_id: "mcp-1",
          ...identity,
          result: [],
        },
        deltas: [
          {
            type: "mcp_server_tool_result",
            ...identity,
            result: [{ type: "text", text: "First result." }],
          },
          {
            type: "mcp_server_tool_result",
            ...identity,
            result: [{ type: "text", text: "Second result." }],
          },
        ],
      },
    ])
    expectNativeReplay(response, [
      {
        type: "mcp_server_tool_call",
        id: "mcp-1",
        name: "lookup",
        server_name: "knowledge",
        arguments: { query: "final", filter: { category: "docs" }, limit: 2 },
      },
      {
        type: "mcp_server_tool_result",
        call_id: "mcp-1",
        name: "lookup",
        server_name: "knowledge",
        result: [
          { type: "text", text: "First result." },
          { type: "text", text: "Second result." },
        ],
      },
    ])
  })

  it.each([
    ["google_search_call", "queries"],
    ["google_maps_call", "queries"],
    ["url_context_call", "urls"],
  ])("retains successive %s retrieval arguments", (type, key) => {
    const response = finishSteps([
      {
        start: { type, id: "retrieval-1", arguments: {} },
        deltas: [
          { type, arguments: { [key]: ["first"] } },
          { type, arguments: { [key]: ["second"] } },
        ],
      },
    ])
    expectNativeReplay(response, [
      {
        type,
        id: "retrieval-1",
        arguments: { [key]: ["first", "second"] },
      },
    ])
  })

  it.each([
    "name",
    "server_name",
  ])("rejects a hosted MCP %s change within one step", (key) => {
    expect(() =>
      finishSteps([
        {
          start: {
            type: "mcp_server_tool_call",
            id: "mcp-1",
            name: "lookup",
            server_name: "knowledge",
            arguments: {},
          },
          deltas: [
            {
              type: "mcp_server_tool_call",
              name: "lookup",
              server_name: "knowledge",
              [key]: "changed",
              arguments: {},
            },
          ],
        },
      ]),
    ).toThrow("Hosted tool identity changed.")
  })
})

function finishSteps(
  steps: { start: JsonObject; deltas: JsonObject[] }[],
): ModelResponse {
  const output = createGeminiInteractionOutput(request, "item")
  output.accept({
    event_type: "interaction.created",
    interaction: { id: "interaction", status: "in_progress" },
  })
  for (const [index, step] of steps.entries()) {
    output.accept({ event_type: "step.start", index, step: step.start })
    for (const delta of step.deltas)
      output.accept({ event_type: "step.delta", index, delta })
    output.accept({ event_type: "step.stop", index })
  }
  output.accept({
    event_type: "interaction.completed",
    interaction: { id: "interaction", status: "completed" },
  })
  return output.finish()
}

function expectNativeReplay(response: ModelResponse, expected: JsonObject[]) {
  expect(response.stopReason).toBe(ModelStopReason.EndTurn)
  expect(response.content).toEqual([])
  expect(response.native?.map((item) => item.value)).toEqual(expected)
  expect(
    toGeminiInteractionInput(
      [
        {
          role: "assistant",
          content: response.content,
          ...(response.native === undefined ? {} : { native: response.native }),
        },
      ],
      request.target.provider,
      request.continuationScope,
      request.target.model,
    ),
  ).toEqual(expected)
}
