import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { describe, expect, it } from "vitest"
import { createAnthropicTurnTransport } from "../../src/runtime/anthropic-provider.ts"
import { prepareProviderMedia } from "../../src/runtime/asset-media.ts"
import { toChatCompletionsMessages } from "../../src/runtime/chat-completions-provider.ts"
import type {
  ModelRequest,
  ModelStreamEvent,
  StreamFn,
} from "../../src/runtime/model.ts"
import { createOpenAITurnTransport } from "../../src/runtime/openai-provider.ts"

const bytes = Buffer.from("portable PDF content")
function request(): ModelRequest {
  return {
    target: {
      provider: "personal",
      model: "test-model",
      instructionProfileId: "default",
    },
    system: [],
    tools: [],
    toolWireProtocol: "eager",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            name: "report.pdf",
            mediaType: "application/pdf",
            sizeBytes: bytes.length,
            file: {
              rolloutId: "rollout_one",
              path: "attachments/requests/request_one/0.pdf",
            },
          },
        ],
      },
    ],
    assets: {
      async read() {
        return bytes
      },
    },
  }
}
async function collect(
  stream: StreamFn,
  input: ModelRequest,
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = []
  for await (const event of stream(input)) events.push(event)
  return events
}
function responseEvents(): globalThis.Response {
  return new globalThis.Response(
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

describe("provider asset adaptation", () => {
  it("uploads local OpenAI PDFs once per turn, scopes IDs to the client, and cleans them on close", async () => {
    let uploads = 0
    const bodies: unknown[] = [],
      deleted: string[] = [],
      uploadedBytes: Buffer[] = []
    const client = new OpenAI({
      apiKey: "fixture",
      maxRetries: 0,
      fetch: async (url, init) => {
        const incoming = new Request(url, init)
        const path = new URL(incoming.url).pathname
        if (incoming.method === "DELETE") {
          deleted.push(path)
          return Response.json({
            id: path.split("/").at(-1),
            deleted: true,
            object: "file",
          })
        }
        if (path === "/v1/files") {
          const file = (await incoming.formData()).get("file")
          if (!(file instanceof File)) throw new Error("Missing uploaded file")
          uploadedBytes.push(Buffer.from(await file.arrayBuffer()))
          return Response.json({
            id: `file_${++uploads}`,
            object: "file",
            bytes: bytes.length,
            created_at: 1,
            filename: "report.pdf",
            purpose: "user_data",
          })
        }
        bodies.push(await incoming.json())
        return responseEvents()
      },
    })
    const input = request(),
      original = JSON.stringify(input.messages)
    const transport = createOpenAITurnTransport({
      client,
      apiKey: "fixture",
      model: "test-model",
      warmup: false,
    })
    for (let index = 0; index < 2; index++)
      expect((await collect(transport.stream, input)).at(-1)?.type).toBe(
        "response",
      )
    expect(uploads).toBe(1)
    expect(uploadedBytes).toEqual([bytes])
    expect(bodies).toEqual([
      expect.objectContaining({
        input: [
          {
            role: "user",
            content: [
              { type: "input_file", filename: "report.pdf", file_id: "file_1" },
            ],
          },
        ],
      }),
      expect.objectContaining({
        input: [
          {
            role: "user",
            content: [
              { type: "input_file", filename: "report.pdf", file_id: "file_1" },
            ],
          },
        ],
      }),
    ])
    expect(JSON.stringify(input.messages)).toBe(original)
    await transport.close()
    expect(deleted).toEqual(["/v1/files/file_1"])
    const another = createOpenAITurnTransport({
      client,
      apiKey: "fixture",
      model: "test-model",
      warmup: false,
    })
    await collect(another.stream, input)
    expect(uploads).toBe(2)
    await another.close()
    expect(deleted).toEqual(["/v1/files/file_1", "/v1/files/file_2"])
  })

  it("retries failed uploads without reusing an absent file ID", async () => {
    let uploads = 0
    const client = new OpenAI({
      apiKey: "fixture",
      maxRetries: 0,
      fetch: async (url, init) => {
        const incoming = new Request(url, init)
        if (incoming.method === "DELETE")
          return Response.json({ id: "file_ok", deleted: true, object: "file" })
        if (new URL(incoming.url).pathname === "/v1/files") {
          if (++uploads === 1)
            return Response.json(
              {
                error: {
                  message: "temporary upload failure",
                  type: "server_error",
                },
              },
              { status: 500 },
            )
          return Response.json({
            id: "file_ok",
            object: "file",
            bytes: bytes.length,
            created_at: 1,
            filename: "report.pdf",
            purpose: "user_data",
          })
        }
        return responseEvents()
      },
    })
    const transport = createOpenAITurnTransport({
      client,
      apiKey: "fixture",
      model: "test-model",
      warmup: false,
    })
    expect((await collect(transport.stream, request())).at(-1)?.type).toBe(
      "failure",
    )
    expect((await collect(transport.stream, request())).at(-1)?.type).toBe(
      "response",
    )
    expect(uploads).toBe(2)
    await transport.close()
  })

  it("uses Anthropic Files sources and deletes only files owned by the turn", async () => {
    let uploads = 0
    const bodies: unknown[] = [],
      deleted: string[] = []
    const client = new Anthropic({
      apiKey: "fixture",
      maxRetries: 0,
      fetch: async (url, init) => {
        const incoming = new Request(url, init)
        const path = new URL(incoming.url).pathname
        if (incoming.method === "DELETE") {
          deleted.push(path)
          return Response.json({ id: "file_claude", type: "file_deleted" })
        }
        if (path === "/v1/files") {
          uploads++
          const file = (await incoming.formData()).get("file")
          if (!(file instanceof File)) throw new Error("Missing uploaded file")
          expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes)
          return Response.json({
            id: "file_claude",
            type: "file",
            created_at: "2026-10-08T00:00:00Z",
            downloadable: false,
            filename: "report.pdf",
            mime_type: "application/pdf",
            size_bytes: bytes.length,
          })
        }
        bodies.push(await incoming.json())
        const events = [
          {
            type: "message_start",
            message: {
              id: "msg_1",
              type: "message",
              role: "assistant",
              content: [],
              model: "test-model",
              stop_reason: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 0 },
          },
          { type: "message_stop" },
        ]
        return new Response(
          events
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const transport = createAnthropicTurnTransport({
      client,
      apiKey: "fixture",
      model: "test-model",
    })
    expect((await collect(transport.stream, request())).at(-1)?.type).toBe(
      "response",
    )
    expect((await collect(transport.stream, request())).at(-1)?.type).toBe(
      "response",
    )
    expect(uploads).toBe(1)
    expect(bodies[0]).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              title: "report.pdf",
              source: { type: "file", file_id: "file_claude" },
            },
          ],
        },
      ],
    })
    await transport.close()
    expect(deleted).toEqual(["/v1/files/file_claude"])
  })

  it("retains public URLs where supported and inlines PDFs for Chat Completions", async () => {
    const read: string[] = []
    const input: ModelRequest = {
      ...request(),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              mediaType: "image/png",
              sizeBytes: 0,
              file: { url: "https://cdn.example/image.png" },
            },
            {
              type: "document",
              mediaType: "application/pdf",
              name: "report.pdf",
              sizeBytes: 0,
              file: { url: "https://cdn.example/report.pdf" },
            },
          ],
        },
      ],
      assets: {
        async read(source) {
          if (!("url" in source)) throw new Error("Unexpected local asset")
          read.push(source.url)
          return bytes
        },
      },
    }
    expect((await prepareProviderMedia(input)).messages).toEqual(input.messages)
    expect(read).toEqual([])
    const prepared = await prepareProviderMedia(input, {
      inlineDocumentUrls: true,
    })
    expect(toChatCompletionsMessages(prepared.messages, "personal")).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "https://cdn.example/image.png", detail: "high" },
          },
          {
            type: "file",
            file: {
              filename: "report.pdf",
              file_data: `data:application/pdf;base64,${bytes.toString("base64")}`,
            },
          },
        ],
      },
    ])
    expect(read).toEqual(["https://cdn.example/report.pdf"])
  })
})
