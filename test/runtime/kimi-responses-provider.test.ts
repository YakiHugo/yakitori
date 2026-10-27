import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { describe, expect, it } from "vitest"
import { isJsonObject, type JsonObject } from "../../src/kernel/index.ts"
import type {
  ModelMessage,
  ModelRequest,
  ModelStreamEvent,
} from "../../src/runtime/model.ts"
import { createOpenAIProvider } from "../../src/runtime/openai-provider.ts"
import { persistModelMessages } from "../support/persist-model-messages.ts"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWP4z8BAEmIY1cAwGkr/h2vSAACQ+f8BxdOlvwAAAABJRU5ErkJggg==",
  "base64",
)

const reasoning: JsonObject = {
  type: "reasoning",
  id: "rs_kimi",
  summary: [{ type: "summary_text", text: "Inspect the screenshot." }],
  encrypted_content: null,
  status: "completed",
}
const call: JsonObject = {
  type: "function_call",
  id: "fc_kimi",
  call_id: "call_kimi",
  name: "view_image",
  arguments: '{"path":"screen.png"}',
  status: "completed",
}

describe("Kimi Responses profile", () => {
  it("persists summary reasoning and completed calls and replays inline tool images in place", async () => {
    const bodies: JsonObject[] = []
    await withServer(
      async (incoming, outgoing) => {
        if (incoming.url === "/image.png") {
          outgoing.writeHead(200, { "content-type": "image/png" })
          outgoing.end(png)
          return
        }
        expect(incoming.url).toBe("/v1/responses")
        bodies.push(await requestBody(incoming))
        send(
          outgoing,
          bodies.length === 1
            ? [
                {
                  type: "response.created",
                  response: response([], {
                    status: "in_progress",
                    usage: null,
                  }),
                },
                outputItem("added", 0, {
                  ...reasoning,
                  summary: [],
                  status: "in_progress",
                }),
                reasoningDelta("Inspect the "),
                reasoningDelta("screenshot."),
                outputItem("done", 0, reasoning),
                outputItem("added", 1, {
                  ...call,
                  arguments: "",
                  status: "in_progress",
                }),
                {
                  type: "response.function_call_arguments.delta",
                  item_id: "fc_kimi",
                  output_index: 1,
                  delta: '{"path":"screen.png"}',
                },
                outputItem("done", 1, call),
                completed([reasoning, call]),
              ]
            : [completed([message('{"answer":"done"}')])],
        )
      },
      async (baseURL) => {
        const imageURL = `${baseURL.replace(/\/v1$/, "")}/image.png`
        const initial: ModelMessage[] = [
          {
            role: "user",
            content: [
              { type: "text", text: "Inspect this image" },
              {
                type: "image",
                mediaType: "image/png",
                file: { url: imageURL },
                sizeBytes: png.length,
              },
            ],
          },
          {
            role: "developer",
            content: [{ type: "text", text: "Do not change files" }],
          },
        ]
        const stream = provider(baseURL)
        const events = await collect(
          stream(
            request({
              messages: initial,
              streamOutputItems: true,
              toolChoice: "auto",
            }),
          ),
        )
        expect(
          events.filter((event) => event.type === "reasoning_delta"),
        ).toMatchObject([
          {
            text: "Inspect the ",
            representation: "summary",
            itemId: "rs_kimi",
          },
          { text: "screenshot.", representation: "summary", itemId: "rs_kimi" },
        ])
        const items = events.filter((event) => event.type === "output_item")
        expect(items.map((item) => item.itemId)).toEqual(["rs_kimi", "fc_kimi"])
        expect(terminal(events)).toMatchObject({
          stopReason: "tool_use",
          content: [
            {
              type: "reasoning",
              text: "Inspect the screenshot.",
              representation: "summary",
            },
            {
              type: "tool_call",
              id: "call_kimi",
              name: "view_image",
              input: { path: "screen.png" },
            },
          ],
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            activeContextTokens: 120,
            cacheReadInputTokens: 30,
            cacheWriteInputTokens: 40,
          },
          providerRequestId: "kimi_http_request",
        })
        const history = await persistModelMessages([
          ...initial,
          ...items.map(
            (item): ModelMessage => ({
              role: "assistant",
              content: item.content,
              ...(item.native === undefined ? {} : { native: item.native }),
            }),
          ),
          {
            role: "tool",
            toolCallId: "call_kimi",
            content: [
              { type: "text", text: "Screenshot follows" },
              {
                type: "image",
                mediaType: "image/png",
                file: { url: imageURL },
                sizeBytes: png.length,
              },
            ],
          },
        ])
        const schema = {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        }
        const result = terminal(
          await collect(
            stream(
              request({
                messages: history,
                maxOutputTokens: 512,
                outputFormat: { type: "json_schema", name: "answer", schema },
                providerOptions: {
                  provider: "moonshot",
                  wireApi: "openai_responses",
                  body: {
                    prompt_cache_options: { mode: "implicit", ttl: "1h" },
                  },
                },
              }),
            ),
          ),
        )
        expect(result.content).toMatchObject([
          { type: "text", text: '{"answer":"done"}' },
        ])
        expect(bodies[0]).toMatchObject({
          reasoning: { effort: "high" },
          tool_choice: "auto",
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "Inspect this image" },
                {
                  type: "input_image",
                  image_url: `data:image/png;base64,${png.toString("base64")}`,
                },
              ],
            },
            { role: "developer", content: "Do not change files" },
          ],
        })
        expect(bodies[1]).toMatchObject({
          max_output_tokens: 512,
          prompt_cache_key: "thread_kimi",
          prompt_cache_options: { mode: "implicit", ttl: "1h" },
          text: {
            format: {
              type: "json_schema",
              name: "answer",
              schema,
              strict: true,
            },
          },
        })
        const input = bodies[1]?.input
        if (!Array.isArray(input)) throw new Error("Missing replay input")
        expect(input.slice(2)).toEqual([
          {
            type: "reasoning",
            id: "rs_kimi",
            summary: [
              { type: "summary_text", text: "Inspect the screenshot." },
            ],
            status: "completed",
          },
          call,
          {
            type: "function_call_output",
            call_id: "call_kimi",
            output: [
              { type: "input_text", text: "Screenshot follows" },
              {
                type: "input_image",
                detail: "high",
                image_url: `data:image/png;base64,${png.toString("base64")}`,
              },
            ],
          },
        ])
        for (const body of bodies) {
          expect(body).not.toHaveProperty("parallel_tool_calls")
          expect(body).not.toHaveProperty("store")
          expect(body).not.toHaveProperty("service_tier")
          expect(body).not.toHaveProperty("include")
          expect(body.reasoning).toEqual({ effort: "high" })
        }
      },
    )
  })

  it("keeps incomplete function arguments out of executable and replayed output after output exhaustion", async () => {
    const partial = { ...call, arguments: '{"path":', status: "in_progress" }
    const bodies: JsonObject[] = []
    await withServer(
      async (incoming, outgoing) => {
        bodies.push(await requestBody(incoming))
        if (bodies.length > 1) {
          send(outgoing, [completed([message("Continued safely")])])
          return
        }
        send(outgoing, [
          outputItem("added", 0, {
            ...reasoning,
            summary: [],
            status: "in_progress",
          }),
          reasoningDelta("Partial thought"),
          outputItem("added", 1, partial),
          {
            type: "response.incomplete",
            response: response([partial], {
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
            }),
          },
        ])
      },
      async (baseURL) => {
        const stream = provider(baseURL)
        const initial = request()
        const result = terminal(await collect(stream(initial)))
        expect(result).toMatchObject({
          stopReason: "length",
          lengthReason: "output",
          incompleteToolCalls: true,
          content: [{ type: "reasoning", text: "Partial thought" }],
        })
        expect(result.content.some((block) => block.type === "tool_call")).toBe(
          false,
        )
        const history = await persistModelMessages([
          ...initial.messages,
          {
            role: "assistant",
            content: result.content,
            ...(result.native === undefined ? {} : { native: result.native }),
          },
        ])
        const next = terminal(
          await collect(
            stream(
              request({
                messages: [
                  ...history,
                  {
                    role: "user",
                    content: [{ type: "text", text: "Continue" }],
                  },
                ],
              }),
            ),
          ),
        )
        expect(next.content).toMatchObject([
          { type: "text", text: "Continued safely" },
        ])
        const replay = bodies[1]?.input
        if (!Array.isArray(replay)) throw new Error("Missing replay input")
        expect(
          replay.filter(
            (item) => isJsonObject(item) && item.type === "function_call",
          ),
        ).toEqual([])
        expect(replay).toContainEqual(
          expect.objectContaining({
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Partial thought" }],
          }),
        )
      },
    )
  })

  it("preserves provider failure and usage from terminal SSE without exposing tools", async () => {
    await withServer(
      async (incoming, outgoing) => {
        await requestBody(incoming)
        send(outgoing, [
          {
            type: "response.failed",
            response: response([call], {
              status: "failed",
              error: { code: "rate_limit_exceeded", message: "Retry later" },
            }),
          },
        ])
      },
      async (baseURL) => {
        expect(await collect(provider(baseURL)(request()))).toMatchObject([
          {
            type: "failure",
            failure: {
              kind: "rate_limited",
              stage: "model_event",
              provider: "moonshot",
              providerCode: "rate_limit_exceeded",
              providerResponseId: "resp_kimi",
              providerRequestId: "kimi_http_request",
            },
            usage: { inputTokens: 100, outputTokens: 20 },
          },
        ])
      },
    )
  })

  it("sends an explicitly declared custom apply_patch grammar and pairs its result on replay", async () => {
    const patch = "*** Begin Patch\n*** End Patch"
    const custom = {
      type: "custom_tool_call",
      id: "ct_kimi",
      call_id: "patch_kimi",
      name: "apply_patch",
      input: patch,
      status: "completed",
    }
    const format = {
      type: "grammar" as const,
      syntax: "lark" as const,
      definition:
        'start: "*** Begin Patch" NEWLINE "*** End Patch"\n%import common.NEWLINE',
    }
    const bodies: JsonObject[] = []
    await withServer(
      async (incoming, outgoing) => {
        bodies.push(await requestBody(incoming))
        send(outgoing, [
          completed(bodies.length === 1 ? [custom] : [message("Patched")]),
        ])
      },
      async (baseURL) => {
        const stream = provider(baseURL)
        const input = request({
          tools: [
            {
              name: "apply_patch",
              description: "Apply patch",
              kind: "custom",
              inputSchema: {},
              inputFormat: format,
            },
          ],
        })
        const first = terminal(await collect(stream(input)))
        expect(first.content).toMatchObject([
          {
            type: "tool_call",
            toolKind: "custom",
            name: "apply_patch",
            input: patch,
            id: "patch_kimi",
          },
        ])
        await collect(
          stream({
            ...input,
            messages: [
              ...input.messages,
              {
                role: "assistant",
                content: first.content,
                ...(first.native === undefined ? {} : { native: first.native }),
              },
              {
                role: "tool",
                toolCallId: "patch_kimi",
                content: [{ type: "text", text: "Applied" }],
              },
            ],
          }),
        )
        expect(bodies[0]?.tools).toEqual([
          {
            type: "custom",
            name: "apply_patch",
            description: "Apply patch",
            format,
          },
        ])
        const replay = bodies[1]?.input
        if (!Array.isArray(replay))
          throw new Error("Missing custom tool replay")
        expect(replay.slice(-2)).toEqual([
          custom,
          {
            type: "custom_tool_call_output",
            call_id: "patch_kimi",
            output: "Applied",
          },
        ])
      },
    )
  })

  const invalid: Array<
    Readonly<{
      name: string
      overrides: Partial<ModelRequest>
      message: string
    }>
  > = [
    {
      name: "legacy model",
      overrides: {
        target: {
          provider: "moonshot",
          model: "kimi-k2.6",
          instructionProfileId: "default",
        },
      },
      message: "kimi-k3 only",
    },
    {
      name: "forced tools",
      overrides: { toolChoice: "required" },
      message: "tool_choice auto only",
    },
    {
      name: "disabled tools",
      overrides: { toolChoice: "none" },
      message: "tool_choice auto only",
    },
    {
      name: "specific tool",
      overrides: { toolChoice: { name: "view_image" } },
      message: "tool_choice auto only",
    },
    {
      name: "native tool choice override",
      overrides: {
        providerOptions: {
          provider: "moonshot",
          wireApi: "openai_responses",
          body: { tool_choice: "required" },
        },
      },
      message: "harness-owned tool_choice",
    },
    {
      name: "sequential tool constraint",
      overrides: { parallelToolCalls: false },
      message: "parallel_tool_calls",
    },
    {
      name: "unsupported effort",
      overrides: {
        target: {
          provider: "moonshot",
          model: "kimi-k3",
          instructionProfileId: "default",
          effort: "medium",
        },
      },
      message: "low, high or max",
    },
    {
      name: "remote compaction",
      overrides: { compaction: "responses_compact" },
      message: "remote compaction",
    },
    {
      name: "custom tool without patch grammar",
      overrides: {
        tools: [
          {
            name: "evaluate",
            description: "Run code",
            kind: "custom",
            inputSchema: {},
          },
        ],
      },
      message: "custom apply_patch",
    },
  ]
  it.each(invalid)("rejects $name before sending a request", async ({
    overrides,
    message: expected,
  }) => {
    let requests = 0
    await withServer(
      (_incoming, outgoing) => {
        requests += 1
        send(outgoing, [completed([])])
      },
      async (baseURL) => {
        const events = await collect(provider(baseURL)(request(overrides)))
        expect(events).toMatchObject([
          {
            type: "failure",
            failure: {
              kind: "invalid_request",
              stage: "request_build",
              provider: "moonshot",
            },
          },
        ])
        const first = events[0]
        if (first?.type !== "failure")
          throw new Error("Missing validation failure")
        expect(first.failure.message).toContain(expected)
        expect(requests).toBe(0)
      },
    )
  })
})

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    target: {
      provider: "moonshot",
      model: "kimi-k3",
      instructionProfileId: "default",
      effort: "high",
    },
    continuationScope: "kimi_account",
    system: [{ id: "system", revision: "1", text: "Inspect files safely" }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Inspect the screenshot" }],
      },
    ],
    tools: [
      {
        name: "view_image",
        description: "View image",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ],
    toolWireProtocol: "eager",
    cacheKey: "thread_kimi",
    ...overrides,
  }
}

