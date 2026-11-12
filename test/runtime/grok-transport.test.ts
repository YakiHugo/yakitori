import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { createGrokProvider } from "../../src/runtime/grok-provider.ts"
import type { ModelStreamEvent } from "../../src/runtime/model.ts"

const endpoint = vi.hoisted(() => ({ baseURL: "" }))
// Route the real Grok stream, SDK, fetch, and dispatcher to a local provider.
vi.mock("../../src/runtime/openai-provider.ts", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../src/runtime/openai-provider.ts")
    >()
  return {
    ...original,
    createOpenAIProvider: (
      options: Parameters<typeof original.createOpenAIProvider>[0],
    ) =>
      original.createOpenAIProvider({ ...options, baseURL: endpoint.baseURL }),
  }
})

it("recovers from a socket failure through Grok's HTTP/1 fallback with a compatible dispatcher", async () => {
  let calls = 0
  const server = createServer((incoming, outgoing) => {
    calls += 1
    if (calls === 1) {
      incoming.socket.destroy()
      return
    }
    outgoing.writeHead(200, { "content-type": "text/event-stream" })
    outgoing.end(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "recovered",
          model: "grok-test",
          status: "completed",
          output: [],
          usage: null,
          error: null,
          incomplete_details: null,
        },
      })}\n\n`,
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new Error("Missing address")
  endpoint.baseURL = `http://127.0.0.1:${address.port}`
  const directory = await mkdtemp(join(tmpdir(), "yakitori-grok-transport-"))
  const credentialsPath = join(directory, "auth.json")
  await writeFile(
    credentialsPath,
    JSON.stringify({
      "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
        key: "test-access",
        user_id: "account_a",
        expires_at: "2099-01-01T00:00:00Z",
      },
    }),
  )
  const session = createGrokProvider(directory, {
    id: "grok",
    credentialsPath,
    ownerIdentity: "account:account_a",
  }).startTurn()
  try {
    const events: ModelStreamEvent[] = []
    for await (const event of session.stream({
      target: {
        provider: "grok",
        model: "grok-test",
        instructionProfileId: "test",
      },
      messages: [{ role: "user", content: [{ type: "text", text: "Work" }] }],
      system: [],
      tools: [],
      toolWireProtocol: "eager",
      signal: AbortSignal.timeout(5_000),
    }))
      events.push(event)
    expect(calls).toBe(2)
    expect(events).toMatchObject([
      {
        type: "retry",
        failure: {
          kind: "connection_failed",
          details: { causeCode: "UND_ERR_SOCKET" },
        },
      },
      { type: "response", response: { providerResponseId: "recovered" } },
    ])
  } finally {
    await session.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(directory, { recursive: true, force: true })
  }
})
