import type { ApiSessionDetail } from "../../protocol/application.ts"
import type { AppSessionEventEnvelope } from "../../protocol/events.ts"
import type { ContextTokens } from "../../protocol/execution-view.ts"
import type { LiveSessionSnapshot } from "../../protocol/rpc-methods.ts"
import type {
  SessionTurnSummary,
  SessionTurnsResponse,
} from "../../protocol/session-turns.ts"

import {
  archiveExecutionTurn,
  createExecutionViewState,
  type ExecutionViewAction,
  type ExecutionViewState,
  prependExecutionState,
  reduceExecutionView,
} from "../../shared/execution-view.ts"

export type SessionStreamSnapshot = Readonly<{
  session: ApiSessionDetail
  completedTurns: readonly SessionTurnSummary[]
  activeTurn?: NonNullable<LiveSessionSnapshot["activeTurn"]>
  historyBefore?: number
  contextTokens?: ContextTokens
}>

export function* sessionDisplayEvents(
  snapshot: SessionStreamSnapshot,
): IterableIterator<AppSessionEventEnvelope> {
  for (const turn of snapshot.completedTurns.toReversed()) yield* turn.events
  if (snapshot.activeTurn !== undefined) yield* snapshot.activeTurn.events
}

export function reduceSessionExecution(
  state: ExecutionViewState,
  action: ExecutionViewAction,
): ExecutionViewState {
  const next = reduceExecutionView(state, action)
  if (action.type !== "durable" || action.event.type !== "turn.completed")
    return next
  const { turnId } = action.event.data
  const inputId = next.turnTimings[turnId]?.inputId
  return archiveExecutionTurn(next, turnId, (entry) => {
    if ("turnId" in entry) return entry.turnId !== turnId
    return (
      entry.inputId !== inputId && entry.requestId !== turnId && !entry.steered
    )
  })
}

export function prependSessionTurns(
  state: ExecutionViewState,
  turns: readonly SessionTurnSummary[],
): ExecutionViewState {
  const earlier = projectCompletedTurns(
    turns,
    new Set(state.completedTurns.map((turn) => turn.turnId)),
  )
  return prependExecutionState(state, earlier)
}

function projectCompletedTurns(
  turns: readonly SessionTurnSummary[],
  revisions: ReadonlySet<string>,
): ExecutionViewState {
  let earlier = createExecutionViewState()
  for (const turn of turns.toReversed()) {
    if (revisions.has(turn.turnId)) continue
    const events = turn.events
    for (const event of events)
      earlier = reduceExecutionView(earlier, {
        type: "durable",
        event,
        replay: true,
      })
    // A recorded start without a terminal event is an interrupted Turn when
    // the server includes it among completed history.
    if (
      turn.outcome === "interrupted" &&
      events.at(-1)?.type !== "turn.completed"
    ) {
      earlier = reduceExecutionView(earlier, {
        type: "transient",
        event: {
          type: "turn.finished",
          sessionId: events[0]?.sessionId ?? "",
          turnId: turn.turnId,
          createdAt: turn.completedAt,
          outcome: { status: "interrupted" },
        },
      })
    }
    earlier = archiveExecutionTurn(earlier, turn.turnId, () => false)
  }
  return {
    ...earlier,
    deferredTurnActivity: Object.fromEntries(
      turns.flatMap((turn) =>
        turn.activityCount > 0 && !revisions.has(turn.turnId)
          ? [[turn.turnId, "unloaded" as const]]
          : [],
      ),
    ),
  }
}

export function hydrateSessionExecution(
  snapshot: SessionStreamSnapshot,
  previous?: ExecutionViewState,
): ExecutionViewState {
  let history = projectCompletedTurns(snapshot.completedTurns, new Set())
  for (const event of snapshot.activeTurn?.events ?? [])
    history = reduceExecutionView(history, {
      type: "durable",
      event,
      replay: true,
    })
  for (const entry of previous?.entries ?? []) {
    if (
      entry.kind === "user_input" &&
      entry.requestId !== undefined &&
      entry.inputId === `pending_${entry.requestId}` &&
      !history.admittedRequestIds[entry.requestId]
    )
      history = reduceExecutionView(history, {
        type: "input_pending",
        requestId: entry.requestId,
        content: entry.content,
        at: entry.at,
      })
  }
  const execution = reduceExecutionView(history, {
    type: "replay_completed",
    session: snapshot.session,
  })
  return {
    ...execution,
    deferredTurnActivity: {
      ...execution.deferredTurnActivity,
      ...(snapshot.activeTurn?.activityBefore === undefined
        ? {}
        : { [snapshot.activeTurn.turnId]: snapshot.activeTurn.activityBefore }),
    },
    lastModel: execution.lastModel ?? snapshot.session.currentModel,
    contextTokens: snapshot.contextTokens ?? execution.contextTokens,
  }
}

export function turnHistoryPage(
  response: Extract<SessionTurnsResponse, { view: "summary" }>,
) {
  return {
    turns: response.turns,
    historyBefore: response.nextBefore,
    historyAfter: response.nextAfter,
  }
}
