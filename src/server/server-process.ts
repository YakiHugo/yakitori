import type {
  ServerControlRequest,
  ServerControlResponse,
} from "../desktop/server-control.ts"
import {
  createYakitoriApplication,
  type YakitoriApplication,
  type YakitoriApplicationOptions,
} from "./application.ts"
import {
  consoleOperationalFailureReporter,
  type OperationalFailureReporter,
  reportOperationalFailure,
} from "./operational-errors.ts"
import {
  beginHttpServerShutdown,
  createShutdownController,
  drainAdmittedRequestsAndTurns,
  type HttpServerShutdown,
  shutdownHttpApplication,
} from "./shutdown.ts"
import { createRequestGate } from "./request-gate.ts"
import { createServerControlMessageHandler } from "./server-control-handler.ts"

export type YakitoriServerProcessInput = Readonly<{
  host: string
  port: number
  application: YakitoriApplicationOptions
  onListening: (url: string, application: YakitoriApplication) => void
  reportOperationalFailure?: OperationalFailureReporter
}>

// Owns the process-wide server lifecycle. Both the standalone server and the
// packaged Electron sidecar use this path so control IPC and shutdown cannot
// drift between entry points.
export async function runYakitoriServerProcess(
  input: YakitoriServerProcessInput,
): Promise<void> {
  // Codex refuses to start a non-loopback websocket listener without auth
  // (transport/auth.rs). Yakitori has no auth mechanism, so the invariant
  // becomes an outright startup refusal.
  if (!isLoopbackHost(input.host)) {
    throw new Error(
      `Refusing to bind the Yakitori server to non-loopback host "${input.host}": the server has no authentication mechanism and must bind a loopback address.`,
    )
  }
  const reporter =
    input.reportOperationalFailure ?? consoleOperationalFailureReporter
  const application = await createYakitoriApplication({
    ...input.application,
    reportOperationalFailure: reporter,
  })
  const requestGate = createRequestGate()
  const server = application.createHttpServer({ requestGate })
  let httpShutdown: HttpServerShutdown | undefined
  const onMessage = createServerControlMessageHandler({
    requestGate,
    handleRequest: (request) =>
      handleServerControlRequest(application, request),
    sendResponse: (response) => sendServerControlResponse(response, reporter),
    reportOperationalFailure: reporter,
  })

  function sendServerControlResponse(
    response: ServerControlResponse,
    responseReporter: OperationalFailureReporter,
  ): Promise<void> {
    return new Promise((resolve) => {
      if (process.send === undefined) {
        reportOperationalFailure(responseReporter, {
          component: "server-control",
          operation: "send-response",
          cause: new Error("Control IPC disconnected before response."),
        })
        resolve()
        return
      }
      try {
        process.send(response, (error) => {
          if (error !== null) {
            reportOperationalFailure(responseReporter, {
              component: "server-control",
              operation: "send-response",
              cause: error,
            })
          }
          resolve()
        })
      } catch (error) {
        reportOperationalFailure(responseReporter, {
          component: "server-control",
          operation: "send-response",
          cause: error,
        })
        resolve()
      }
    })
  }
  const shutdown = createShutdownController({
    runningTurnCount: () => application.threadManager.runningTurnCount,
    subscribeRunningTurnCount: (listener) =>
      application.threadManager.subscribeRunningTurnCount(listener),
    beginShutdown: () => {
      requestGate.close()
      httpShutdown ??= beginHttpServerShutdown(server)
    },
    shutdown: async () => {
      const requestsClean = await drainAdmittedRequestsAndTurns({
        drainRequests: requestGate.shutdown(),
        runningTurnCount: () => application.threadManager.runningTurnCount,
        subscribeRunningTurnCount: (listener) =>
          application.threadManager.subscribeRunningTurnCount(listener),
        onTimeout: (step) => {
          reportOperationalFailure(reporter, {
            component: "server-lifecycle",
            operation: `timeout-${step}`,
            cause: new Error(`Shutdown step ${step} timed out.`),
          })
        },
      })
      application.threadManager.beginShutdown()
      const resourcesClean = await shutdownHttpApplication({
        server,
        ...(httpShutdown === undefined ? {} : { httpShutdown }),
        closeApplication: () => application.close(),
        onTimeout: (step) => {
          reportOperationalFailure(reporter, {
            component: "server-lifecycle",
            operation: `timeout-${step}`,
            cause: new Error(`Shutdown step ${step} timed out.`),
          })
        },
      })
      return requestsClean && resourcesClean
    },
    forceShutdown: () => {
      requestGate.close()
      httpShutdown ??= beginHttpServerShutdown(server)
      httpShutdown.forceClose()
      process.exit(1)
    },
    reportOperationalFailure: reporter,
  })
  const onSignal = (): void => shutdown.requestShutdown()

  process.on("message", onMessage)
  process.on("disconnect", onSignal)
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  try {
    const url = await listen(server, input.host, input.port)
    input.onListening(url, application)
    void application.probeUserShellEnv().catch((error: unknown) => {
      reportOperationalFailure(reporter, {
        component: "user-shell-env",
        operation: "probe",
        cause: error,
      })
    })
    const result = await shutdown.termination
    process.exit(result.clean ? 0 : 1)
  } catch (error) {
    try {
      if (server.listening) {
        await shutdownHttpApplication({
          server,
          closeApplication: () => application.close(),
        })
      } else {
        await application.close()
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Yakitori server startup and cleanup both failed.",
        { cause: error },
      )
    }
    throw error
  } finally {
    process.off("message", onMessage)
    process.off("disconnect", onSignal)
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
  }
}

export async function handleServerControlRequest(
  application: Pick<YakitoriApplication, "rolloutAssets" | "threadStore">,
  request: ServerControlRequest,
): Promise<ServerControlResponse> {
  try {
    if (request.type === "import_image_paths") {
      const thread = await application.threadStore.readThread(request.sessionId)
      if (thread === undefined) {
        throw new Error(`Session ${request.sessionId} was not found.`)
      }
      const attachments = await application.rolloutAssets.importImagePaths(
        thread.metadata.rolloutId,
        request.ownerId,
        request.paths,
      )
      return { requestId: request.requestId, ok: true, attachments }
    }
    await application.rolloutAssets.discardDraftImageAttachments(
      request.attachments,
    )
    return { requestId: request.requestId, ok: true }
  } catch (error) {
    return {
      requestId: request.requestId,
      ok: false,
      error:
        error instanceof Error ? error.message : "Attachment import failed.",
    }
  }
}

function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1" || host === "[::1]") return true
  // IPv4 loopback is the whole 127.0.0.0/8 block.
  const parts = host.split(".")
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

function listen(
  server: ReturnType<YakitoriApplication["createHttpServer"]>,
  host: string,
  port: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once("error", onError)
    server.listen(port, host, () => {
      server.off("error", onError)
      const address = server.address()
      if (address === null || typeof address === "string") {
        reject(new Error("Yakitori server did not bind a TCP address."))
        return
      }
      resolve(`http://${host}:${address.port}`)
    })
  })
}
