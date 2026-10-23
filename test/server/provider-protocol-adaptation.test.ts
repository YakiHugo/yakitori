import { createServer, type IncomingMessage } from "node:http"
import { describe, expect, it, vi } from "vitest"
import { isJsonObject, type JsonObject } from "../../src/kernel/index.ts"
import type { ModelRequest, ModelStreamEvent } from "../../src/runtime/model.ts"
import type { ModelProvider } from "../../src/runtime/model-provider.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { requireProviderConfiguration } from "../../src/server/provider-configuration.ts"

describe("configured provider protocol adaptation", () => {
  it("uses the Kimi Responses contract only for a confirmed official service endpoint", async () => {
    await withEndpoint(
      [[responsesCompletion()]],
      async ({ requests, remoteURLs }) => {
        const provider = configured("personal-kimi", {
          name: "Personal Kimi account",
          service: "moonshot",
          wireApi: "openai_responses",
          baseURL: "https://API.MOONSHOT.AI:443/v1/",
          models: [{ id: "kimi-k3" }, { id: "kimi-k2.6" }],
        })
        const turn = provider.startTurn({ maxAttempts: 1 })
        try {
          expect(provider.info.serviceId).toBe("moonshot")
          expectLimitedCapabilities(provider, "kimi-k3")
          const events = await collect(
            turn.stream(request("personal-kimi", "kimi-k3")),
          )
          expect(events.at(-1)).toMatchObject({
            type: "response",
            response: {
              stopReason: "end_turn",
              content: [{ type: "text", text: "Ready" }],
            },
          })
          expect(remoteURLs).toEqual(["https://api.moonshot.ai/v1/responses"])
          expect(requests[0]?.body).toMatchObject({
            model: "kimi-k3",
            reasoning: { effort: "max" },
          })
          expectFunctionTools(requests[0]?.body)
          expect(requests[0]?.body).not.toHaveProperty("parallel_tool_calls")
          expect(requests[0]?.body).not.toHaveProperty("include")
          expect(requests[0]?.body).not.toHaveProperty("store")
          for (const input of [
            request("personal-kimi", "kimi-k2.6"),
            {
              ...request("personal-kimi", "kimi-k3"),
              parallelToolCalls: false,
            },
          ]) {
            const rejected = await collect(turn.stream(input))
            expect(rejected.at(-1)).toMatchObject({
              type: "failure",
              failure: {
                kind: "invalid_request",
                stage: "request_build",
                provider: "personal-kimi",
              },
            })
          }
          expect(requests).toHaveLength(1)
        } finally {
          await turn.close()
        }
      },
    )
  })

  it.each([
    {
      service: "openai",
      model: "gpt-6.1-sol",
      baseURL: "https://api.openai.com/v1",
      reason: "max_output_tokens",
      lengthReason: "unknown",
    },
    {
      service: "xai",
      model: "grok-build-0.1",
      baseURL: "https://api.x.ai/v1",
      reason: "max_prompt_tokens",
      lengthReason: "context",
    },
  ])("preserves $service request and output-limit semantics independently of Kimi", async (connection) => {
    const completion = {
      type: "response.incomplete",
      response: {
        id: "response_fixture",
        status: "incomplete",
        model: connection.model,
        output: [],
        incomplete_details: { reason: connection.reason },
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
      },
    }
    await withEndpoint([[completion]], async ({ requests, remoteURLs }) => {
      const provider = configured("personal-model", {
        name: "Kimi API",
        service: connection.service,
        wireApi: "openai_responses",
        baseURL: connection.baseURL,
        models: [{ id: connection.model }],
      })
      const turn = provider.startTurn({ maxAttempts: 1 })
      try {
        const input = request("personal-model", connection.model)
        const events = await collect(
          turn.stream({
            ...input,
            target: { ...input.target, effort: "high" },
          }),
        )
        expect(events.at(-1)).toMatchObject({
          type: "response",
          response: {
            stopReason: "length",
            lengthReason: connection.lengthReason,
          },
        })
        expect(remoteURLs).toEqual([`${connection.baseURL}/responses`])
        expect(provider.info.serviceId).toBe(connection.service)
        expect(requests[0]?.body).toMatchObject({
          model: connection.model,
          parallel_tool_calls: true,
          store: false,
        })
        expectFunctionTools(requests[0]?.body)
        if (connection.service === "openai") {
          expect(requests[0]?.body.reasoning).toEqual({
            effort: "high",
            summary: "auto",
          })
          expect(requests[0]?.body.include).toEqual([
            "reasoning.encrypted_content",
          ])
        } else {
          expect(requests[0]?.body.reasoning).toEqual({ effort: "high" })
          expect(requests[0]?.body).not.toHaveProperty("include")
          expectLimitedCapabilities(provider, connection.model)
        }
      } finally {
        await turn.close()
      }
    })
  })

  it.each([
    {
      case: "same display name",
      name: "Kimi API",
      service: "generic",
      baseURL: "https://api.moonshot.ai/v1",
    },
    {
      case: "preset without service identity",
      name: "Custom",
      service: "generic",
      preset: "moonshot",
      baseURL: "https://api.moonshot.ai/v1",
    },
    {
      case: "service pointing at a relay",
      name: "Relay",
      service: "moonshot",
      baseURL: "https://relay.example/v1",
    },
    {
      case: "different path on official origin",
      name: "Proxy",
      service: "moonshot",
      baseURL: "https://api.moonshot.ai/proxy/v1",
    },
  ])("does not apply Kimi constraints through $case", async (connection) => {
    await withEndpoint([[responsesCompletion()]], async ({ requests }) => {
      const provider = configured("custom-kimi", {
        ...connection,
        wireApi: "openai_responses",
        models: [{ id: "kimi-k3" }],
      })
      const turn = provider.startTurn({ maxAttempts: 1 })
      try {
        expect(provider.info.serviceId).toBeUndefined()
        const events = await collect(
          turn.stream({
            ...request("custom-kimi", "kimi-k3"),
            toolChoice: "required",
            parallelToolCalls: false,
          }),
        )
        expect(events.at(-1)?.type).toBe("response")
        expect(requests[0]?.body).toMatchObject({
          parallel_tool_calls: false,
          tool_choice: "required",
          store: false,
        })
      } finally {
        await turn.close()
      }
    })
  })
})

