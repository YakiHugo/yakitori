import type { Server } from "node:http"
import type { OperationalFailureReporter } from "./operational-errors.ts"
import { reportOperationalFailure } from "./operational-errors.ts"
import { disconnectWebsocketRpcClients } from "./rpc/websocket-transport.ts"

export type ShutdownInput = {
  readonly server: Server
  readonly closeApplication: () => Promise<void>
  readonly httpShutdown?: HttpServerShutdown
  readonly timeoutMs?: number
  readonly onTimeout?: (step: string) => void
}

export type HttpServerShutdown = Readonly<{
  readonly closed: Promise<void>
  forceClose(): void
}>

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000

export const ShutdownPhase = {
  Running: "running",
  Draining: "draining",
  ShuttingDown: "shutting_down",
  Forced: "forced",
  Finished: "finished",
} as const

export type ShutdownPhase = (typeof ShutdownPhase)[keyof typeof ShutdownPhase]

export type ShutdownResult = Readonly<{
  clean: boolean
  forced: boolean
}>

export type ShutdownController = Readonly<{
  readonly phase: ShutdownPhase
  readonly termination: Promise<ShutdownResult>
  requestShutdown(): void
}>

export async function drainAdmittedRequestsAndTurns(input: {
  readonly drainRequests: Promise<void>
  readonly runningTurnCount: () => number
  readonly subscribeRunningTurnCount: (
    listener: (count: number) => void,
  ) => () => void
  readonly timeoutMs?: number
  readonly onTimeout?: (step: string) => void
}): Promise<boolean> {
  const requestsClean = await withTimeout(
    input.drainRequests,
    input.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    "request-drain",
    input.onTimeout ?? (() => {}),
  )
  if (!requestsClean) return false
  if (input.runningTurnCount() === 0) return true

  await new Promise<void>((resolve) => {
    let unsubscribe: (() => void) | undefined
    const finishIfDrained = (count: number): void => {
      if (count !== 0) return
      unsubscribe?.()
      resolve()
    }
    unsubscribe = input.subscribeRunningTurnCount(finishIfDrained)
    finishIfDrained(input.runningTurnCount())
  })
  return true
}

export function createShutdownController(input: {
  readonly runningTurnCount: () => number
  readonly subscribeRunningTurnCount: (
    listener: (count: number) => void,
  ) => () => void
  readonly beginShutdown: () => void
  readonly shutdown: () => Promise<boolean>
  readonly forceShutdown: () => void
  readonly reportOperationalFailure: OperationalFailureReporter
}): ShutdownController {
  let phase: ShutdownPhase = ShutdownPhase.Running
  let resolveTermination: ((result: ShutdownResult) => void) | undefined
  const termination = new Promise<ShutdownResult>((resolve) => {
    resolveTermination = resolve
  })
  const unsubscribe = input.subscribeRunningTurnCount((count) => {
    if (phase === ShutdownPhase.Draining && count === 0) startShutdown()
  })

  const finish = (result: ShutdownResult): void => {
    if (phase === ShutdownPhase.Forced || phase === ShutdownPhase.Finished) {
      return
    }
    phase = ShutdownPhase.Finished
    unsubscribe()
    resolveTermination?.(result)
  }

  const force = (): void => {
    if (phase === ShutdownPhase.Forced || phase === ShutdownPhase.Finished) {
      return
    }
    phase = ShutdownPhase.Forced
    unsubscribe()
    try {
      input.forceShutdown()
    } catch (error) {
      reportOperationalFailure(input.reportOperationalFailure, {
        component: "server-lifecycle",
        operation: "force-shutdown",
        cause: error,
      })
    }
    resolveTermination?.({ clean: false, forced: true })
  }

  const startShutdown = (): void => {
    if (phase !== ShutdownPhase.Draining) return
    phase = ShutdownPhase.ShuttingDown
    try {
      // The lifecycle owner synchronously closes request admission here. Work
      // admitted before this boundary is drained by shutdown().
      input.beginShutdown()
    } catch (error) {
      reportOperationalFailure(input.reportOperationalFailure, {
        component: "server-lifecycle",
        operation: "begin-shutdown",
        cause: error,
      })
      finish({ clean: false, forced: false })
      return
    }
    void input.shutdown().then(
      (clean) => finish({ clean, forced: false }),
      (error: unknown) => {
        reportOperationalFailure(input.reportOperationalFailure, {
          component: "server-lifecycle",
          operation: "shutdown",
          cause: error,
        })
        finish({ clean: false, forced: false })
      },
    )
  }

  return {
    get phase() {
      return phase
    },
    termination,
    requestShutdown() {
      if (
        phase === ShutdownPhase.Draining ||
        phase === ShutdownPhase.ShuttingDown
      ) {
        force()
        return
      }
      if (phase !== ShutdownPhase.Running) return
      phase = ShutdownPhase.Draining
      if (input.runningTurnCount() === 0) startShutdown()
    },
  }
}

// Stops accepting new TCP connections while allowing admitted requests to
// finish. The lifecycle owner calls forceClose only after request and Turn
// work has drained, matching Codex's close-then-wait RPC gate sequence.
export function beginHttpServerShutdown(server: Server): HttpServerShutdown {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
  server.closeIdleConnections()
  return {
    closed,
    forceClose() {
      server.closeAllConnections()
    },
  }
}

// Bounded resource teardown. At this point new requests are rejected and
// admitted requests and Turns have drained, so remaining connections are SSE,
// keep-alive, or WebSocket transports that can be closed without truncating
// operations. WS connections stay admitted through the drain above; they are
// disconnected here, after the forced HTTP close, because node:http counts
// upgraded sockets toward close() but closeAllConnections() skips them — the
// listener cannot finish closing while a WS client is still connected.
export async function shutdownHttpApplication(
  input: ShutdownInput,
): Promise<boolean> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  const onTimeout =
    input.onTimeout ??
    ((step: string) => {
      console.error(`yakitori: shutdown step "${step}" timed out`)
    })

  const httpShutdown =
    input.httpShutdown ?? beginHttpServerShutdown(input.server)
  httpShutdown.forceClose()
  const websocketsClean = await withTimeout(
    disconnectWebsocketRpcClients(input.server),
    timeoutMs,
    "websocket-disconnect",
    onTimeout,
  )
  const serverClean = await withTimeout(
    httpShutdown.closed,
    timeoutMs,
    "http-close",
    onTimeout,
  )

  const applicationClean = await withTimeout(
    input.closeApplication(),
    timeoutMs,
    "application-close",
    onTimeout,
  )
  return websocketsClean && serverClean && applicationClean
}

async function withTimeout(
  step: Promise<void>,
  timeoutMs: number,
  name: string,
  onTimeout: (step: string) => void,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // Step rejections propagate through the race; only a stall is a timeout.
  const outcome = await Promise.race([
    step.then(() => "clean" as const),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs)
    }),
  ])
  clearTimeout(timer)
  if (outcome === "timeout") {
    onTimeout(name)
    return false
  }
  return true
}
