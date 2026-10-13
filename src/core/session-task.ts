import type {
  SessionConfigurationSnapshot,
  TurnCompletion,
} from "../kernel/events.ts"
import type { Session, SessionSnapshot } from "./session.ts"
import type { TurnInput } from "./session-io.ts"

export type TurnControl = Readonly<{
  signal: AbortSignal
  takeSteering(): readonly TurnInput[]
  takeSteeringOrComplete():
    | { readonly type: "steering"; readonly inputs: readonly TurnInput[] }
    | { readonly type: "complete" }
}>

export type ExecutionContext = Readonly<{
  executionId: string
  input: TurnInput
  signal: AbortSignal
}>

export type SessionTask = Readonly<{
  kind: "regular" | "compact"
  run(
    session: Session,
    execution: ExecutionContext,
  ): Promise<TurnCompletion | undefined>
  // Escalation after cooperative cancellation; run still owns its finally.
  abort?(): Promise<void>
}>

export type SessionTaskRunner = Readonly<{
  createTask(snapshot: SessionSnapshot, input: TurnInput): SessionTask
  prepareSteering?(
    snapshot: SessionSnapshot,
    input: TurnInput,
  ): SessionConfigurationSnapshot | undefined
  dispose?(): void | Promise<void>
}>

export class TaskCleanupError extends Error {
  constructor(cause: unknown) {
    super(
      `Task resource cleanup failed${cause instanceof Error ? `: ${cause.message}` : "."}`,
      { cause },
    )
  }
}

// Resource teardown is part of task settlement, including its failures. This
// translation keeps cleanup failure distinct from a model/tool execution error.
export async function settleTaskResources(
  cleanup: () => void | Promise<void>,
): Promise<void> {
  try {
    await cleanup()
  } catch (cause) {
    throw cause instanceof TaskCleanupError
      ? cause
      : new TaskCleanupError(cause)
  }
}

export type TaskOutcome =
  | Readonly<{ type: "completed"; completion?: TurnCompletion }>
  | Readonly<{ type: "interrupted" }>
  | Readonly<{ type: "failed"; error: unknown }>

export type TaskSettlement =
  | TaskOutcome
  | Readonly<{ type: "cleanup_failed"; error: unknown }>

export type SessionTaskHandle = Readonly<{
  kind: SessionTask["kind"]
  executionId: string
  cancel(): void
  settled: Promise<TaskSettlement>
}>