function provider(baseURL: string) {
  return createOpenAIProvider({
    apiKey: "fixture",
    model: "kimi-k3",
    baseURL,
    responseProfile: "kimi",
  })
}

function response(
  output: JsonObject[],
  overrides: JsonObject = {},
): JsonObject {
  return {
    id: "resp_kimi",
    object: "response",
    model: "kimi-k3",
    status: "completed",
    output,
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 30, cache_write_tokens: 40 },
      output_tokens: 20,
      total_tokens: 120,
    },
    ...overrides,
  }
}

function completed(output: JsonObject[]): JsonObject {
  return { type: "response.completed", response: response(output) }
}

function outputItem(
  stage: "added" | "done",
  output_index: number,
  item: JsonObject,
): JsonObject {
  return { type: `response.output_item.${stage}`, output_index, item }
}

function reasoningDelta(delta: string): JsonObject {
  return {
    type: "response.reasoning_summary_text.delta",
    item_id: "rs_kimi",
    output_index: 0,
    summary_index: 0,
    delta,
  }
}

function message(text: string): JsonObject {
  return {
    type: "message",
    id: "msg_kimi",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  }
}

function send(outgoing: ServerResponse, events: JsonObject[]): void {
  outgoing.writeHead(200, {
    "content-type": "text/event-stream",
    "x-request-id": "kimi_http_request",
  })
  outgoing.end(
    events
      .map(
        (event, sequence_number) =>
          `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
      )
      .join(""),
  )
}

async function requestBody(incoming: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = []
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (!isJsonObject(body)) throw new Error("Invalid request body")
  return body
}

async function withServer(
  handler: (
    incoming: IncomingMessage,
    outgoing: ServerResponse,
  ) => void | Promise<void>,
  run: (baseURL: string) => Promise<void>,
): Promise<void> {
  const failures: unknown[] = []
  const server = createServer((incoming, outgoing) => {
    Promise.resolve()
      .then(() => handler(incoming, outgoing))
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

async function collect(
  stream: AsyncIterable<ModelStreamEvent>,
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

function terminal(events: ModelStreamEvent[]) {
  const last = events.at(-1)
  if (last?.type !== "response")
    throw new Error(`Missing response: ${JSON.stringify(last)}`)
  return last.response
}
