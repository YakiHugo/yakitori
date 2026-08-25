import {
  YakitoriErrorCode,
  isKernelEvent,
  type RuntimeEventEnvelope,
  type SessionKernel,
} from "../kernel/index.ts"

export async function recoverSessions(input: {
  readonly kernel: SessionKernel
  readonly wake?: (sessionId: string) => Promise<void>
  readonly publish?: (events: readonly RuntimeEventEnvelope[]) => void
  readonly onWakeError?: (error: unknown, sessionId: string) => void
}): Promise<void> {
  const pendingInputSessionIds: string[] = []

  for await (const sessionId of listSessionIds(input.kernel)) {
    let session = (await input.kernel.readSession({ sessionId })).session
    const active = session?.activeTurn
    if (active !== undefined) {
      try {
        const interrupted = await input.kernel.interruptTurn({
          sessionId,
          turnId: active.turnId,
          reason:
            "Runtime stopped before the Turn reached a recorded boundary.",
        })
        publish(input.publish, interrupted.events)
      } catch (error) {
        if (!isInvalidState(error)) throw error
        const current = await input.kernel.readSession({ sessionId })
        if (current.session?.activeTurn?.turnId === active.turnId) throw error
      }
      session = (await input.kernel.readSession({ sessionId })).session
    }
    if (session !== undefined && session.pendingInputs.length > 0) {
      pendingInputSessionIds.push(sessionId)
    }
  }

  if (input.wake === undefined) return
  for (const sessionId of pendingInputSessionIds) {
    void input.wake(sessionId).catch((error) => {
      input.onWakeError?.(error, sessionId)
    })
  }
}

function publish(
  consumer: ((events: readonly RuntimeEventEnvelope[]) => void) | undefined,
  events: readonly { readonly type: string }[],
): void {
  if (consumer === undefined) return
  consumer(
    events.filter((event): event is RuntimeEventEnvelope =>
      isKernelEvent(event),
    ),
  )
}

async function* listSessionIds(
  kernel: SessionKernel,
): AsyncGenerator<string, void> {
  let cursor: string | undefined
  for (;;) {
    const page = await kernel.listSessions({
      limit: 100,
      order: "created",
      ...(cursor === undefined ? {} : { cursor }),
    })
    for (const session of page.sessions) yield session.sessionId
    if (page.nextCursor === undefined) return
    cursor = page.nextCursor
  }
}

function isInvalidState(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === YakitoriErrorCode.InvalidState
  )
}
