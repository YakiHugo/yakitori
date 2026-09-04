import {
  createEventEnvelope,
  type EventEnvelope,
  type KernelEvent,
  type StoredEventEnvelope,
} from "../../../src/kernel/index.ts"
import type { LiveSessionEvent } from "../../../src/runtime/live-events.ts"
import {
  createSessionEventHub,
  type SessionEventHub,
} from "../../../src/server/event-hub.ts"
import type { ServerHandlers } from "../../../src/server/handlers.ts"
import type {
  ApiErrorCode,
  ApiHandlerResult,
  ApiPendingPermission,
  ApiSessionDetail,
} from "../../../src/server/protocol.ts"
import {
  type ConnectionHandle,
  MessageProcessor,
  type MessageProcessorOptions,
} from "../../../src/server/rpc/message-processor.ts"
import type {
  JsonRpcErrorResponse,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcResponse,
} from "../../../src/server/rpc/messages.ts"

// A malformed inbound frame can only be answered with a null id, which the
// typed envelope does not admit.
export type TestFrame =
  | JsonRpcMessage
  | Readonly<{ id: null; error: { code: number; message: string } }>

export type TestConnection = Readonly<{
  id: number
  frames: readonly TestFrame[]
  sendRequest(
    method: string,
    params?: unknown,
  ): Promise<JsonRpcResponse | JsonRpcErrorResponse>
  sendNotification(method: string, params?: unknown): void
  sendRaw(text: string): void
  waitForFrame(predicate: (frame: TestFrame) => boolean): Promise<TestFrame>
  notifications(method: string): JsonRpcNotification[]
}>

export function createTestProcessor(
  options: Partial<MessageProcessorOptions> & { handlers: ServerHandlers },
): { processor: MessageProcessor; eventHub: SessionEventHub } {
  const eventHub = createSessionEventHub()
  const processor = new MessageProcessor({ eventHub, ...options })
  return { processor, eventHub }
}

export function openTestConnection(
  processor: MessageProcessor,
): TestConnection {
  const handle: ConnectionHandle = processor.openConnection()
  const frames: TestFrame[] = []
  const waiters: {
    predicate: (frame: TestFrame) => boolean
    resolve: (frame: TestFrame) => void
  }[] = []
  handle.onMessage((text) => {
    const frame = JSON.parse(text) as TestFrame
    frames.push(frame)
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index]
      if (waiter?.predicate(frame)) {
        waiters.splice(index, 1)
        waiter.resolve(frame)
      }
    }
  })
  let nextId = 0
  const connection: TestConnection = {
    id: handle.id,
    frames,
    sendRequest(method, params) {
      const id = ++nextId
      const response = connection.waitForFrame(
        (frame) => "id" in frame && frame.id === id && !("method" in frame),
      )
      handle.send(
        JSON.stringify(
          params === undefined ? { id, method } : { id, method, params },
        ),
      )
      return response as Promise<JsonRpcResponse | JsonRpcErrorResponse>
    },
    sendNotification(method, params) {
      handle.send(
        JSON.stringify(params === undefined ? { method } : { method, params }),
      )
    },
    sendRaw(text) {
      handle.send(text)
    },
    waitForFrame(predicate) {
      const existing = frames.find(predicate)
      if (existing !== undefined) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timed out waiting for a frame.")),
          2000,
        )
        waiters.push({
          predicate,
          resolve: (frame) => {
            clearTimeout(timer)
            resolve(frame)
          },
        })
      })
    },
    notifications(method) {
      return frames.filter(
        (frame): frame is JsonRpcNotification =>
          "method" in frame && !("id" in frame) && frame.method === method,
      )
    },
  }
  return connection
}

export async function initializeConnection(
  connection: TestConnection,
  capabilities?: {
    experimentalApi?: boolean
    optOutNotificationMethods?: string[]
  },
): Promise<JsonRpcResponse | JsonRpcErrorResponse> {
  return connection.sendRequest("initialize", {
    clientInfo: { name: "test-client", version: "0.0.0" },
    ...(capabilities === undefined ? {} : { capabilities }),
  })
}

