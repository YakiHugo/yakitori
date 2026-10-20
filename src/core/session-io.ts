import type { ModelOutputPresentation } from "../protocol/model-output.ts"
import type { TurnInput } from "../protocol/input-queue.ts"

export type {
  TurnInput,
  InputSource,
  InputPurpose,
} from "../protocol/input-queue.ts"

import type {
  AgentStatus,
  SessionPermissionEvent,
} from "../protocol/permissions.ts"

export type {
  AgentStatus,
  SessionPermissionEvent,
  SessionPermissionReason,
} from "../protocol/permissions.ts"

import type {
  KernelError,
  StartedExecutionItem,
  TurnCompletion,
} from "../kernel/events.ts"
import { InputRole } from "../kernel/events.ts"
import {
  fingerprintInputAdmission,
  fingerprintOperation,
} from "../kernel/operation.ts"
import type { StoredRolloutItem } from "./rollout.ts"

export const SessionStatus = {
  Idle: "idle",
  Active: "active",
  Shutdown: "shutdown",
} as const

export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus]

export type SessionIdleCause = "completed" | "interrupted" | "failed"

export type SubmitTurnInput = Omit<TurnInput, "submissionId"> & {
  readonly submissionId?: string
}

export const NotSubmittedReason = {
  NoActiveTurn: "no_active_turn",
  NotIdle: "not_idle",
  TurnMismatch: "turn_mismatch",
  RequestConflict: "request_conflict",
  TurnFinishing: "turn_finishing",
} as const

export type NotSubmittedReason =
  (typeof NotSubmittedReason)[keyof typeof NotSubmittedReason]

export type TurnInputSubmission =
  | Readonly<{
      type: "started"
      turnId: string
      inputItemId: string
    }>
  | Readonly<{ type: "steered"; turnId: string }>
  | Readonly<{
      type: "replayed"
      turnId: string
      inputItemId: string
    }>
  | Readonly<{
      type: "not_submitted"
      reason: NotSubmittedReason
    }>

export type TurnInputMode =
  | { readonly type: "start_if_idle" }
  | { readonly type: "start_or_steer" }
  | { readonly type: "steer"; readonly expectedTurnId: string }

type TurnInputReply = Readonly<{
  resolve: (submission: TurnInputSubmission) => void
  reject: (error: unknown) => void
}>

export type SessionOp =
  | Readonly<{
      type: "turn_input"
      input: TurnInput
      mode: TurnInputMode
      reply: TurnInputReply
    }>
  | Readonly<{
      type: "compact"
      requestId: string
      reply: TurnInputReply
    }>
  | Readonly<{
      type: "interrupt"
      reason?: string
      expectedTurnId?: string
      reply?: {
        readonly resolve: (interrupted: boolean) => void
        readonly reject: (error: unknown) => void
      }
    }>
  | Readonly<{
      type: "fail_agent"
      message: string
      reply: {
        readonly resolve: (status: AgentStatus) => void
        readonly reject: (error: unknown) => void
      }
    }>
  | Readonly<{
      type: "agent_message"
      messageId: string
      text: string
      reply: {
        readonly resolve: () => void
        readonly reject: (error: unknown) => void
      }
    }>
  | Readonly<{ type: "shutdown" }>

