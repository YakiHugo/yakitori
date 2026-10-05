import { createHash } from "node:crypto"
import OpenAI from "openai"
import { parseChatGPTPlanModels } from "./chatgpt-plan-request.ts"
import type { StreamFn } from "./model.ts"
import { createOpenAIProvider } from "./openai-provider.ts"

export type ChatGPTPlanAccess = Readonly<{
  clientId: string
  subject: string
  accessToken: string
  signal?: AbortSignal
}>

export type ChatGPTPlanAuth = {
  resolve(): Promise<ChatGPTPlanAccess>
}

const BASE_URL = "https://api.openai.com/v1"

// One instance per Turn, so a changed registration cannot move an active Turn's
// messages/tools to another account. Token rotation within that identity is safe.
export function createChatGPTPlanProvider(input: {
  auth: ChatGPTPlanAuth
  fetchFn?: typeof fetch
}): StreamFn {
  let boundIdentity: string | undefined
  return async function* (request) {
    const token = await input.auth.resolve()
    const identity = chatGPTPlanIdentity(token)
    boundIdentity ??= identity
    if (identity !== boundIdentity) {
      yield {
        type: "failure",
        failure: {
          kind: "authentication",
          stage: "request_build",
          provider: request.target.provider,
          wireApi: "openai_responses",
          providerCode: "chatgpt_account_changed",
          message:
            "The ChatGPT registration changed during this turn. Start a new turn to use it.",
        },
      }
      return
    }
    const fetchFn = input.fetchFn ?? fetch
    const client = new OpenAI({
      apiKey: token.accessToken,
      baseURL: BASE_URL,
      maxRetries: 0,
      fetch: (url, init) => fetchFn(url, { ...init, redirect: "error" }),
    })
    const signals = [request.signal, token.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    )
    for await (const event of createOpenAIProvider({
      apiKey: token.accessToken,
      model: request.target.model,
      client,
      requestProfile: "chatgpt-plan",
    })({
      ...request,
      continuationScope: identity,
      ...(signals.length === 0 ? {} : { signal: AbortSignal.any(signals) }),
    })) {
      if (event.type !== "failure") {
        yield event
        continue
      }
      const code = event.failure.providerCode
      if (code === "subscription_sharing_usage_limit_exceeded") {
        yield {
          ...event,
          failure: {
            ...event.failure,
            kind: "rate_limited",
            serverShouldRetry: false,
            message:
              "ChatGPT plan usage is paused. Review app limits in ChatGPT Settings → Usage.",
          },
        }
      } else if (
        code === "subscription_sharing_usage_unavailable" ||
        code === "subscription_sharing_user_unavailable"
      ) {
        yield { ...event, failure: { ...event.failure, kind: "server_error" } }
      } else {
        yield event
      }
    }
  }
}

export async function discoverChatGPTPlanModels(input: {
  auth: ChatGPTPlanAuth
  fetchFn?: typeof fetch
}) {
  const token = await input.auth.resolve()
  const signals = [
    AbortSignal.timeout(15_000),
    ...(token.signal === undefined ? [] : [token.signal]),
  ]
  const response = await (input.fetchFn ?? fetch)(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
    signal: AbortSignal.any(signals),
    redirect: "error",
  })
  if (!response.ok)
    throw new Error(`ChatGPT model catalog failed (HTTP ${response.status}).`)
  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw new Error("ChatGPT returned an invalid model catalog.")
  }
  return {
    identity: chatGPTPlanIdentity(token),
    models: parseChatGPTPlanModels(value),
  }
}

export function chatGPTPlanIdentity(
  token: Pick<ChatGPTPlanAccess, "clientId" | "subject">,
): string {
  return `chatgpt-plan:${createHash("sha256")
    .update(JSON.stringify([token.clientId, token.subject]))
    .digest("hex")}`
}
