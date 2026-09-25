import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { expect, it } from "vitest"
import { createMcpConnectionManager } from "../../src/runtime/mcp-connection-manager.ts"

it("recovers transient startup and expired HTTP sessions without replaying a tool call", async () => {
  let initializations = 0
  let calls = 0
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const message = JSON.parse(Buffer.concat(chunks).toString()) as {
      id?: number
      method: string
      params?: { protocolVersion?: string }
    }
    if (message.method === "initialize" && ++initializations === 1) {
      response.writeHead(503).end("temporarily unavailable")
      return
    }
    if (message.method === "tools/call" && ++calls === 1) {
      response.writeHead(404).end("session expired after request was received")
      return
    }
    if (message.id === undefined) {
      response.writeHead(202).end()
      return
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : message.method === "tools/list"
          ? { tools: [{ name: "write", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: `call ${calls}` }] }
    response
      .writeHead(200, {
        "Content-Type": "application/json",
        "Mcp-Session-Id": `session-${initializations}`,
      })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Missing listener")
  const manager = createMcpConnectionManager({ restartDelayMs: 1 })
  try {
    await manager.update({
      remote: { url: `http://127.0.0.1:${address.port}/mcp` },
    })
    await expect.poll(() => manager.status()[0]?.state).toBe("ready")
    expect(initializations).toBe(2)
    const original = manager.tools()[0]
    expect(original?.supportsParallelToolCalls).toBe(false)
    await expect(
      original?.execute({}, { workspaceRoot: tmpdir() }),
    ).rejects.toThrow()
    await expect
      .poll(
        () =>
          manager.tools()[0] !== undefined && manager.tools()[0] !== original,
      )
      .toBe(true)
    expect(calls).toBe(1)
    await expect(
      manager.tools()[0]?.execute({}, { workspaceRoot: tmpdir() }),
    ).resolves.toMatchObject({ content: "call 2" })
    expect(initializations).toBe(3)
  } finally {
    await manager.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

it("exposes paged resources and templates from a resource-only server and reads their contents", async () => {
  const requests: string[] = []
  let exposeTools = false
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const message = JSON.parse(Buffer.concat(chunks).toString()) as {
      id?: number
      method: string
      params?: { protocolVersion?: string; cursor?: string; uri?: string }
    }
    if (message.id === undefined) {
      response.writeHead(202).end()
      return
    }
    requests.push(message.method)
    if (message.method === "tools/list") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: ["list_resources", "host:list_resources"].map((name) => ({
              name,
              inputSchema: { type: "object" },
            })),
          },
        }),
      )
      return
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params?.protocolVersion,
            capabilities: {
              resources: {},
              ...(exposeTools ? { tools: {} } : {}),
            },
            serverInfo: { name: "fixture", version: "1" },
          }
        : message.method === "resources/list"
          ? message.params?.cursor === "page2"
            ? { resources: [{ name: "second", uri: "demo://second" }] }
            : {
                resources: [{ name: "first", uri: "demo://first" }],
                nextCursor: "page2",
              }
          : message.method === "resources/templates/list"
            ? {
                resourceTemplates: [
                  { name: "item", uriTemplate: "demo://{name}" },
                ],
              }
            : {
                contents: [
                  {
                    uri: message.params?.uri,
                    text: "resource content",
                    mimeType: "text/plain",
                  },
                ],
              }
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Missing listener")
  const manager = createMcpConnectionManager()
  try {
    await manager.update({
      remote: { url: `http://127.0.0.1:${address.port}/mcp` },
    })
    await manager.settleConnecting(5_000)
    expect(manager.tools()).toHaveLength(3)
    expect(requests).toEqual(["initialize"])
    const tools = Object.fromEntries(
      manager.tools().map((tool) => [tool.toolName.name, tool]),
    )
    const context = { workspaceRoot: tmpdir() }
    const first = await tools.list_resources?.execute({}, context)
    expect(JSON.parse(first?.content ?? "")).toMatchObject({
      nextCursor: "page2",
    })
    const second = await tools.list_resources?.execute(
      { cursor: "page2" },
      context,
    )
    expect(JSON.parse(second?.content ?? "")).toEqual({
      resources: [{ name: "second", uri: "demo://second" }],
    })
    const templates = await tools.list_resource_templates?.execute({}, context)
    expect(JSON.parse(templates?.content ?? "")).toEqual({
      resourceTemplates: [{ name: "item", uriTemplate: "demo://{name}" }],
    })
    await expect(
      tools.read_resource?.execute({ uri: "demo://first" }, context),
    ).resolves.toMatchObject({ content: "resource content" })
    exposeTools = true
    await manager.reconnect("remote")
    expect(manager.tools()).toHaveLength(5)
    expect(
      new Set(manager.tools().map((tool) => tool.toolName.name)).size,
    ).toBe(5)
  } finally {
    await manager.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
