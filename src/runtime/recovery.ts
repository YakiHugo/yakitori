import {
  PermissionState,
  TurnState,
  YakitoriErrorCode,
  type EventEnvelope,
  type SessionKernel,
} from "../kernel/index.ts"

export type HistoryRecoveryResult = {
  readonly recoveredSessionIds: readonly string[]
  readonly events: readonly EventEnvelope[]
}

export type RecoveryState = {
  readonly pendingInputSessionIds: readonly string[]
  readonly stalePermissionRequestIds: readonly string[]
}

export type RecoveryResult = HistoryRecoveryResult & {
  readonly wokenSessionIds: readonly string[]
  readonly stalePermissionRequestIds: readonly string[]
}

export async function reconcileSessionHistory(input: {
  readonly kernel: SessionKernel
  readonly publish?: (events: readonly EventEnvelope[]) => void
}): Promise<HistoryRecoveryResult> {
  const recoveredSessionIds: string[] = []
  const events: EventEnvelope[] = []

  for await (const sessionId of listSessionIds(input.kernel)) {
    const read = await input.kernel.readSession({ sessionId })
    const active = read.session?.activeTurn
    if (!active) continue

    try {
      const interrupted = await input.kernel.interruptTurn({
        sessionId,
        turnId: active.turnId,
        reason: "Runtime stopped before the Turn reached a recorded boundary.",
      })
      if (!interrupted.created) continue
      events.push(...interrupted.events)
      input.publish?.(interrupted.events)
      recoveredSessionIds.push(sessionId)
    } catch (error) {
      if (!isInvalidState(error)) throw error
      const current = await input.kernel.readSession({ sessionId })
      if (current.session?.activeTurn?.turnId === active.turnId) throw error
    }
  }

  return { recoveredSessionIds, events }
}

export async function discoverRecoveryState(input: {
  readonly kernel: SessionKernel
}): Promise<RecoveryState> {
  const pendingInputSessionIds: string[] = []
  const stalePermissionRequestIds: string[] = []

  for await (const sessionId of listSessionIds(input.kernel)) {
    const read = await input.kernel.readSession({ sessionId })
    const session = read.session
    if (!session) continue
    if (session.pendingInputs.length > 0) pendingInputSessionIds.push(sessionId)
    for (const permission of session.permissions) {
      if (permission.state !== PermissionState.Pending) continue
      const turn = session.turns.find(
        (candidate) => candidate.turnId === permission.turnId,
      )
      if (turn?.state !== TurnState.Started) {
        stalePermissionRequestIds.push(permission.permissionRequestId)
      }
    }
  }

  return { pendingInputSessionIds, stalePermissionRequestIds }
}

export function scheduleRecoveryExecution(input: {
  readonly sessionIds: readonly string[]
  readonly wake?: (sessionId: string) => Promise<void>
  readonly onWakeError?: (error: unknown, sessionId: string) => void
}): readonly string[] {
  if (input.wake === undefined) return [...input.sessionIds]
  for (const sessionId of input.sessionIds) {
    void input.wake(sessionId).catch((error) => {
      input.onWakeError?.(error, sessionId)
    })
  }
  return [...input.sessionIds]
}

export async function recoverSessions(input: {
  readonly kernel: SessionKernel
  readonly wake?: (sessionId: string) => Promise<void>
  readonly publish?: (events: readonly EventEnvelope[]) => void
  readonly onWakeError?: (error: unknown, sessionId: string) => void
}): Promise<RecoveryResult> {
  const history = await reconcileSessionHistory(input)
  const state = await discoverRecoveryState(input)
  const wokenSessionIds = scheduleRecoveryExecution({
    sessionIds: state.pendingInputSessionIds,
    ...(input.wake === undefined ? {} : { wake: input.wake }),
    ...(input.onWakeError === undefined
      ? {}
      : { onWakeError: input.onWakeError }),
  })
  return {
    ...history,
    wokenSessionIds,
    stalePermissionRequestIds: state.stalePermissionRequestIds,
  }
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
