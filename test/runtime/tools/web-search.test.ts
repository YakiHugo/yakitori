import { createServer, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import {
  createDefaultTools,
  createExaMcpSearchProvider,
  createWebSearchTool,
  type ExaMcpSearchProviderOptions,
} from "../../../src/index.ts"

const CITATION_REMINDER =
  "Cite the relevant URLs from these results as markdown links when you use them."

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
})

type McpRequest = {
  readonly url: URL
  readonly body: string
}

async function serveMcp(
  handler: (input: {
    readonly request: McpRequest
    readonly response: ServerResponse
  }) => void,
): Promise<{ readonly endpoint: string; readonly requests: McpRequest[] }> {
  const requests: McpRequest[] = []
  const server = createServer((incoming, response) => {
    let body = ""
    incoming.on("data", (chunk: Buffer | string) => {
      body += chunk.toString()
    })
    incoming.on("end", () => {
      const request: McpRequest = {
        url: new URL(incoming.url ?? "/", "http://localhost"),
        body,
      }
      requests.push(request)
      handler({ request, response })
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const { port } = server.address() as AddressInfo
  return { endpoint: `http://127.0.0.1:${String(port)}/mcp`, requests }
}

function respondJson(response: ServerResponse, payload: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(payload))
}

async function search(
  query: unknown,
  providerOptions: ExaMcpSearchProviderOptions,
) {
  return createWebSearchTool({
    provider: createExaMcpSearchProvider(providerOptions),
  }).execute({ query }, { workspaceRoot: process.cwd() })
}

describe("web_search contract", () => {
  it("is auto-allowed, read-only, and part of the default tool set", () => {
    const tool = createWebSearchTool({
      provider: async () => ({ ok: true, text: "" }),
    })
    expect(tool).toMatchObject({
      name: "web_search",
      autoAllow: true,
      effect: "observe",
      inputSchema: {
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "string", minLength: 1 } },
      },
    })
    expect(createDefaultTools().map((entry) => entry.name)).toContain(
      "web_search",
    )
  })

  it("posts a direct JSON-RPC tools/call and passes the result text through", async () => {
    const digest =
      "1. Example — https://example.com/a\n2. Other — https://example.com/b"
    const { endpoint, requests } = await serveMcp(({ response }) => {
      respondJson(response, {
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: digest }] },
      })
    })
    const result = await search("node 24 release date", { endpoint })
    expect(result).toMatchObject({
      ok: true,
      content: `${digest}\n\n${CITATION_REMINDER}`,
      output: { query: "node 24 release date" },
    })
    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: { query: "node 24 release date", numResults: 8 },
      },
    })
  })

  it("parses SSE-framed responses", async () => {
    const { endpoint } = await serveMcp(({ response }) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "streamed digest" }] },
        })}\n\n`,
      )
    })
    const result = await search("anything", { endpoint })
    expect(result).toMatchObject({
      ok: true,
      content: `streamed digest\n\n${CITATION_REMINDER}`,
    })
  })

  it("passes a no-results digest through like any other text", async () => {
    const { endpoint } = await serveMcp(({ response }) => {
      respondJson(response, {
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            { type: "text", text: "No results found for the given query." },
          ],
        },
      })
    })
    const result = await search("obscure", { endpoint })
    expect(result).toMatchObject({
      ok: true,
      content: `No results found for the given query.\n\n${CITATION_REMINDER}`,
    })
  })

  it("maps result.isError to a structured failure", async () => {
    const { endpoint } = await serveMcp(({ response }) => {
      respondJson(response, {
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          content: [{ type: "text", text: "Exa rate limit exceeded" }],
        },
      })
    })
    const result = await search("anything", { endpoint })
    expect(result).toMatchObject({
      ok: false,
      code: "search_error",
      message: expect.stringContaining("Exa rate limit exceeded"),
    })
  })

  it("maps a JSON-RPC error to a structured failure", async () => {
    const { endpoint } = await serveMcp(({ response }) => {
      respondJson(response, {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "Invalid params" },
      })
    })
    const result = await search("anything", { endpoint })
    expect(result).toMatchObject({
      ok: false,
      code: "search_error",
      message: expect.stringContaining("Invalid params"),
    })
  })

  it("treats non-2xx responses as errors", async () => {
    const { endpoint } = await serveMcp(({ response }) => {
      respondJson(response, { error: "upstream" }, 500)
    })
    const result = await search("anything", { endpoint })
    expect(result).toMatchObject({
      ok: false,
      code: "search_error",
      message: expect.stringContaining("500"),
    })
  })

  it("appends the API key as the exaApiKey query parameter", async () => {
    const { endpoint, requests } = await serveMcp(({ response }) => {
      respondJson(response, {
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "ok" }] },
      })
    })
    const result = await search("anything", { endpoint, apiKey: "test key/1" })
    expect(result).toMatchObject({ ok: true })
    expect(requests[0]?.url.searchParams.get("exaApiKey")).toBe("test key/1")
  })

  it("picks up EXA_API_KEY from the environment", async () => {
    const { endpoint, requests } = await serveMcp(({ response }) => {
      respondJson(response, {
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "ok" }] },
      })
    })
    process.env.EXA_API_KEY = "env-key"
    try {
      await search("anything", { endpoint })
    } finally {
      delete process.env.EXA_API_KEY
    }
    expect(requests[0]?.url.searchParams.get("exaApiKey")).toBe("env-key")
  })

  it("times out unresponsive endpoints", async () => {
    const { endpoint } = await serveMcp(() => {})
    const result = await search("anything", { endpoint, timeoutMs: 100 })
    expect(result).toMatchObject({ ok: false, code: "search_timeout" })
  })

  it("times out slow-drip response bodies, not just the initial response", async () => {
    const { endpoint } = await serveMcp(({ response }) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.write("{")
    })
    const result = await search("anything", { endpoint, timeoutMs: 100 })
    expect(result).toMatchObject({ ok: false, code: "search_timeout" })
  })

  it("caps oversized endpoint responses instead of buffering unboundedly", async () => {
    const { endpoint } = await serveMcp(({ response }) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(`"${"x".repeat(4 * 1024 * 1024)}"`)
    })
    const result = await search("anything", { endpoint })
    // Truncated at the cap, the body is no longer a parseable JSON-RPC
    // document — but the tool returns instead of buffering the whole thing.
    expect(result).toMatchObject({ ok: false, code: "search_error" })
  })

  it("reports network errors for unreachable endpoints", async () => {
    const result = await search("anything", {
      endpoint: "http://127.0.0.1:1/mcp",
    })
    expect(result).toMatchObject({ ok: false, code: "network_error" })
  })

  it("rejects malformed endpoint bodies", async () => {
    const { endpoint } = await serveMcp(({ response }) => {
      response.writeHead(200, { "content-type": "text/html" })
      response.end("<html>not json-rpc</html>")
    })
    const result = await search("anything", { endpoint })
    expect(result).toMatchObject({ ok: false, code: "search_error" })
  })

  it("rejects invalid input before any request", async () => {
    const { endpoint, requests } = await serveMcp(({ response }) => {
      respondJson(response, {})
    })
    await expect(search("", { endpoint })).resolves.toMatchObject({
      ok: false,
      code: "invalid_tool_input",
    })
    await expect(search(undefined, { endpoint })).resolves.toMatchObject({
      ok: false,
      code: "invalid_tool_input",
    })
    expect(requests).toHaveLength(0)
  })

  it("honors an already-aborted context signal", async () => {
    const { endpoint, requests } = await serveMcp(({ response }) => {
      respondJson(response, {})
    })
    const controller = new AbortController()
    controller.abort()
    const result = await createWebSearchTool({
      provider: createExaMcpSearchProvider({ endpoint }),
    }).execute(
      { query: "anything" },
      { workspaceRoot: process.cwd(), signal: controller.signal },
    )
    expect(result).toMatchObject({ ok: false, code: "aborted" })
    expect(requests).toHaveLength(0)
  })
})
