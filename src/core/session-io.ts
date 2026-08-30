import type {
  StartedExecutionItem,
  EventMetadata,
  ModelSelection,
  TextContent,
} from "../kernel/events.ts"
import { createRequestId } from "../kernel/ids.ts"
import type { RolloutItem } from "./rollout.ts"

export const SessionStatus = {
  Idle: "idle",
  Active: "active",
  Shutdown: "shutdown",
} as const

export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus]

export type TurnInput = {
  readonly submissionId: string
  readonly content: TextContent
  readonly modelSelection?: ModelSelection
  readonly metadata?: EventMetadata
  readonly parentInputId?: string
}

export type SubmitTurnInput = Omit<TurnInput, "submissionId"> & {
  readonly submissionId?: string
}

export const NotSubmittedReason = {
  NoActiveTurn: "no_active_turn",
  NotIdle: "not_idle",
  TurnMismatch: "turn_mismatch",
  RequestConflict: "request_conflict",
} as const

export type NotSubmittedReason =
  (typeof NotSubmittedReason)[keyof typeof NotSubmittedReason]

export type TurnInputSubmission =
  | { readonly type: "started"; readonly turnId: string }
  | { readonly type: "steered"; readonly turnId: string }
  | {
      readonly type: "replayed"
      readonly turnId: string
      readonly inputItemId: string
    }
  | {
      readonly type: "not_submitted"
      readonly reason: NotSubmittedReason
    }

export type SessionPermissionReason = {
  readonly kind: string
  readonly message?: string
}

export type SessionPermissionEvent =
  | {
      readonly type: "permission.requested"
      readonly permissionRequestId: string
      readonly sessionId: string
      readonly turnId: string
      readonly toolCallId: string
      readonly action: string
      readonly subject?: string
      readonly reason?: string
      readonly createdAt: string
    }
  | {
      readonly type: "permission.resolved"
      readonly permissionRequestId: string
      readonly sessionId: string
      readonly turnId: string
      readonly outcome: "allow" | "deny" | "timeout" | "aborted"
      readonly reason?: SessionPermissionReason
      readonly createdAt: string
    }

export type TurnInputMode =
  | { readonly type: "start_or_steer" }
  | { readonly type: "start_if_idle" }
  | { readonly type: "steer"; readonly expectedTurnId: string }

type TurnInputReply = {
  readonly resolve: (submission: TurnInputSubmission) => void
  readonly reject: (error: unknown) => void
}

export type SessionOp =
  | {
      readonly type: "turn_input"
      readonly input: TurnInput
      readonly mode: TurnInputMode
      readonly reply: TurnInputReply
    }
  | {
      readonly type: "interrupt"
      readonly reason?: string
      readonly expectedTurnId?: string
      readonly reply?: {
        readonly resolve: (interrupted: boolean) => void
        readonly reject: (error: unknown) => void
      }
    }
  | { readonly type: "shutdown" }

export type SessionEvent =
  | {
      readonly type: "rollout.appended"
      readonly threadId: string
      readonly throughSeq: number
      readonly items: readonly RolloutItem[]
    }
  | {
      readonly type: "model.stream"
      readonly threadId: string
      readonly turnId: string
      readonly itemId: string
      readonly kind: "assistant" | "reasoning"
      readonly text: string
    }
  | {
      readonly type: "item.started"
      readonly threadId: string
      readonly turnId: string
      readonly item: StartedExecutionItem
    }
  | {
      readonly type: "permission"
      readonly threadId: string
      readonly event: SessionPermissionEvent
    }
  | {
      readonly type: "turn.started"
      readonly threadId: string
      readonly input: TurnInput
    }
  | {
      readonly type: "turn.completed"
      readonly threadId: string
      readonly input: TurnInput
    }
  | {
      readonly type: "turn.interrupted"
      readonly threadId: string
      readonly input: TurnInput
      readonly reason?: string
    }
  | {
      readonly type: "session.error"
      readonly threadId: string
      readonly operation: "turn_input" | "interrupt" | "persistence"
      readonly message: string
    }

