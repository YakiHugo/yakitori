import OpenAI from "openai"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createOpenAIProvider } from "../../src/runtime/openai-provider.ts"
import { describe, expect, it, vi } from "vitest"
import type { CodexAuthProvider } from "../../src/runtime/codex-credentials.ts"
import { createCodexProvider } from "../../src/runtime/codex-provider.ts"
import {
  type ModelRequest,
  ModelStopReason,
  type ModelStreamEvent,
  type StreamFn,
} from "../../src/runtime/model.ts"
import type { OpenAIProviderOptions } from "../../src/runtime/openai-provider.ts"

describe("Codex provider auth recovery", () => {
  it("refreshes once after a pre-output 401 and hides the failed attempt", async () => {
    const invalidate = vi.fn()
    const auth: CodexAuthProvider = {
      resolve: vi
        .fn()
        .mockResolvedValueOnce({
          accessToken: "expired-token",
          accountId: "account-1",
        })
        .mockResolvedValueOnce({
          accessToken: "fresh-token",
          accountId: "account-1",
        }),
      invalidate,
    }
    const createStream = vi.fn((options: OpenAIProviderOptions): StreamFn => {
      return async function* (): AsyncGenerator<ModelStreamEvent> {
        if (options.apiKey === "expired-token") {
          yield {
            type: "failure",
            failure: {
              kind: "authentication",
              stage: "response_headers",
              provider: "codex",
              wireApi: "openai_responses",
              status: 401,
              message: "Unauthorized",
            },
          }
          return
        }
        yield { type: "snapshot", text: "ok" }
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [{ type: "text", text: "ok" }],
          },
        }
      }
    })
    const stream = createCodexProvider({
      auth,
      createStream,
    })

    const events: ModelStreamEvent[] = []
    for await (const event of stream(requestFixture())) events.push(event)

    expect(events).toEqual([
      { type: "snapshot", text: "ok" },
      {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "ok" }],
        },
      },
    ])
    expect(invalidate).toHaveBeenCalledOnce()
    expect(auth.resolve).toHaveBeenNthCalledWith(2, { forceRefresh: true })
  })

  it("does not resend a request after the shared login changes accounts", async () => {
    const auth: CodexAuthProvider = {
      resolve: vi
        .fn()
        .mockResolvedValueOnce({ accessToken: "expired", accountId: "a" })
        .mockResolvedValueOnce({ accessToken: "fresh", accountId: "b" }),
      invalidate: vi.fn(),
    }
    const createStream = vi.fn((): StreamFn => {
      return async function* (): AsyncGenerator<ModelStreamEvent> {
        yield {
          type: "failure",
          failure: {
            kind: "authentication",
            stage: "response_headers",
            provider: "codex",
            wireApi: "openai_responses",
            status: 401,
            message: "Unauthorized",
          },
        }
      }
    })
    const events: ModelStreamEvent[] = []

    for await (const event of createCodexProvider({ auth, createStream })(
      requestFixture(),
    )) {
      events.push(event)
    }

    expect(createStream).toHaveBeenCalledTimes(1)
    expect(events).toEqual([
      {
        type: "failure",
        failure: {
          kind: "authentication",
          stage: "request_build",
          provider: "codex",
          wireApi: "openai_responses",
          providerCode: "codex_account_changed",
          message:
            "Codex login changed accounts during the turn; no request was sent to the new account.",
        },
      },
    ])
  })

  it("does not attempt unauthorized recovery without an account fence", async () => {
    const unauthorized: ModelStreamEvent = {
      type: "failure",
      failure: {
        kind: "authentication",
        stage: "response_headers",
        provider: "codex",
        wireApi: "openai_responses",
        status: 401,
        message: "Unauthorized",
      },
    }
    const auth: CodexAuthProvider = {
      resolve: vi.fn().mockResolvedValue({
        accessToken: "expired",
        accountId: undefined,
      }),
      invalidate: vi.fn(),
    }
    const createStream = vi.fn((): StreamFn => {
      return async function* (): AsyncGenerator<ModelStreamEvent> {
        yield unauthorized
      }
    })
    const events: ModelStreamEvent[] = []

    for await (const event of createCodexProvider({ auth, createStream })(
      requestFixture(),
    )) {
      events.push(event)
    }

    expect(events).toEqual([unauthorized])
    expect(auth.resolve).toHaveBeenCalledTimes(1)
    expect(auth.invalidate).not.toHaveBeenCalled()
  })

  it("does not refresh after a request has produced visible output", async () => {
    const unauthorized: ModelStreamEvent = {
      type: "failure",
      failure: {
        kind: "authentication",
        stage: "response_headers",
        provider: "codex",
        wireApi: "openai_responses",
        status: 401,
        message: "Unauthorized",
      },
    }
    const auth: CodexAuthProvider = {
      resolve: vi.fn().mockResolvedValue({
        accessToken: "expired",
        accountId: "account-1",
      }),
      invalidate: vi.fn(),
    }
    const createStream = vi.fn((): StreamFn => {
      return async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "snapshot", text: "partial" }
        yield unauthorized
      }
    })
    const events: ModelStreamEvent[] = []

    for await (const event of createCodexProvider({ auth, createStream })(
      requestFixture(),
    )) {
      events.push(event)
    }

    expect(events).toEqual([
      { type: "snapshot", text: "partial" },
      unauthorized,
    ])
    expect(auth.resolve).toHaveBeenCalledTimes(1)
    expect(auth.invalidate).not.toHaveBeenCalled()
    expect(createStream).toHaveBeenCalledTimes(1)
  })

  it("turns local login resolution failures into an actionable auth failure", async () => {
    const cause = new Error("credentials file contained a private path")
    const auth: CodexAuthProvider = {
      resolve: vi.fn().mockRejectedValue(cause),
      invalidate: vi.fn(),
    }
    const events: ModelStreamEvent[] = []

    for await (const event of createCodexProvider({ auth })(requestFixture())) {
      events.push(event)
    }

    expect(events).toEqual([
      {
        type: "failure",
        failure: {
          kind: "authentication",
          stage: "request_build",
          provider: "codex",
          wireApi: "openai_responses",
          providerCode: "codex_login_unavailable",
          message:
            "Codex login is unavailable. Run `codex` and log in again, then retry.",
        },
        cause,
      },
    ])
  })
})

