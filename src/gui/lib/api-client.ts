import type { StoredEventEnvelope } from "../../kernel/index.ts"
import type { LiveSessionEvent } from "../../runtime/live-events.ts"
import type { ApiErrorResponse } from "../../server/protocol.ts"

export function apiUrl(apiBase: string, path: string): string {
  const base = apiBase.endsWith("/") ? apiBase : `${apiBase}/`
  return new URL(path.replace(/^\//, ""), base).toString()
}

export async function requestJson<T>(
  apiBase: string,
  path: string,
  init: {
    readonly body?: unknown
    readonly method?: "GET" | "POST"
  } = {},
): Promise<T> {
  const request =
    init.body === undefined
      ? { method: init.method ?? "GET" }
      : {
          method: init.method ?? "GET",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(init.body),
        }
  const response = await fetch(apiUrl(apiBase, path), request)
  const payload = (await response.json()) as T | ApiErrorResponse
  if (response.ok) return payload as T
  throw new Error(
    isApiErrorResponse(payload)
      ? payload.error.message
      : `HTTP ${response.status}`,
  )
}

export type SessionEventStreamHandlers = {
  readonly onOpen: () => void
  readonly onEvent: (event: StoredEventEnvelope) => void
  readonly onTransient: (event: LiveSessionEvent) => void
  readonly onError: () => void
}

export function openSessionEventStream(
  apiBase: string,
  sessionId: string,
  after: number,
  handlers: SessionEventStreamHandlers,
): EventSource {
  const source = new EventSource(
    apiUrl(
      apiBase,
      `/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`,
    ),
  )
  source.addEventListener("open", () => handlers.onOpen())
  source.addEventListener("session.event", (message) => {
    handlers.onEvent(
      JSON.parse((message as MessageEvent<string>).data) as StoredEventEnvelope,
    )
  })
  source.addEventListener("session.transient", (message) => {
    handlers.onTransient(
      JSON.parse((message as MessageEvent<string>).data) as LiveSessionEvent,
    )
  })
  source.addEventListener("error", () => handlers.onError())
  return source
}

function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null &&
    "message" in value.error &&
    typeof value.error.message === "string"
  )
}
