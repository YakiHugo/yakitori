import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import { createConfiguredModelsManager } from "../../src/runtime/configured-models-manager.ts"
import {
  type ModelRequest,
  ModelStopReason,
  type ModelStreamEvent,
} from "../../src/runtime/model.ts"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import {
  createToolRegistry,
  plainToolName,
} from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { inputFixture } from "../fixtures/user-input.ts"

const request: ModelRequest = {
  target: {
    provider: "mistral",
    model: "mistral-medium-3-5",
    instructionProfileId: "default",
    effort: "high",
  },
  continuationScope: "account",
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text: "Inspect" }] }],
  tools: [],
  toolWireProtocol: "eager",
  streamOutputItems: true,
}

describe("Mistral structured Chat Completions", () => {
  it.each([
    "mistral",
    "generic",
  ] as const)("streams mixed thinking/text through a %s connection without flattening native continuation", async (flavor) => {
    await withServer(
      () => [
        chunk({ content: "" }),
        chunk({
          content: [
            {
              type: "thinking",
              thinking: [{ type: "text", text: "Inspect " }],
              closed: false,
            },
          ],
        }),
        chunk({
          content: [
            {
              type: "thinking",
              thinking: [
                { type: "text", text: "the repo" },
                { type: "reference", reference_ids: [7, "source"] },
                { type: "tool_reference", tool: "web", title: "Source" },
              ],
              closed: true,
            },
          ],
        }),
        chunk({
          content: [
            { type: "thinking", thinking: [], signature: "signed-trace" },
            { type: "text", text: "I will " },
          ],
        }),
        chunk({ content: "inspect it." }, "stop"),
      ],
      async (baseURL) => {
        const events = await collect(baseURL, request, flavor)
        expect(
          events.filter(
            (event) =>
              event.type === "delta" || event.type === "reasoning_delta",
          ),
        ).toEqual([
          { type: "reasoning_delta", text: "Inspect ", itemId: "mistral_0" },
          { type: "reasoning_delta", text: "the repo", itemId: "mistral_0" },
          { type: "delta", text: "I will ", itemId: "mistral_0" },
          { type: "delta", text: "inspect it.", itemId: "mistral_0" },
        ])
        const native = [
          {
            provider: "mistral",
            model: "mistral-medium-3-5",
            scope: "account",
            wireApi: "openai_chat_completions",
            value: {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: [
                    { type: "text", text: "Inspect " },
                    { type: "text", text: "the repo" },
                    { type: "reference", reference_ids: [7, "source"] },
                    { type: "tool_reference", tool: "web", title: "Source" },
                  ],
                  closed: true,
                  signature: "signed-trace",
                },
                { type: "text", text: "I will inspect it." },
              ],
            },
          },
        ]
        expect(events.at(-1)).toMatchObject({
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [
              { type: "reasoning", text: "Inspect the repo" },
              { type: "text", text: "I will inspect it." },
            ],
            native,
          },
        })
        expect(
          events.find((event) => event.type === "output_item"),
        ).toMatchObject({
          itemId: "mistral_0",
          native,
        })
      },
    )
  })

  it.each([
    [{ type: "text", text: 42 }],
    [{ type: "thinking", thinking: "trace" }],
    [{ type: "thinking", thinking: [{ type: "text", text: 42 }] }],
    [{ type: "thinking", thinking: [], signature: 42 }],
    [{ type: "thinking", thinking: [], closed: "yes" }],
    [{ type: "image_url", image_url: "https://example.com/image.png" }],
  ])("rejects malformed or unsupported structured content %#", async (content) => {
    await withServer(
      () => [chunk({ content: [content] }, "stop")],
      async (baseURL) => {
        const events = await collect(baseURL)
        expect(events).toMatchObject([
          {
            type: "failure",
            failure: { stage: "response_body", kind: "protocol_error" },
          },
        ])
      },
    )
  })

  it.each([
    { finishReason: null, terminal: "failure" },
    { finishReason: "length", terminal: "response" },
  ])("keeps $finishReason stream termination meaningful after structured thinking", async ({
    finishReason,
    terminal,
  }) => {
    await withServer(
      () => [
        chunk(
          {
            content: [
              {
                type: "thinking",
                thinking: [{ type: "text", text: "Partial" }],
              },
            ],
          },
          finishReason,
        ),
      ],
      async (baseURL) => {
        const events = await collect(baseURL)
        expect(events.at(-1)?.type).toBe(terminal)
        if (terminal === "failure") {
          expect(events.at(-1)).toMatchObject({
            failure: { kind: "stream_disconnected" },
          })
          expect(events.some((event) => event.type === "output_item")).toBe(
            false,
          )
        } else {
          expect(events.at(-1)).toMatchObject({
            response: {
              stopReason: ModelStopReason.Length,
              lengthReason: "output",
              native: [{ value: { content: [{ type: "thinking" }] } }],
            },
          })
        }
      },
    )
  })

  it("replays thinking and tool results across successive tool calls and a reopened Session", async () => {
    const bodies: Record<string, unknown>[] = []
    let executions = 0
    await withServer(
      async (incoming) => {
        bodies.push(await requestBody(incoming))
        const round = bodies.length
        if (round <= 2)
          return [
            chunk({
              content: [
                {
                  type: "thinking",
                  thinking: [{ type: "text", text: `Inspect ${round}` }],
                },
              ],
            }),
            chunk({
              content: [
                {
                  type: "thinking",
                  thinking: [],
                  signature: `signature-${round}`,
                },
                { type: "text", text: `Step ${round}.` },
              ],
              tool_calls: [
                {
                  index: 0,
                  id: `inspect0${round}`,
                  type: "function",
                  function: { name: "inspect", arguments: "{ " },
                },
              ],
            }),
            chunk(
              { tool_calls: [{ index: 0, function: { arguments: "}" } }] },
              "tool_calls",
            ),
          ]
        return [
          chunk({ content: round === 3 ? "Done." : "Still done." }, "stop"),
        ]
      },
      async (baseURL) => {
        const root = await mkdtemp(join(tmpdir(), "yakitori-mistral-replay-"))
        const createTools = () =>
          createToolRegistry([
            {
              toolName: plainToolName("inspect"),
              description: "Inspect",
              inputSchema: { type: "object" },
              effect: "observe",
              approvalRequirement: { kind: "none" },
              async execute() {
                executions += 1
                return { ok: true, output: "Inspected", content: "Inspected" }
              },
            },
          ])
        let tools = createTools()
        const registry = createProviderRegistry({
          mistral: createModelProvider({
            info: {
              id: "mistral",
              wireApi: "openai_chat_completions",
              capabilities: { remoteCompaction: false },
            },
            models: createConfiguredModelsManager({
              provider: "mistral",
              wireApi: "openai_chat_completions",
              models: [{ id: "mistral-medium-3-5" }],
            }),
            continuationScope: "account",
            stream: createChatCompletionsProvider({
              apiKey: "test",
              model: "mistral-medium-3-5",
              baseURL,
              flavor: "mistral",
            }),
          }),
        })
        const createManager = () =>
          new ThreadManager({
            store: new JsonlThreadStore({ root }),
            createTurnProcessor: () =>
              createTurnProcessor({
                modelClient: registry.createClient(),
                provider: "mistral",
                model: "mistral-medium-3-5",
                toolRegistry: tools,
                baseInstructions: "Inspect twice",
                loadProjectInstructions: async () => undefined,
              }),
          })
        let manager = createManager()
        try {
          const thread = await manager.createThread({
            workingDirectory: root,
            mateId: "mate_test",
            mateRevisionId: "revision_test",
          })
          await thread.startIfIdle({
            content: inputFixture([{ type: "text", text: "Inspect" }]),
          })
          await expect
            .poll(() => thread.agentStatus)
            .toEqual({ completed: "Done." })
          expect(executions).toBe(2)
          await manager.shutdown()
          tools = createTools()
          manager = createManager()
          const reopened = await manager.resumeThread(thread.id)
          if (reopened === undefined)
            throw new Error("Missing persisted Session")
          await reopened.startIfIdle({
            content: inputFixture([{ type: "text", text: "Continue" }]),
          })
          await expect
            .poll(() => reopened.agentStatus)
            .toEqual({ completed: "Still done." })
          expect(executions).toBe(2)
          for (const [index, expectedRounds] of [
            [1, 1],
            [2, 2],
            [3, 2],
          ] as const) {
            const messages = bodies[index]?.messages
            if (!Array.isArray(messages))
              throw new Error("Missing replay request")
            for (let round = 1; round <= expectedRounds; round += 1) {
              expect(messages).toContainEqual({
                role: "assistant",
                content: [
                  {
                    type: "thinking",
                    thinking: [{ type: "text", text: `Inspect ${round}` }],
                    signature: `signature-${round}`,
                  },
                  { type: "text", text: `Step ${round}.` },
                ],
                tool_calls: [
                  {
                    id: `inspect0${round}`,
                    type: "function",
                    function: { name: "inspect", arguments: "{ }" },
                  },
                ],
              })
              expect(messages).toContainEqual({
                role: "tool",
                tool_call_id: `inspect0${round}`,
                content: "Inspected",
              })
            }
          }
        } finally {
          await manager.shutdown()
          await tools.dispose()
          await rm(root, { recursive: true, force: true })
        }
      },
    )
  })
})

