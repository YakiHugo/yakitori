import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { toAnthropicMessages } from "../../src/runtime/anthropic-provider.ts"
import { toChatCompletionsMessages } from "../../src/runtime/chat-completions-provider.ts"
import { toGeminiContents } from "../../src/runtime/gemini-provider.ts"
import {
  type ModelMessage,
  ModelStopReason,
  type StreamFn,
} from "../../src/runtime/model.ts"
import { toOpenAIInput } from "../../src/runtime/openai-provider.ts"
import {
  createToolRegistry,
  plainToolName,
} from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { inputFixture } from "../fixtures/user-input.ts"
import { waitForValue } from "../support/wait-for-value.ts"

const isolatedHome = vi.hoisted(() => ({ path: "" }))
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => isolatedHome.path,
}))

it("replays one parallel call batch after streamed results interleave and the Session reopens", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-response-history-"))
  isolatedHome.path = root
  let samples = 0
  let hasResult = (_id: string) => false
  const first = {
    type: "tool_call" as const,
    id: "call_a",
    name: "inspect",
    input: {},
  }
  const second = { ...first, id: "call_b" }
  const stream: StreamFn = async function* () {
    samples += 1
    if (samples === 1) {
      yield { type: "output_item", itemId: "output_a", content: [first] }
      await waitForValue(() => (hasResult("call_a") ? true : undefined))
      yield { type: "output_item", itemId: "output_b", content: [second] }
      await waitForValue(() => (hasResult("call_b") ? true : undefined))
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.ToolUse,
          rawStopReason: "tool_use",
          providerResponseId: "response_one",
          providerRequestId: "request_one",
          content: [first, second],
          usage: { inputTokens: 7 },
        },
      }
    } else
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "Done" }],
        },
      }
  }
  const store = new JsonlThreadStore({ root })
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () =>
      createTurnProcessor({
        stream,
        loadProjectInstructions: async () => undefined,
        toolRegistry: createToolRegistry([
          {
            toolName: plainToolName("inspect"),
            description: "Inspect",
            inputSchema: { type: "object" },
            effect: "observe",
            approvalRequirement: { kind: "none" },
            async execute() {
              return { ok: true, output: "ok", content: "ok" }
            },
          },
        ]),
      }),
  })
  try {
    const thread = await manager.createThread({
      workingDirectory: root,
      mateId: "mate_test",
      mateRevisionId: "revision_test",
    })
    hasResult = (id) =>
      thread
        .snapshot()
        .context.history.some(
          ({ item }) => item.role === "tool" && item.toolCallId === id,
        )
    await thread.startIfIdle({
      content: inputFixture([{ type: "text", text: "Work" }]),
    })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "Done" })
    await manager.shutdown()
    const reopened = new JsonlThreadStore({ root })
    const restored = await reopened.resumeThread(thread.id)
    expect(restored).toBeDefined()
    const messages: ModelMessage[] =
      restored?.rollout.flatMap(({ item }) =>
        item.type === "response_item" &&
        (item.item.item.role === "tool" || item.item.item.role === "assistant")
          ? [item.item.item]
          : [],
      ) ?? []
    expect(messages.slice(0, 4).map((item) => item.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
      "tool",
    ])
    const attempt = restored?.rollout.find(
      ({ item }) => item.type === "model_attempt",
    )?.item
    expect(attempt).toMatchObject({
      type: "model_attempt",
      attempt: {
        outcome: "completed",
        providerResponseId: "response_one",
        providerRequestId: "request_one",
        rawStopReason: "tool_use",
        usage: { inputTokens: 7 },
      },
    })
    const origins = messages.flatMap((message) =>
      message.role === "assistant" &&
      message.content.some((block) => block.type === "tool_call")
        ? [message.response]
        : [],
    )
    expect(origins).toHaveLength(2)
    expect(origins[0]).toEqual(origins[1])
    expect(
      toChatCompletionsMessages(messages, "faux").slice(0, 3),
    ).toMatchObject([
      { role: "assistant", tool_calls: [{ id: "call_a" }, { id: "call_b" }] },
      { role: "tool", tool_call_id: "call_a" },
      { role: "tool", tool_call_id: "call_b" },
    ])
    expect(toAnthropicMessages(messages).slice(0, 2)).toMatchObject([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_a" },
          { type: "tool_use", id: "call_b" },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_a" },
          { type: "tool_result", tool_use_id: "call_b" },
        ],
      },
    ])
    expect(
      toGeminiContents(messages, "faux", "owner", "gemini-3-pro").slice(0, 2),
    ).toMatchObject([
      {
        role: "model",
        parts: [
          { functionCall: { name: "inspect" } },
          { functionCall: { name: "inspect" } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "inspect" } },
          { functionResponse: { name: "inspect" } },
        ],
      },
    ])
    expect(
      toOpenAIInput(messages)
        .slice(0, 4)
        .map((item) => item.type),
    ).toEqual([
      "function_call",
      "function_call_output",
      "function_call",
      "function_call_output",
    ])
    await reopened.shutdownThread(thread.id)
  } finally {
    await manager.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})