function configured(id: string, configuration: JsonObject): ModelProvider {
  return createConfiguredProvider(
    id,
    requireProviderConfiguration(configuration),
    "fixture-key",
  )
}

function expectLimitedCapabilities(
  provider: ModelProvider,
  model: string,
): void {
  expect(provider.info.capabilities).toMatchObject({
    remoteCompaction: false,
    nativePdf: false,
  })
  expect(
    provider.models.resolve({ provider: provider.info.id, model }),
  ).toMatchObject({
    supportsCustomTools: false,
    supportsNativeToolSearch: false,
  })
}

function expectFunctionTools(body: JsonObject | undefined): void {
  expect(body?.tools).toEqual([
    {
      type: "function",
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      strict: false,
    },
  ])
}

function request(provider: string, model: string): ModelRequest {
  return {
    target: { provider, model, instructionProfileId: "default" },
    system: [],
    messages: [
      { role: "user", content: [{ type: "text", text: "Inspect files" }] },
    ],
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ],
    toolWireProtocol: "eager",
  }
}

function responsesCompletion(): JsonObject {
  return {
    type: "response.completed",
    response: {
      id: "response_fixture",
      status: "completed",
      model: "kimi-k3",
      output: [
        {
          type: "message",
          id: "msg_fixture",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Ready", annotations: [] }],
        },
      ],
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
    },
  }
}

type CapturedRequest = { body: JsonObject }

async function withEndpoint(
  script: JsonObject[][],
  run: (endpoint: {
    requests: CapturedRequest[]
    remoteURLs: string[]
  }) => Promise<void>,
): Promise<void> {
  const requests: CapturedRequest[] = []
  const remoteURLs: string[] = []
  const failures: unknown[] = []
  const server = createServer((incoming, outgoing) => {
    Promise.resolve()
      .then(async () => {
        const index = requests.length
        requests.push({
          body: await requestBody(incoming),
        })
        outgoing.writeHead(200, { "content-type": "text/event-stream" })
        outgoing.end(
          (script[index] ?? [])
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
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
    throw new Error("Missing fixture address")
  const originalFetch = globalThis.fetch
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const original = new Request(input, init)
    remoteURLs.push(original.url)
    const url = new URL(original.url)
    return originalFetch(
      new Request(
        `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
        original,
      ),
    )
  })
  try {
    await run({ requests, remoteURLs })
    if (failures.length > 0) throw failures[0]
  } finally {
    vi.unstubAllGlobals()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    )
  }
}

async function requestBody(incoming: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = []
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (!isJsonObject(body)) throw new Error("Invalid fixture request")
  return body
}

async function collect(
  stream: AsyncIterable<ModelStreamEvent>,
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}
