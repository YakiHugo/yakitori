import { requireProviderConfiguration } from "../../src/server/provider-configuration.ts"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createRolloutAssets } from "../../src/kernel/rollout-assets.ts"
import { prepareModelDocuments } from "../../src/runtime/prepare-model-document.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import { createReadDocumentTool } from "../../src/runtime/tools/read-media.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { captureStepContext } from "../../src/runtime/tools/spec-plan.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { pdfFixture } from "../runtime/tools/pdf-fixture.ts"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

it.each([
  {
    preset: "openai",
    wireApi: "openai_responses",
    baseURL: "https://api.openai.com/v1",
    nativePdf: true,
  },
  {
    preset: "openai",
    wireApi: "openai_responses",
    baseURL: "https://API.OPENAI.COM:443/v1/",
    nativePdf: true,
  },
  {
    preset: "anthropic",
    wireApi: "anthropic_messages",
    baseURL: "https://api.anthropic.com",
    nativePdf: true,
  },
  {
    preset: "anthropic",
    wireApi: "anthropic_messages",
    baseURL: "https://API.ANTHROPIC.COM:443/",
    nativePdf: true,
  },
  {
    preset: "openai",
    wireApi: "openai_responses",
    baseURL: "https://relay.example/v1",
    nativePdf: false,
  },
  {
    preset: "anthropic",
    wireApi: "anthropic_messages",
    baseURL: "https://relay.example",
    nativePdf: false,
  },
  {
    preset: "openai",
    wireApi: "openai_responses",
    baseURL: "https://api.openai.com/relay/v1",
    nativePdf: false,
  },
  {
    preset: "anthropic",
    wireApi: "anthropic_messages",
    baseURL: "https://api.anthropic.com:444",
    nativePdf: false,
  },
  {
    preset: "openai",
    wireApi: "openai_responses",
    baseURL: "http://api.openai.com/v1",
    nativePdf: false,
  },
  {
    preset: "openai",
    wireApi: "openai_responses",
    baseURL: "https://api.openai.com/v1//",
    nativePdf: false,
  },
  {
    preset: "openai",
    wireApi: "openai_chat_completions",
    baseURL: "https://api.openai.com/v1",
    nativePdf: false,
  },
  {
    preset: "anthropic",
    wireApi: "openai_responses",
    baseURL: "https://api.anthropic.com",
    nativePdf: false,
  },
  {
    wireApi: "openai_responses",
    baseURL: "https://api.openai.com/v1",
    nativePdf: false,
  },
] as const)("projects native PDFs only for confirmed endpoints ($wireApi, $baseURL, native=$nativePdf)", async (connection) => {
  const directory = await mkdtemp(join(tmpdir(), "yakitori-endpoint-pdf-"))
  directories.push(directory)
  const assets = createRolloutAssets(directory, {
    withMutationLease: async (id, mutate) => {
      await mkdir(join(directory, "rollouts", id), { recursive: true })
      return mutate()
    },
  })
  const bytes = pdfFixture(["Persisted report"])
  const saved = await assets.saveToolFile(
    "rollout_pdf",
    "call_pdf",
    "report.pdf",
    bytes,
  )
  // A familiar editable connection ID must not establish vendor capabilities.
  const provider = createConfiguredProvider(
    "openai",
    {
      name: "Editable connection",
      ...("preset" in connection ? { preset: connection.preset } : {}),
      wireApi: connection.wireApi,
      baseURL: connection.baseURL,
      models: [{ id: "pdf-model", inputModalities: ["text", "image"] }],
    },
    "test-key",
  )
  const client = createProviderRegistry({ openai: provider }).createClient()
  const turn = client.startTurn("openai")
  const registry = createToolRegistry([])
  const selection = { provider: "openai", model: "pdf-model" }
  const configuration = SessionConfiguration.create(
    {
      selection,
      workspaceRoot: directory,
      enabledTools: [],
      approvalPolicy: "always_approve",
      promptCacheKey: "endpoint-pdf",
    },
    provider.models,
  ).resolveStep(selection, provider.models)
  const step = captureStepContext({
    registry,
    configuration,
    ...(turn.wireApi === undefined ? {} : { wireApi: turn.wireApi }),
    nativePdf: turn.nativePdf === true,
  })
  try {
    const media = await prepareModelDocuments(
      [
        {
          type: "document",
          mediaType: "application/pdf",
          name: "report.pdf",
          sizeBytes: bytes.length,
          file: saved.reference,
        },
      ],
      assets,
      step.documentReading,
    )
    if (connection.nativePdf) {
      expect(media.documents).toMatchObject([
        { data: bytes.toString("base64") },
      ])
      expect(media.images).toEqual([])
    } else {
      expect(media.documents).toEqual([])
      expect(media.images).toMatchObject([
        { type: "image", mediaType: "image/jpeg", data: expect.any(String) },
      ])
    }
  } finally {
    await step.toolRouter.release()
    await registry.dispose()
    await client.close()
  }
})

