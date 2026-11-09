import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { ModelStopReason, type StreamFn } from "../../src/runtime/model.ts"
import { createYakitoriApplication } from "../../src/server/application.ts"
import {
  createElicitationBroker,
  createSessionInteractions,
} from "../../src/server/user-interactions.ts"
import { inputFixture } from "../fixtures/user-input.ts"

const ask = {
  stopReason: ModelStopReason.ToolUse,
  content: [
    {
      type: "tool_call" as const,
      id: "ask_location",
      name: "request_user_input_async",
      input: {
        questions: [{ title: "Where?", options: ["Workspace", "Downloads"] }],
      },
    },
  ],
}
const done = {
  stopReason: ModelStopReason.EndTurn,
  content: [{ type: "text" as const, text: "Done" }],
}

it.each([
  "boundary",
  "preempt",
] as const)("accepts and deduplicates an answer during %s sampling and replays it after restart", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-question-active-"))
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let calls = 0
  let aborted = false
  const observed: string[] = []
  const stream: StreamFn = async function* (request) {
    calls++
    if (calls === 2) {
      entered.resolve()
      if (mode === "preempt") {
        const signal = request.signal
        if (!signal) throw new Error("Missing model cancellation signal")
        const cancelled = Promise.withResolvers<void>()
        const onAbort = () => {
          aborted = true
          cancelled.resolve()
        }
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) onAbort()
        await Promise.race([release.promise, cancelled.promise])
        signal.removeEventListener("abort", onAbort)
        if (aborted) {
          yield { type: "cancelled" }
          return
        }
      } else {
        await release.promise
      }
    }
    if (calls === 3) {
      observed.push(
        ...request.messages.flatMap((message) =>
          message.role === "user"
            ? message.content.flatMap((block) =>
                block.type === "text" && block.text.startsWith("Where?")
                  ? [block.text]
                  : [],
              )
            : [],
        ),
      )
    }
    yield { type: "response", response: calls === 1 ? ask : done }
  }
  const options = {
    rootDir: join(root, "state"),
    workspace: root,
    userConfigPath: join(root, "config.toml"),
    provider: "faux",
    model: "scripted",
    stream,
  }
  let app = await createYakitoriApplication(options)
  const broker = createElicitationBroker()
  try {
    const created = await app.handlers.createSession({})
    if (!created.ok) throw new Error(created.error.message)
    const sessionId = created.value.session.id
    await app.handlers.admitInput({
      sessionId,
      requestId: "initial",
      content: inputFixture([{ type: "text", text: "Ask me" }]),
    })
    await entered.promise
    const service = createSessionInteractions(
      app.threadStore,
      app.handlers,
      broker,
    )
    const params = {
      sessionId,
      toolCallId: "ask_location",
      answers: ["Workspace"],
    }
    const [first, retry] = await Promise.all([
      service.answer(params),
      service.answer(params),
    ])
    expect(first.ok).toBe(true)
    expect(retry).toMatchObject(first)
    if (!first.ok) throw new Error(first.error.message)
    expect(first.value.turnId).toBe("initial")
    expect(
      await service.answer({ ...params, answers: ["Downloads"] }),
    ).toMatchObject({ ok: false })
    if (mode === "preempt") {
      // Do not release the old response: the answer itself must cancel it and
      // enter another model request containing the new direction.
      await vi.waitFor(() => {
        expect(aborted).toBe(true)
        expect(calls).toBe(3)
      })
    } else {
      release.resolve()
    }
    await vi.waitFor(() =>
      expect(app.threadManager.getThread(sessionId)?.status).toBe("idle"),
    )
    expect(observed).toEqual(["Where?\nWorkspace"])
    const recorded = await service.answer(params)
    expect(recorded).toMatchObject({ ok: true, value: first.value })
    const stored = await app.threadStore.readThread(sessionId)
    expect(
      stored?.rollout.filter(
        ({ item }) =>
          item.type === "response_item" &&
          item.item.submissionMetadata?.metadata?.userQuestionId ===
            "ask_location",
      ),
    ).toHaveLength(1)
    await app.close()
    app = await createYakitoriApplication(options)
    expect(
      await createSessionInteractions(
        app.threadStore,
        app.handlers,
        broker,
      ).answer(params),
    ).toEqual(recorded)
    expect(calls).toBe(3)
  } finally {
    release.resolve()
    broker.close()
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

it("hands an answer across a finishing turn without a busy rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-question-finishing-"))
  const finishing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let calls = 0
  const stream: StreamFn = async function* () {
    calls++
    yield { type: "response", response: calls === 1 ? ask : done }
  }
  const app = await createYakitoriApplication({
    rootDir: join(root, "state"),
    workspace: root,
    userConfigPath: join(root, "config.toml"),
    provider: "faux",
    model: "scripted",
    stream,
  })
  const broker = createElicitationBroker()
  const append = app.threadStore.appendItems.bind(app.threadStore)
  vi.spyOn(app.threadStore, "appendItems").mockImplementation(
    async (threadId, items) => {
      if (
        items.some(
          (item) => item.type === "turn_completed" && item.turnId === "initial",
        )
      ) {
        finishing.resolve()
        await release.promise
      }
      return append(threadId, items)
    },
  )
  try {
    const created = await app.handlers.createSession({})
    if (!created.ok) throw new Error(created.error.message)
    const sessionId = created.value.session.id
    await app.handlers.admitInput({
      sessionId,
      requestId: "initial",
      content: inputFixture([{ type: "text", text: "Ask me" }]),
    })
    await finishing.promise
    const thread = app.threadManager.getThread(sessionId)
    if (!thread) throw new Error("Missing session")
    const route = vi.spyOn(thread, "startOrSteer")
    const result = createSessionInteractions(
      app.threadStore,
      app.handlers,
      broker,
    ).answer({ sessionId, toolCallId: "ask_location", answers: ["Workspace"] })
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(1))
    expect(await route.mock.results[0]?.value).toMatchObject({
      type: "not_submitted",
      reason: "turn_finishing",
    })
    release.resolve()
    expect(await result).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(thread.status).toBe("idle"))
    expect(calls).toBe(3)
    const stored = await app.threadStore.readThread(sessionId)
    expect(
      stored?.rollout.filter(
        ({ item }) =>
          item.type === "response_item" &&
          item.item.submissionMetadata?.metadata?.userQuestionId ===
            "ask_location",
      ),
    ).toHaveLength(1)
  } finally {
    release.resolve()
    broker.close()
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
