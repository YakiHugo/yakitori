import type { ConnectionRpcGate } from "./connection-gate.ts"

export type RequestSerializationScope =
  | Readonly<{ kind: "global"; name: string }>
  | Readonly<{ kind: "globalSharedRead"; name: string }>
  | Readonly<{ kind: "session"; sessionId: string }>
  | Readonly<{ kind: "process" }>

type SerializationAccess = "exclusive" | "sharedRead"

type QueuedTask = {
  access: SerializationAccess
  task: () => Promise<void>
  gate?: ConnectionRpcGate
}

type QueueState = {
  pending: QueuedTask[]
  runningReads: number
  exclusiveRunning: boolean
}

// Per-key request serialization mirroring Codex's RequestSerializationQueues:
// exclusive tasks for a key run strictly FIFO one at a time; a contiguous run
// of shared reads runs concurrently, and a read arriving during a running
// batch joins it only when no exclusive task is queued ahead of it. Queue
// state for a key exists only while the key holds pending or running work.
export class RequestSerializationQueues {
  private readonly queues = new Map<string, QueueState>()

  enqueue(
    scope: RequestSerializationScope,
    task: () => Promise<void>,
    gate?: ConnectionRpcGate,
  ): void {
    const { key, access } = queueKey(scope)
    let state = this.queues.get(key)
    if (!state) {
      state = { pending: [], runningReads: 0, exclusiveRunning: false }
      this.queues.set(key, state)
    }
    state.pending.push({ access, task, ...(gate ? { gate } : {}) })
    this.schedule(key, state)
  }

  private schedule(key: string, state: QueueState): void {
    for (;;) {
      if (state.exclusiveRunning) return
      const next = state.pending[0]
      if (!next) {
        if (state.runningReads === 0) this.queues.delete(key)
        return
      }
      if (next.access === "exclusive" && state.runningReads > 0) return
      state.pending.shift()
      // A task whose connection closed while it queued is skipped without
      // stalling the queue (Codex drops it unpolled at the gate).
      if (next.gate && !next.gate.isAccepting()) continue
      if (next.access === "exclusive") {
        state.exclusiveRunning = true
        runQueuedTask(next, () => {
          state.exclusiveRunning = false
          this.schedule(key, state)
        })
        return
      }
      state.runningReads += 1
      runQueuedTask(next, () => {
        state.runningReads -= 1
        this.schedule(key, state)
      })
    }
  }
}

// A shared read of a named global resource serializes against exclusive access
// to the same name: reads and writes of one resource share a queue key, with
// reads as the shared-access mode.
function queueKey(scope: RequestSerializationScope): {
  key: string
  access: SerializationAccess
} {
  switch (scope.kind) {
    case "global":
      return { key: `global:${scope.name}`, access: "exclusive" }
    case "globalSharedRead":
      return { key: `global:${scope.name}`, access: "sharedRead" }
    case "session":
      return { key: `session:${scope.sessionId}`, access: "exclusive" }
    case "process":
      return { key: "process", access: "exclusive" }
  }
}

// Tasks own their error reporting; the queue only tracks completion.
function runQueuedTask(queued: QueuedTask, onDone: () => void): void {
  void Promise.resolve()
    .then(() => {
      // schedule() checks the gate at dequeue time, but the task starts on a
      // later microtask; re-check at first poll (Codex's gate.run re-checks
      // under the lock) so a connection closed in between is still skipped
      // without stalling the queue.
      if (queued.gate !== undefined && !queued.gate.isAccepting()) {
        return undefined
      }
      return queued.task()
    })
    .then(onDone, onDone)
}
