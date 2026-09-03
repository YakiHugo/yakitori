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
            type: "response",
            response: {
              stopReason: ModelStopReason.Error,
              content: [],
              error: {
                code: "unauthorized",
                message: "Unauthorized",
                details: { status: 401 },
              },
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
          type: "response",
          response: {
            stopReason: ModelStopReason.Error,
            content: [],
            error: {
              code: "unauthorized",
              message: "Unauthorized",
              details: { status: 401 },
            },
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
        type: "response",
        response: {
          stopReason: ModelStopReason.Error,
          content: [],
          error: {
            code: "codex_account_changed",
            message:
              "Codex login changed accounts during unauthorized recovery; the request was not retried.",
          },
        },
      },
    ])
  })

  it("does not attempt unauthorized recovery without an account fence", async () => {
    const unauthorized: ModelStreamEvent = {
      type: "response",
      response: {
        stopReason: ModelStopReason.Error,
        content: [],
        error: {
          code: "unauthorized",
          message: "Unauthorized",
          details: { status: 401 },
        },
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
      type: "response",
      response: {
        stopReason: ModelStopReason.Error,
        content: [],
        error: {
          code: "unauthorized",
          message: "Unauthorized",
          details: { status: 401 },
        },
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