export class SessionIo {
  readonly #send: (operation: SessionOp) => Promise<void>
  readonly #events: AsyncQueue<SessionEvent>
  readonly #beforeShutdown: () => void
  readonly #readStatus: () => SessionStatus
  readonly #subscribeStatus: (
    listener: (status: SessionStatus) => void,
  ) => () => void
  readonly termination: Promise<void>
  #accepting = true

  constructor(input: {
    send: (operation: SessionOp) => Promise<void>
    beforeShutdown: () => void
    events: AsyncQueue<SessionEvent>
    readStatus: () => SessionStatus
    subscribeStatus: (listener: (status: SessionStatus) => void) => () => void
    termination: Promise<void>
  }) {
    this.#send = input.send
    this.#beforeShutdown = input.beforeShutdown
    this.#events = input.events
    this.#readStatus = input.readStatus
    this.#subscribeStatus = input.subscribeStatus
    this.termination = input.termination
  }

  get status(): SessionStatus {
    return this.#readStatus()
  }

  subscribeStatus(listener: (status: SessionStatus) => void): () => void {
    return this.#subscribeStatus(listener)
  }

  startOrSteer(input: SubmitTurnInput): Promise<TurnInputSubmission> {
    return this.#submitTurnInput(input, { type: "start_or_steer" })
  }

  startIfIdle(input: SubmitTurnInput): Promise<TurnInputSubmission> {
    return this.#submitTurnInput(input, { type: "start_if_idle" })
  }

  steer(
    input: SubmitTurnInput,
    expectedTurnId: string,
  ): Promise<TurnInputSubmission> {
    return this.#submitTurnInput(input, { type: "steer", expectedTurnId })
  }

  async interrupt(reason?: string): Promise<void> {
    this.#requireOpen()
    await this.#send({
      type: "interrupt",
      ...(reason === undefined ? {} : { reason }),
    })
  }

  async interruptTurn(
    expectedTurnId: string,
    reason?: string,
  ): Promise<boolean> {
    this.#requireOpen()
    return new Promise((resolve, reject) => {
      void this.#send({
        type: "interrupt",
        expectedTurnId,
        ...(reason === undefined ? {} : { reason }),
        reply: { resolve, reject },
      }).catch(reject)
    })
  }

  async shutdownAndWait(): Promise<void> {
    if (!this.#accepting) {
      await this.termination
      return
    }
    this.#accepting = false
    this.#beforeShutdown()
    await this.#send({ type: "shutdown" })
    await this.termination
  }

  nextEvent(): Promise<SessionEvent | undefined> {
    return this.#events.receive()
  }

  async #submitTurnInput(
    input: SubmitTurnInput,
    mode: TurnInputMode,
  ): Promise<TurnInputSubmission> {
    this.#requireOpen()
    const turnInput: TurnInput = {
      submissionId: input.submissionId ?? createRequestId(),
      content: input.content,
      ...(input.modelSelection === undefined
        ? {}
        : { modelSelection: input.modelSelection }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.parentInputId === undefined
        ? {}
        : { parentInputId: input.parentInputId }),
    }
    return new Promise((resolve, reject) => {
      void this.#send({
        type: "turn_input",
        input: turnInput,
        mode,
        reply: { resolve, reject },
      }).catch(reject)
    })
  }

  #requireOpen(): void {
    if (!this.#accepting) throw new Error("Session is shutting down.")
  }
}

export class AsyncQueue<T> {
  readonly #items: T[] = []
  readonly #receivers: Array<(value: T | undefined) => void> = []
  #closed = false

  send(value: T): void {
    if (this.#closed) return
    const receiver = this.#receivers.shift()
    if (receiver === undefined) this.#items.push(value)
    else receiver(value)
  }

  receive(): Promise<T | undefined> {
    const item = this.#items.shift()
    if (item !== undefined) return Promise.resolve(item)
    if (this.#closed) return Promise.resolve(undefined)
    return new Promise((resolve) => this.#receivers.push(resolve))
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const receiver of this.#receivers.splice(0)) receiver(undefined)
  }
}

export class BoundedQueue<T> {
  readonly #capacity: number
  readonly #items: T[] = []
  readonly #receivers: Array<(value: T | undefined) => void> = []
  readonly #senders: Array<{
    readonly value: T
    readonly resolve: () => void
    readonly reject: (error: Error) => void
  }> = []
  #closed = false

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError("Queue capacity must be a positive integer.")
    }
    this.#capacity = capacity
  }

  send(value: T): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Queue is closed."))
    const receiver = this.#receivers.shift()
    if (receiver !== undefined) {
      receiver(value)
      return Promise.resolve()
    }
    if (this.#items.length < this.#capacity) {
      this.#items.push(value)
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      this.#senders.push({ value, resolve, reject })
    })
  }

  receive(): Promise<T | undefined> {
    const item = this.#items.shift()
    if (item !== undefined) {
      this.#admitSender()
      return Promise.resolve(item)
    }
    const sender = this.#senders.shift()
    if (sender !== undefined) {
      sender.resolve()
      return Promise.resolve(sender.value)
    }
    if (this.#closed) return Promise.resolve(undefined)
    return new Promise((resolve) => this.#receivers.push(resolve))
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const sender of this.#senders.splice(0)) {
      sender.reject(new Error("Queue is closed."))
    }
    for (const receiver of this.#receivers.splice(0)) receiver(undefined)
  }

  #admitSender(): void {
    const sender = this.#senders.shift()
    if (sender === undefined) return
    this.#items.push(sender.value)
    sender.resolve()
  }
}
