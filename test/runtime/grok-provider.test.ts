import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { JsonObject } from "../../src/kernel/index.ts"
import { createGrokProvider } from "../../src/runtime/grok-provider.ts"
import type {
  ModelRequest,
  ModelResponse,
  StreamFn,
} from "../../src/runtime/model.ts"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it("keeps native reasoning replay across same-account CLI token rotation and a new Turn", async () => {
  const fixture = await setup()
  const provider = createGrokProvider(fixture.root)
  let session = provider.startTurn()
  try {
    const first = await collect(session.stream, request)
    if (first.native === undefined) throw new Error("Missing native output")
    await fixture.login("rotated_access", "account_a")
    await session.close()
    session = provider.startTurn()
    await collect(session.stream, {
      ...request,
      messages: [
        { role: "assistant", content: first.content, native: first.native },
      ],
    })
    expect(fixture.calls).toMatchObject([
      { authorization: "Bearer initial_access" },
      {
        authorization: "Bearer rotated_access",
        body: {
          input: [
            {
              type: "reasoning",
              id: "reasoning",
              summary: [],
              encrypted_content: "opaque",
            },
          ],
        },
      },
    ])
  } finally {
    await session.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

it("stops an in-flight Turn before sending history to a changed Grok account", async () => {
  const fixture = await setup()
  const session = createGrokProvider(fixture.root).startTurn()
  try {
    const first = await collect(session.stream, request)
    if (first.native === undefined) throw new Error("Missing native output")
    await fixture.login("other_access", "account_b")
    const events = []
    for await (const event of session.stream({
      ...request,
      messages: [
        { role: "assistant", content: first.content, native: first.native },
      ],
    }))
      events.push(event)
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      failure: { kind: "authentication", providerCode: "grok_account_changed" },
    })
    expect(fixture.calls).toHaveLength(1)
  } finally {
    await session.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

const request: ModelRequest = {
  target: {
    provider: "grok",
    model: "grok-test",
    instructionProfileId: "test",
  },
  messages: [{ role: "user", content: [{ type: "text", text: "Work" }] }],
  system: [],
  tools: [],
  toolWireProtocol: "eager",
}

async function collect(
  stream: StreamFn,
  input: ModelRequest,
): Promise<ModelResponse> {
  let response: ModelResponse | undefined
  for await (const event of stream(input)) {
    if (event.type === "failure") throw new Error(event.failure.message)
    if (event.type === "response") response = event.response
  }
  if (response === undefined) throw new Error("Missing response")
  return response
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "yakitori-grok-owner-"))
  const path = join(root, "auth.json")
  vi.stubEnv("XAI_API_KEY", undefined)
  vi.stubEnv("GROK_CREDENTIALS", path)
  const login = (accessToken: string, userId: string) =>
    writeFile(
      path,
      JSON.stringify({
        "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
          key: accessToken,
          user_id: userId,
          expires_at: "2099-01-01T00:00:00Z",
        },
      }),
    )
  await login("initial_access", "account_a")
  const calls: { authorization: string | null; body: JsonObject }[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    expect(url).toBe("https://api.x.ai/v1/responses")
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    const body = JSON.parse(
      input instanceof Request ? await input.text() : String(init?.body),
    ) as JsonObject
    calls.push({ authorization: headers.get("authorization"), body })
    return new Response(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "response",
          model: "grok-test",
          status: "completed",
          output: [
            {
              type: "reasoning",
              id: "reasoning",
              summary: [],
              encrypted_content: "opaque",
            },
          ],
          usage: null,
          error: null,
          incomplete_details: null,
        },
      })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  })
  return { root, login, calls }
}