export function createFakeHandlers(
  overrides: Partial<ServerHandlers> = {},
): ServerHandlers {
  const base: ServerHandlers = {
    createSession: async () =>
      okResult({
        session: makeSessionDetail("session_created"),
        event: makeTurnStarted("session_created", 1, "turn_1"),
      }),
    listSessions: async () => okResult({ sessions: [] }),
    readSession: async () =>
      okResult({ session: makeSessionDetail("session_1") }),
    deleteSession: async () => okResult({ sessionId: "session_1" }),
    forkSession: async () =>
      okResult({
        session: makeSessionDetail("session_forked"),
        historyEndSeqExclusive: 1,
        events: [],
      }),
    admitInput: async () =>
      okResult({
        requestId: "request_1",
        inputId: "input_1",
        event: makeTurnStarted("session_1", 2, "turn_1"),
      }),
    compactSession: async () =>
      okResult({
        requestId: "request_1",
        inputId: "input_1",
        event: makeTurnStarted("session_1", 2, "turn_1"),
      }),
    cancelInput: async () =>
      okResult({
        sessionId: "session_1",
        inputId: "input_1",
        event: makeTurnStarted("session_1", 2, "turn_1"),
      }),
    cancelTurn: async () =>
      okResult({ sessionId: "session_1", turnId: "turn_1" }),
    resolvePermission: async () =>
      okResult({
        sessionId: "session_1",
        turnId: "turn_1",
        permissionRequestId: "perm_1",
        behavior: "allow" as const,
      }),
    readSessionEvents: async () => okResult({ events: [] }),
  }
  return { ...base, ...overrides }
}

// Reimplements the durable paging contract (after..through with nextAfter)
// over a fixed event list.
export function pagedEventsHandler(
  events: readonly StoredEventEnvelope[],
): ServerHandlers["readSessionEvents"] {
  return async (input) => {
    const request = input as {
      after?: number
      through?: number
      limit?: number
    }
    const after = request.after ?? 0
    const through = request.through ?? Number.MAX_SAFE_INTEGER
    const limit = request.limit ?? 500
    const matching = events.filter(
      (event) => event.seq > after && event.seq <= through,
    )
    const page = matching.slice(0, limit)
    const last = page.at(-1)
    return okResult({
      events: page,
      ...(matching.length > page.length && last !== undefined
        ? { nextAfter: last.seq }
        : {}),
    })
  }
}

export function okResult<T>(body: T): ApiHandlerResult<T> {
  return { ok: true, status: 200, body }
}

export function errorResult(
  code: ApiErrorCode,
  message: string,
): ApiHandlerResult<never> {
  return { ok: false, status: 400, body: { error: { code, message } } }
}

export function makeSessionDetail(
  sessionId: string,
  overrides: Partial<ApiSessionDetail> = {},
): ApiSessionDetail {
  return {
    id: sessionId,
    conversationId: "conversation_1",
    seq: 1,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    pendingInputs: [],
    pendingPermissions: [],
    counts: {
      inputs: 0,
      pendingInputs: 0,
      turns: 0,
      items: 0,
      permissions: 0,
      tools: 0,
    },
    ...overrides,
  }
}

export function makePendingPermission(
  overrides: Partial<ApiPendingPermission> = {},
): ApiPendingPermission {
  return {
    permissionRequestId: "perm_1",
    turnId: "turn_1",
    toolCallId: "call_1",
    action: "exec",
    createdAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  }
}

export function makeKernelEvent(
  sessionId: string,
  seq: number,
  event: KernelEvent,
): EventEnvelope {
  return createEventEnvelope({ sessionId, seq, event })
}

export function makeTurnStarted(
  sessionId: string,
  seq: number,
  turnId: string,
): EventEnvelope {
  return makeKernelEvent(sessionId, seq, {
    type: "turn.started",
    data: { turnId, inputId: `input_${turnId}` },
  })
}

export function makeTurnCompleted(
  sessionId: string,
  seq: number,
  turnId: string,
): EventEnvelope {
  return makeKernelEvent(sessionId, seq, {
    type: "turn.completed",
    data: { turnId, outcome: { status: "completed" } },
  })
}

export function makeAssistantDelta(
  sessionId: string,
  turnId: string,
  delta: string,
): LiveSessionEvent {
  return {
    type: "assistant.delta",
    sessionId,
    turnId,
    itemId: "item_1",
    delta,
    createdAt: "2026-09-04T00:00:00.000Z",
  }
}

export function makePermissionRequested(
  sessionId: string,
  turnId: string,
  permissionRequestId: string,
): LiveSessionEvent {
  return {
    type: "permission.requested",
    permissionRequestId,
    sessionId,
    turnId,
    toolCallId: "call_1",
    action: "exec",
    createdAt: "2026-09-04T00:00:00.000Z",
  }
}

export function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value)
    },
  }
}

export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for a condition.")
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