it.each([
  {
    id: "openai-work",
    preset: "openai",
    wireApi: "openai_responses",
    modalities: ["text", "image"],
    block: "input_image",
  },
  {
    id: "claude-work",
    preset: "anthropic",
    wireApi: "anthropic_messages",
    modalities: ["text", "image"],
    block: "image",
  },
  {
    id: "openai",
    wireApi: "openai_responses",
    modalities: ["text", "image"],
    block: "input_image",
  },
  {
    id: "openai-chat",
    preset: "openai",
    wireApi: "openai_chat_completions",
    modalities: ["text", "image"],
    block: "image_url",
  },
  {
    id: "text-openai",
    preset: "openai",
    wireApi: "openai_responses",
    modalities: ["text"],
    block: "text",
  },
] as const)("uses PDF fallback for $id's overridden endpoint", async (connection) => {
  const bodies: string[] = []
  const endpoint = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    bodies.push(body)
    response.writeHead(200, { "content-type": "text/event-stream" })
    if (connection.wireApi === "openai_chat_completions") {
      response.end(
        'data: {"id":"completion","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"completion","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      )
    } else {
      const events =
        connection.wireApi === "openai_responses"
          ? [
              {
                type: "response.completed",
                response: {
                  id: "response_pdf",
                  status: "completed",
                  output: [],
                  usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
                },
              },
            ]
          : [
              {
                type: "message_start",
                message: {
                  id: "message_pdf",
                  type: "message",
                  role: "assistant",
                  model: "pdf-model",
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 0 },
                },
              },
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 1 },
              },
              { type: "message_stop" },
            ]
      response.end(
        events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
      )
    }
  })
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve))
  const directory = await mkdtemp(join(tmpdir(), "yakitori-provider-pdf-"))
  directories.push(directory)
  const assets = createRolloutAssets(directory, {
    withMutationLease: async (id, mutate) => {
      await mkdir(join(directory, "rollouts", id), { recursive: true })
      return mutate()
    },
  })
  const bytes = pdfFixture(["Persisted report"])
  const saved = await assets.saveToolFile(
    "rollout_pdf",
    "call_pdf",
    "report.pdf",
    bytes,
  )
  const address = endpoint.address()
  if (!address || typeof address === "string")
    throw new Error("Missing endpoint address")
  const provider = createConfiguredProvider(
    connection.id,
    {
      name: "PDF connection",
      ...("preset" in connection ? { preset: connection.preset } : {}),
      wireApi: connection.wireApi,
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      models: [{ id: "pdf-model", inputModalities: connection.modalities }],
    },
    "test-key",
  )
  const client = createProviderRegistry({
    [connection.id]: provider,
  }).createClient()
  const turn = client.startTurn(connection.id, { maxAttempts: 1 })
  const registry = createToolRegistry([])
  const selection = { provider: connection.id, model: "pdf-model" }
  const configuration = SessionConfiguration.create(
    {
      selection,
      workspaceRoot: directory,
      enabledTools: [],
      approvalPolicy: "always_approve",
      promptCacheKey: "pdf",
    },
    provider.models,
  ).resolveStep(selection, provider.models)
  const step = captureStepContext({
    registry,
    configuration,
    ...(turn.wireApi === undefined ? {} : { wireApi: turn.wireApi }),
    nativePdf: turn.nativePdf === true,
  })
  try {
    if (connection.wireApi === "openai_chat_completions") {
      await writeFile(join(directory, "report.pdf"), bytes)
      const context = {
        workspaceRoot: directory,
        documentReading: step.documentReading,
        rolloutAssets: assets,
        rolloutId: "rollout_pdf",
        toolCallId: "call_read_pdf",
      }
      const tool = createReadDocumentTool()
      const read = await tool.execute({ path: "report.pdf" }, context)
      expect(read).toMatchObject({ ok: true, output: { format: "image" } })
      expect(read.content).toContain("selected pages: 1")
      const text = await tool.execute(
        { path: "report.pdf", format: "text" },
        context,
      )
      expect(text).toMatchObject({ ok: true, output: { format: "text" } })
      expect(text.content).toContain("Persisted report")
      await expect(
        tool.execute({ path: "report.pdf", format: "image" }, context),
      ).resolves.toMatchObject({
        ok: true,
        output: { format: "image" },
      })
    }
    const media = await prepareModelDocuments(
      [
        {
          type: "document",
          mediaType: "application/pdf",
          name: "report.pdf",
          sizeBytes: bytes.length,
          file: saved.reference,
        },
      ],
      assets,
      step.documentReading,
    )
    const events = []
    for await (const event of turn.stream({
      target: step.target,
      system: [],
      messages: [
        ...(connection.wireApi === "openai_chat_completions"
          ? [
              {
                role: "user" as const,
                content: [
                  {
                    type: "text" as const,
                    text: "Inspect the supplied image and PDF",
                  },
                  {
                    type: "image" as const,
                    mediaType: "image/png" as const,
                    data: "aW1hZ2U=",
                  },
                ],
              },
            ]
          : []),
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "call_pdf",
              name: "pdf_source",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call_pdf",
          content: media.content,
          ...(media.images.length ? { images: media.images } : {}),
          ...(media.documents.length ? { documents: media.documents } : {}),
        },
      ],
      tools: [],
      toolWireProtocol: "eager",
    }))
      events.push(event)
    expect(events.at(-1)).toMatchObject({ type: "response" })
    expect(bodies).toHaveLength(1)
    if (connection.block !== "text")
      expect(bodies[0]).toContain(`"type":"${connection.block}"`)
    expect(bodies[0]).not.toContain(bytes.toString("base64"))
    expect(bodies[0]).not.toContain('"type":"input_file"')
    expect(bodies[0]).not.toContain('"type":"document"')
    if (connection.block === "text")
      expect(bodies[0]).toContain("Persisted report")
    if (connection.wireApi === "openai_chat_completions") {
      expect(bodies[0]).toContain("Rendered pages")
      expect(bodies[0]).not.toContain("tool results support text only")
      expect(JSON.parse(bodies[0] ?? "").messages).toEqual(
        expect.arrayContaining([
          {
            role: "user",
            content: [
              { type: "text", text: "Inspect the supplied image and PDF" },
              {
                type: "image_url",
                image_url: {
                  url: "data:image/png;base64,aW1hZ2U=",
                  detail: "high",
                },
              },
            ],
          },
          expect.objectContaining({
            role: "tool",
            content: expect.stringContaining("Rendered pages"),
          }),
          {
            role: "user",
            content: [
              { type: "text", text: 'Images from tool result "call_pdf":' },
              {
                type: "image_url",
                image_url: {
                  url: expect.stringMatching(/^data:image\/jpeg;base64,/),
                  detail: "high",
                },
              },
            ],
          },
        ]),
      )
    }
  } finally {
    await step.toolRouter.release()
    await registry.dispose()
    await client.close()
    endpoint.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      endpoint.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

it("requires explicit opt-in for request warmup and never exposes it on compatible backends", async () => {
  for (const [baseURL, requestWarmup, expected] of [
    ["https://api.openai.com/v1", false, false],
    ["https://api.openai.com/v1", true, true],
    ["https://api.example/v1", true, false],
  ] as const) {
    const provider = createConfiguredProvider(
      "api",
      {
        name: "API",
        wireApi: "openai_responses",
        baseURL,
        requestWarmup,
        models: [],
      },
      "test",
    )
    const session = createProviderRegistry({ api: provider })
      .createClient()
      .startTurn("api")
    expect(session.warmup !== undefined).toBe(expected)
    await session.close()
  }
})

it("validates warmup policy before saving provider configuration", () => {
  const configuration = {
    name: "API",
    wireApi: "openai_responses",
    baseURL: "https://api.openai.com/v1",
    models: [],
  }
  expect(
    requireProviderConfiguration(configuration).requestWarmup,
  ).toBeUndefined()
  expect(
    requireProviderConfiguration({ ...configuration, requestWarmup: true })
      .requestWarmup,
  ).toBe(true)
  expect(() =>
    requireProviderConfiguration({ ...configuration, requestWarmup: "yes" }),
  ).toThrow("requestWarmup must be a boolean")
  expect(() =>
    requireProviderConfiguration({
      ...configuration,
      requestWarmup: true,
      baseURL: "https://chatgpt.com/backend-api/codex",
    }),
  ).toThrow("official OpenAI")
})
