import type { Server } from "node:http"

export type ShutdownInput = {
  readonly server: Server
  readonly closeApplication: () => Promise<void>
  readonly timeoutMs?: number
  readonly onTimeout?: (step: string) => void
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000

// Bounded shutdown: no single step may stall the process forever. The HTTP
// close force-drops keep-alive and SSE connections up front; both the server
// close and the application close give up after the deadline so a wedged
// connection or store can never hold the event loop hostage.
export async function shutdownHttpApplication(
  input: ShutdownInput,
): Promise<boolean> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  const onTimeout =
    input.onTimeout ??
    ((step: string) => {
      console.error(`yakitori: shutdown step "${step}" timed out`)
    })

  const serverClosed = new Promise<void>((resolve) => {
    input.server.close(() => {
      resolve()
    })
  })
  input.server.closeIdleConnections()
  input.server.closeAllConnections()
  const serverClean = await withTimeout(
    serverClosed,
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
  return serverClean && applicationClean
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