export type SessionEvent =
  | Readonly<{
      type: "rollout.appended"
      threadId: string
      throughSeq: number
      records: readonly StoredRolloutItem[]
    }>
  | (ModelOutputPresentation &
      Readonly<{
        type: "model.stream"
        threadId: string
        turnId: string
        itemId: string
        kind: "assistant" | "reasoning"
        delta: string
      }>)
  | Readonly<{
      type: "item.started"
      threadId: string
      turnId: string
      item: StartedExecutionItem
    }>
  | Readonly<{
      type: "permission"
      threadId: string
      event: SessionPermissionEvent
    }>
  | Readonly<{
      type: "turn.started"
      threadId: string
      input: TurnInput
    }>
  | Readonly<{
      type: "turn.completed"
      threadId: string
      input: TurnInput
      completion?: TurnCompletion
    }>
  | Readonly<{
      type: "turn.interrupted"
      threadId: string
      input: TurnInput
      reason?: string
    }>
  | Readonly<{
      type: "turn.failed"
      threadId: string
      input: TurnInput
      error: KernelError
    }>
  | Readonly<{
      type: "session.error"
      threadId: string
      operation: "turn_input" | "interrupt" | "persistence"
      message: string
    }>
  | Readonly<{
      type: "runtime.warning"
      threadId: string
      turnId: string
      message: string
      code?: string
      details?: import("../kernel/index.ts").EventMetadata
    }>

export type SessionEndpoints = Readonly<{
  send(operation: Exclude<SessionOp, { type: "shutdown" }>): Promise<void>
  events: SessionEventReceiver
  readStatus(): SessionStatus
  subscribeStatus(
    listener: (status: SessionStatus, idleCause?: SessionIdleCause) => void,
  ): () => void
  readAgentStatus(): AgentStatus
  subscribeAgentStatus(listener: (status: AgentStatus) => void): () => void
  shutdown(): Promise<void>
  termination: Promise<void>
}>

export type SessionEventReceiver = Readonly<{
  receive(): Promise<SessionEvent | undefined>
  transfer(): SessionEventReceiver
}>

// A transfer revokes the old endpoint, including aliases to it. Filters and
// delegates own the transferred receiver; the queue is never a broadcast.
export function createSessionEventReceiver(
  receive: () => Promise<SessionEvent | undefined>,
): SessionEventReceiver {
  let owned = true
  let reading = false
  return {
    receive() {
      if (!owned)
        return Promise.reject(
          new Error("Session event receiver was transferred."),
        )
      if (reading)
        return Promise.reject(
          new Error("Session event receiver already has a pending read."),
        )
      reading = true
      return receive().finally(() => {
        reading = false
      })
    },
    transfer() {
      if (!owned) throw new Error("Session event receiver was transferred.")
      if (reading)
        throw new Error(
          "Cannot transfer a Session event receiver with a pending read.",
        )
      owned = false
      return createSessionEventReceiver(receive)
    },
  }
}

export class AsyncQueue<T> {
  #items: T[] = []
  #head = 0
  readonly #receivers: Array<(value: T | undefined) => void> = []
  #closed = false

  send(value: T): void {
    if (this.#closed) return
    const receiver = this.#receivers.shift()
    if (receiver === undefined) this.#items.push(value)
    else receiver(value)
  }

  receive(): Promise<T | undefined> {
    if (this.#head < this.#items.length) {
      const item = this.#items[this.#head]
      this.#head += 1
      if (this.#head === this.#items.length) {
        this.#items = []
        this.#head = 0
      } else if (this.#head > 1024 && this.#head * 2 >= this.#items.length) {
        this.#items = this.#items.slice(this.#head)
        this.#head = 0
      }
      return Promise.resolve(item)
    }
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
  readonly #senders: Array<
    Readonly<{
      value: T
      resolve: () => void
      reject: (error: Error) => void
    }>
  > = []
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

export function fingerprintTurnInput(input: TurnInput): string {
  const fingerprint = fingerprintInputAdmission({
    role:
      input.goalId === undefined && input.provenance === undefined
        ? InputRole.User
        : InputRole.Runtime,
    ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
    content: input.content,
    ...(input.modelSelection === undefined
      ? {}
      : { modelSelection: input.modelSelection }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.parentInputId === undefined
      ? {}
      : { parentInputId: input.parentInputId }),
  })
  if (input.goalId !== undefined)
    return fingerprintOperation({ goalId: input.goalId, input: fingerprint })
  return input.manualCompact === true ? `compact:${fingerprint}` : fingerprint
}