function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
) {
  return {
    id: "mistral",
    object: "chat.completion.chunk",
    created: 1,
    model: "mistral-medium-3-5",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

async function collect(
  baseURL: string,
  input: ModelRequest = request,
  flavor: "mistral" | "generic" = "mistral",
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = []
  const stream = createChatCompletionsProvider({
    apiKey: "test",
    model: "mistral-medium-3-5",
    baseURL,
    flavor,
  })
  for await (const event of stream(input)) events.push(event)
  return events
}

async function requestBody(
  incoming: IncomingMessage,
): Promise<Record<string, unknown>> {
  const pieces: Buffer[] = []
  for await (const piece of incoming) pieces.push(Buffer.from(piece))
  return JSON.parse(Buffer.concat(pieces).toString("utf8"))
}

async function withServer(
  respond: (incoming: IncomingMessage) => unknown[] | Promise<unknown[]>,
  run: (baseURL: string) => Promise<void>,
) {
  const failures: unknown[] = []
  const server = createServer((incoming, outgoing) => {
    Promise.resolve(respond(incoming))
      .then((chunks) => {
        outgoing.writeHead(200, { "content-type": "text/event-stream" })
        outgoing.end(
          `${chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`,
        )
      })
      .catch((error: unknown) => {
        failures.push(error)
        outgoing.destroy()
      })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new Error("Missing HTTP address")
  try {
    await run(`http://127.0.0.1:${address.port}/v1`)
    if (failures.length > 0) throw failures[0]
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    )
  }
}