function requestFixture(): ModelRequest {
  return {
    target: {
      provider: "codex",
      model: "gpt-test",
      instructionProfileId: "codex",
    },
    system: [],
    messages: [],
    tools: [],
    toolWireProtocol: "openai_deferred",
  }
}

it("replays the first Codex routing token within a turn and isolates concurrent turns", async () => {
  const received: Headers[] = []
  const auth: CodexAuthProvider = {
    resolve: async () => ({
      accessToken: "test-token",
      accountId: "test-account",
    }),
    invalidate() {},
  }
  const provider = createModelProvider({
    info: {
      id: "codex",
      wireApi: "openai_responses",
      capabilities: { remoteCompaction: false },
      retry: { maxAttempts: 1 },
    },
    createTurnStream: () =>
      createCodexProvider({
        auth,
        createStream(options) {
          return createOpenAIProvider({
            ...options,
            client: new OpenAI({
              apiKey: options.apiKey,
              defaultHeaders: options.defaultHeaders,
              maxRetries: 0,
              fetch: async (_url, init) => {
                received.push(new Headers(init?.headers))
                return new Response(
                  `data: ${JSON.stringify({
                    type: "response.completed",
                    response: {
                      id: "resp_test",
                      status: "completed",
                      output: [],
                      usage: {
                        input_tokens: 2000,
                        output_tokens: 1,
                        input_tokens_details: { cached_tokens: 1536 },
                      },
                    },
                  })}\n\n`,
                  {
                    headers: {
                      "content-type": "text/event-stream",
                      "x-codex-turn-state": `routing-${received.length}`,
                    },
                  },
                )
              },
            }),
          })
        },
      }),
  })
  const client = provider.createClient()
  const first = client.startTurn()
  const second = client.startTurn()
  const run = async (
    turn: ReturnType<typeof client.startTurn>,
    cacheKey: string,
  ) => {
    const events: ModelStreamEvent[] = []
    for await (const event of turn.stream({ ...requestFixture(), cacheKey }))
      events.push(event)
    expect(events.at(-1)).toMatchObject({
      type: "response",
      response: { usage: { cacheReadInputTokens: 1536 } },
    })
  }
  await run(first, "session-a")
  await run(second, "session-b")
  await run(first, "session-a")
  await run(first, "session-a")
  await run(second, "session-b")
  await first.close()
  await run(client.startTurn(), "session-a")
  expect(received.map((headers) => headers.get("x-codex-turn-state"))).toEqual([
    null,
    null,
    "routing-1",
    "routing-1",
    "routing-2",
    null,
  ])
  expect(received.map((headers) => headers.get("session-id"))).toEqual([
    "session-a",
    "session-b",
    "session-a",
    "session-a",
    "session-b",
    "session-a",
  ])
  await client.close()
})

it("stops before sending a continuation when the Codex account changes between tool steps", async () => {
  const auth: CodexAuthProvider = {
    resolve: vi
      .fn()
      .mockResolvedValueOnce({
        accessToken: "first-token",
        accountId: "first-account",
      })
      .mockResolvedValueOnce({
        accessToken: "second-token",
        accountId: "second-account",
      }),
    invalidate: vi.fn(),
  }
  const createStream = vi.fn(
    (options: OpenAIProviderOptions): StreamFn =>
      async function* () {
        options.onResponseHeaders?.(
          new Headers({ "x-codex-turn-state": "first-account-route" }),
        )
        yield {
          type: "response",
          response: { stopReason: "end_turn", content: [] },
        }
      },
  )
  const stream = createCodexProvider({ auth, createStream })
  for await (const _ of stream(requestFixture())) {
    /* complete the first call */
  }
  const events: ModelStreamEvent[] = []
  for await (const event of stream(requestFixture())) events.push(event)
  expect(events).toEqual([
    expect.objectContaining({
      type: "failure",
      failure: expect.objectContaining({
        kind: "authentication",
        providerCode: "codex_account_changed",
      }),
    }),
  ])
  expect(createStream).toHaveBeenCalledTimes(1)
  expect(auth.invalidate).not.toHaveBeenCalled()
})
