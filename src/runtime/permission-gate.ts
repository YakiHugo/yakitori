import type {
  SessionPermissionEvent,
  SessionPermissionReason,
} from "../core/session-io.ts"

export type RuntimePermissionReason = SessionPermissionReason

export type RuntimePermissionRequest = {
  readonly permissionRequestId: string
  readonly sessionId: string
  readonly turnId: string
  readonly toolCallId: string
  readonly action: string
  readonly subject?: string
  readonly reason?: string
  readonly createdAt: string
}

export type RuntimePermissionOutcome =
  | { readonly kind: "allow"; readonly reason?: RuntimePermissionReason }
  | { readonly kind: "deny"; readonly reason?: RuntimePermissionReason }
  | { readonly kind: "timeout"; readonly reason: RuntimePermissionReason }
  | { readonly kind: "aborted"; readonly reason: RuntimePermissionReason }

export type RuntimePermissionEvent = SessionPermissionEvent

export type PermissionGate = {
  request(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly toolCallId: string
    readonly action: string
    readonly subject?: string
    readonly reason?: string
    readonly signal?: AbortSignal
    readonly timeoutMs: number
    readonly publish?: (event: RuntimePermissionEvent) => void
  }): Promise<RuntimePermissionOutcome>
  resolve(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly permissionRequestId: string
    readonly behavior: "allow" | "deny"
    readonly reason?: RuntimePermissionReason
  }): boolean
  list(sessionId: string): readonly RuntimePermissionRequest[]
}

export type PermissionGateOptions = {
  readonly publish?: (event: RuntimePermissionEvent) => void
}

type PendingPermission = RuntimePermissionRequest & {
  settle(outcome: RuntimePermissionOutcome): void
}

export function createPermissionGate(
  options: PermissionGateOptions = {},
): PermissionGate {
  const pending = new Map<string, PendingPermission>()

  return {
    request(input) {
      const permissionRequestId = createRuntimePermissionRequestId()
      const request: RuntimePermissionRequest = {
        permissionRequestId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolCallId: input.toolCallId,
        action: input.action,
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        createdAt: new Date().toISOString(),
      }

      return new Promise<RuntimePermissionOutcome>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const onAbort = () => {
          settle({
            kind: "aborted",
            reason: {
              kind: "turn_aborted",
              message: "Permission wait aborted. No process was started.",
            },
          })
        }
        const settle = (outcome: RuntimePermissionOutcome) => {
          if (!pending.delete(permissionRequestId)) return
          if (timer !== undefined) clearTimeout(timer)
          input.signal?.removeEventListener("abort", onAbort)
          const event: RuntimePermissionEvent = {
            type: "permission.resolved",
            permissionRequestId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            outcome: outcome.kind,
            ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
            createdAt: new Date().toISOString(),
          }
          options.publish?.(event)
          input.publish?.(event)
          resolve(outcome)
        }

        pending.set(permissionRequestId, { ...request, settle })
        const event: RuntimePermissionEvent = {
          type: "permission.requested",
          ...request,
        }
        options.publish?.(event)
        input.publish?.(event)
        // A synchronous observer may decide immediately while handling the
        // requested notification. Do not install an orphaned timer afterward.
        if (!pending.has(permissionRequestId)) return
        if (input.signal?.aborted) {
          onAbort()
          return
        }
        input.signal?.addEventListener("abort", onAbort, { once: true })
        timer = setTimeout(
          () =>
            settle({
              kind: "timeout",
              reason: {
                kind: "timeout",
                message: "Permission wait timed out. No process was started.",
              },
            }),
          Math.max(0, input.timeoutMs),
        )
      })
    },
    resolve(input) {
      const request = pending.get(input.permissionRequestId)
      if (
        request === undefined ||
        request.sessionId !== input.sessionId ||
        request.turnId !== input.turnId
      ) {
        return false
      }
      request.settle({
        kind: input.behavior,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })
      return true
    },
    list(sessionId) {
      return [...pending.values()]
        .filter((request) => request.sessionId === sessionId)
        .map(({ settle: _, ...request }) => request)
    },
  }
}

function createRuntimePermissionRequestId(): string {
  return `permission_${globalThis.crypto.randomUUID()}`
}
