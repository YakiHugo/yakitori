import { expect, it } from "vitest"
import { AgentThread } from "../../src/core/agent-thread.ts"
import { Session } from "../../src/core/session.ts"
import {
  createSessionEventReceiver,
  type SessionEvent,
} from "../../src/core/session-io.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { MemoryThreadStore } from "./memory-thread-store.ts"

it("forwards commands and filtered events while retaining local snapshot and termination ownership", async () => {
  const store = new MemoryThreadStore()
  const now = new Date().toISOString()
  const stored = await store.createThread({
    id: "session_ports",
    conversationId: "conversation_ports",
    createdAt: now,
    updatedAt: now,
    workingDirectory: process.cwd(),
    mateId: "mate_test",
    mateRevisionId: "revision_test",
  })
  const session = new Session({
    stored,
    store,
    processor: createTurnProcessor({
      stream: async function* () {
        yield {
          type: "response",
          response: {
            stopReason: "end_turn",
            content: [{ type: "text", text: "done" }],
          },
        }
      },
    }),
  })
  const receiver = session.endpoints.events.transfer()
  const forwarded = createSessionEventReceiver(async () => {
    for (;;) {
      const event = await receiver.receive()
      if (event?.type !== "rollout.appended") return event
    }
  })
  const thread = new AgentThread({
    id: session.id,
    endpoints: {
      ...session.endpoints,
      events: forwarded,
      send: (operation) => session.endpoints.send(operation),
    },
    local: session,
  })
  await expect(session.endpoints.events.receive()).rejects.toThrow(
    "transferred",
  )
  await expect(forwarded.receive()).rejects.toThrow("transferred")
  const snapshot = thread.snapshot()
  Object.assign(snapshot.metadata, { conversationId: "mutated" })
  expect(thread.snapshot().metadata.conversationId).toBe("conversation_ports")
  const content = createUserInput("original")
  const admission = thread.startIfIdle({ content })
  Object.assign(content, { text: "mutated" })
  expect((await admission).type).toBe("started")
  await expect.poll(() => thread.agentStatus).toEqual({ completed: "done" })
  expect(
    thread.snapshot().context.history[0]?.submissionMetadata?.content?.text,
  ).toBe("original")
  const shutdown = thread.shutdownAndWait()
  expect(thread.shutdownAndWait()).toBe(shutdown)
  expect(thread.termination).toBe(shutdown)
  await expect(
    thread.startIfIdle({ content: createUserInput("late") }),
  ).rejects.toThrow("shutting down")
  await shutdown
  const events: SessionEvent[] = []
  for (;;) {
    const event = await thread.nextEvent()
    if (!event) break
    events.push(event)
  }
  expect(
    events.filter((event) => event.type === "turn.completed"),
  ).toHaveLength(1)
  expect(events.some((event) => event.type === "rollout.appended")).toBe(false)
})

it("requires a receiver's pending read to settle before ownership transfer", async () => {
  let deliver!: (event: SessionEvent | undefined) => void
  const receiver = createSessionEventReceiver(
    () =>
      new Promise((resolve) => {
        deliver = resolve
      }),
  )
  const reading = receiver.receive()
  expect(() => receiver.transfer()).toThrow("pending read")
  await expect(receiver.receive()).rejects.toThrow("pending read")
  deliver(undefined)
  await reading
  const transferred = receiver.transfer()
  await expect(receiver.receive()).rejects.toThrow("transferred")
  const next = transferred.receive()
  deliver(undefined)
  await expect(next).resolves.toBeUndefined()
})
