import { once } from "node:events"
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { WebSocket } from "ws"
import { PersistContext } from "../../src/core/thread-store.ts"
import { createYakitoriApplication } from "../../src/server/application.ts"
import type { McpRpcResponses } from "../../src/server/rpc/mcp-methods.ts"
import { createFauxProvider } from "../support/faux-provider.ts"

it("reconnects an idle restored session through RPC without reconnecting another session or running a turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-mcp-restored-"))
  const selectedDirectory = join(root, "selected")
  const otherDirectory = join(root, "other")
  await Promise.all(
    [selectedDirectory, otherDirectory].map((path) => mkdir(path)),
  )
  const requestsPath = join(root, "mcp-requests.jsonl")
  const script = join(root, "mcp.mjs")
  await writeFile(
    script,
    `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
createInterface({input:process.stdin}).on("line", line => {
  const m = JSON.parse(line);
  appendFileSync(process.argv[2], JSON.stringify({method:m.method,cwd:process.cwd()})+"\\n");
  if(m.id === undefined) return;
  const result = m.method === "initialize"
    ? {protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}
    : m.method === "tools/list"
      ? {tools:[{name:"write",inputSchema:{type:"object"}}]}
      : {content:[{type:"text",text:"unexpected tool call"}]};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+"\\n");
});
`,
  )
  const userConfigPath = join(root, "config.toml")
  await writeFile(
    userConfigPath,
    [
      "[mcp_servers.fixture]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(script)}, ${JSON.stringify(requestsPath)}]`,
      // The test asserts connection effects synchronously after create and
      // resume; required keeps those boundaries deterministic now that
      // optional servers connect in the background.
      "required = true",
    ].join("\n"),
  )
  const provider = createFauxProvider([])
  const options = {
    rootDir: join(root, "state"),
    workspace: selectedDirectory,
    userConfigPath,
    provider: "faux",
    model: "scripted",
    stream: provider.stream,
  }
  let application = await createYakitoriApplication(options)
  let server: ReturnType<typeof application.createHttpServer> | undefined
  let socket: WebSocket | undefined
  try {
    const selected = await application.handlers.createSession({
      workingDirectory: selectedDirectory,
    })
    const other = await application.handlers.createSession({
      workingDirectory: otherDirectory,
    })
    if (!selected.ok) throw new Error(selected.body.error.message)
    if (!other.ok) throw new Error(other.body.error.message)
    const selectedId = selected.body.session.id
    const otherId = other.body.session.id
    await application.threadStore.persistThread(
      selectedId,
      PersistContext.TurnStart,
    )
    await application.threadStore.persistThread(
      otherId,
      PersistContext.TurnStart,
    )
    await application.close()
    await writeFile(requestsPath, "")

    application = await createYakitoriApplication(options)
    expect(application.threadManager.getThread(selectedId)).toBeUndefined()
    expect(application.threadManager.getThread(otherId)).toBeUndefined()
    expect(await application.threadStore.readThread(selectedId)).toBeDefined()
    // Another resident manager makes an accidental global fallback observable.
    await application.threadManager.resumeThread(otherId)
    const otherCwd = await realpath(otherDirectory)
    const selectedCwd = await realpath(selectedDirectory)
    const readRequests = async () =>
      (await readFile(requestsPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method: string; cwd: string })
    const otherRequests = (await readRequests()).filter(
      (request) => request.cwd === otherCwd,
    )
    expect(
      otherRequests.some((request) => request.method === "tools/list"),
    ).toBe(true)

    server = application.createHttpServer()
    await new Promise<void>((resolve) =>
      server?.listen(0, "127.0.0.1", resolve),
    )
    const address = server.address()
    if (!address || typeof address === "string")
      throw new Error("Missing listener")
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/rpc`)
    await once(socket, "open")
    const ws = socket
    let requestId = 0
    const request = <T>(method: string, params: unknown) =>
      new Promise<T>((resolve, reject) => {
        const id = ++requestId
        const onMessage = (data: WebSocket.RawData) => {
          const frame = JSON.parse(data.toString()) as {
            id?: number
            result?: T
            error?: { message: string }
          }
          if (frame.id !== id) return
          ws.off("message", onMessage)
          if (frame.error) reject(new Error(frame.error.message))
          else resolve(frame.result as T)
        }
        ws.on("message", onMessage)
        ws.send(JSON.stringify({ id, method, params }))
      })
    await request("initialize", {
      clientInfo: { name: "mcp-restored-test", version: "1" },
    })
    const before = await request<McpRpcResponses["mcp/status"]>("mcp/status", {
      sessionId: selectedId,
    })
    expect(before.servers).toMatchObject([
      { name: "fixture", state: "unconnected", toolCount: 0 },
    ])
    expect(application.threadManager.getThread(selectedId)).toBeUndefined()

    await request("mcp/reconnect", { sessionId: selectedId, name: "fixture" })
    const after = await request<McpRpcResponses["mcp/status"]>("mcp/status", {
      sessionId: selectedId,
    })
    expect(after.servers).toMatchObject([
      { name: "fixture", state: "ready", toolCount: 1 },
    ])
    expect(application.threadManager.getThread(selectedId)?.status).toBe("idle")
    const protocolRequests = await readRequests()
    expect(
      protocolRequests.filter((request) => request.cwd === otherCwd),
    ).toEqual(otherRequests)
    expect(
      protocolRequests.some(
        (request) =>
          request.cwd === selectedCwd && request.method === "tools/list",
      ),
    ).toBe(true)
    expect(
      protocolRequests.some((request) => request.method === "tools/call"),
    ).toBe(false)
    expect(provider.callCount).toBe(0)
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      const closed = once(socket, "close")
      socket.close()
      await closed
    }
    if (server)
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve())),
      )
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})
