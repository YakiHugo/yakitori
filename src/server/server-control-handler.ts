import {
  isServerControlRequest,
  type ServerControlRequest,
  type ServerControlResponse,
} from "../desktop/server-control.ts"
import type { OperationalFailureReporter } from "./operational-errors.ts"
import { reportOperationalFailure } from "./operational-errors.ts"
import type { RequestGate } from "./request-gate.ts"

// Keeps both the control operation and its response acknowledgement under one
// gate token. This is the IPC equivalent of Codex's gated request future.
export function createServerControlMessageHandler(input: {
  readonly requestGate: RequestGate
  readonly handleRequest: (
    request: ServerControlRequest,
  ) => Promise<ServerControlResponse>
  readonly sendResponse: (response: ServerControlResponse) => Promise<void>
  readonly reportOperationalFailure: OperationalFailureReporter
}): (message: unknown) => void {
  return (message) => {
    if (!isServerControlRequest(message)) return
    void input.requestGate
      .run(async () => {
        const response = await input.handleRequest(message)
        await input.sendResponse(response)
      })
      .then((result) => {
        if (!result.accepted) {
          void input.sendResponse({
            requestId: message.requestId,
            ok: false,
            error: "Server is shutting down.",
          })
        }
      })
      .catch((cause: unknown) => {
        reportOperationalFailure(input.reportOperationalFailure, {
          component: "server-control",
          operation: "handle-request",
          cause,
        })
      })
  }
}
