import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import { ModelStopReason, type StreamFn } from "../../src/runtime/model.ts"
import { createYakitoriApplication } from "../../src/server/application.ts"

const done = {
  stopReason: ModelStopReason.EndTurn,
  content: [{ type: "text" as const, text: "Done" }],
}

it.each([
  "admitInput",
  "admitQuestionAnswer",
] as const)("%s routes active input into the current turn and preserves its model choice without queueing", async (method) => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-input-active-"))
  const sampling = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const observed: Array<{ model: string; text: string[] }> = []
  const stream: StreamFn = async function* (request) {
    observed.push({
      model: request.target.model,
      text: request.messages.flatMap((message) =>
        message.role === "user"
          ? message.content.flatMap((block) =>
              block.type === "text" ? [block.text] : [],
            )
          : [],
      ),
    })
    if (observed.length === 1) {
      sampling.resolve()
      await release.promise
    }
    yield { type: "response", response: done }
  }
  const options = {
    rootDir: join(root, "state"),
    workspace: root,
    userConfigPath: join(root, "config.toml"),
    provider: "faux",
    model: "initial-model",
    stream,
  }
  const app = await createYakitoriApplication(options)
  try {
    const created = await app.handlers.createSession({})
    if (!created.ok) throw new Error(created.error.message)
    const sessionId = created.value.session.id
    const initial = await app.handlers.admitInput({
      sessionId,
      requestId: "initial",
      content: createUserInput("Start"),
    })
    expect(initial).toMatchObject({
      ok: true,
      value: { turnId: "initial", inputId: expect.any(String) },
    })
    await sampling.promise
    const submitted = await app.handlers[method]({
      sessionId,
      requestId: "direction",
      content: createUserInput("Use this direction"),
      modelSelection: { provider: "faux", model: "selected-model" },
      metadata: { userQuestionId: "question_location" },
    })
    expect(submitted).toMatchObject({
      ok: true,
      value: {
        requestId: "direction",
        turnId: "initial",
        content: createUserInput("Use this direction"),
      },
    })
    if (submitted.ok) expect(submitted.value).not.toHaveProperty("inputId")
    expect(await app.handlers.listQueuedInputs({ sessionId })).toMatchObject({
      ok: true,
      value: { items: [] },
    })
    release.resolve()
    await vi.waitFor(() =>
      expect(app.threadManager.getThread(sessionId)?.status).toBe("idle"),
    )
    expect(observed).toMatchObject([
      { model: "initial-model", text: expect.arrayContaining(["Start"]) },
      {
        text: expect.arrayContaining(["Start", "Use this direction"]),
      },
    ])
    expect(await app.handlers.readSession({ sessionId })).toMatchObject({
      ok: true,
      value: {
        session: {
          currentModel: { provider: "faux", model: "selected-model" },
        },
      },
    })
    const stored = await app.threadStore.readThread(sessionId)
    expect(
      stored?.rollout.filter(({ item }) => item.type === "turn_started"),
    ).toHaveLength(1)
    expect(
      stored?.rollout
        .filter(
          ({ item }) =>
            item.type === "response_item" && item.item.turnId === "direction",
        )
        .map(({ item }) => item),
    ).toEqual([
      expect.objectContaining({
        type: "response_item",
        item: expect.objectContaining({
          submissionMetadata: expect.objectContaining({
            source: "human",
            purpose: method === "admitInput" ? "message" : "question_answer",
            modelSelection: { provider: "faux", model: "selected-model" },
            metadata: { userQuestionId: "question_location" },
          }),
        }),
      }),
    ])
  } finally {
    release.resolve()
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

it("waits for durable completion before starting direct input and treats each ordinary send as new input", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-input-handoff-"))
  const finishing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const stream: StreamFn = async function* () {
    yield { type: "response", response: done }
  }
  const app = await createYakitoriApplication({
    rootDir: join(root, "state"),
    workspace: root,
    userConfigPath: join(root, "config.toml"),
    provider: "faux",
    model: "scripted",
    stream,
  })
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
      content: createUserInput("Start"),
    })
    await finishing.promise
    const thread = app.threadManager.getThread(sessionId)
    if (!thread) throw new Error("Missing session")
    const route = vi.spyOn(thread, "startOrSteer")
    const next = {
      sessionId,
      requestId: "next",
      content: createUserInput("Continue"),
    }
    const admission = app.handlers.admitInput(next)
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(1))
    expect(await route.mock.results[0]?.value).toMatchObject({
      type: "not_submitted",
      reason: "turn_finishing",
    })
    release.resolve()
    expect(await admission).toMatchObject({
      ok: true,
      value: { requestId: "next", turnId: "next", inputId: expect.any(String) },
    })
    await vi.waitFor(() => expect(thread.status).toBe("idle"))
    expect(await app.handlers.admitInput(next)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    })
    expect(
      await app.handlers.admitInput({ ...next, requestId: "another" }),
    ).toMatchObject({
      ok: true,
      value: { requestId: "another", turnId: "another" },
    })
    await vi.waitFor(() => expect(thread.status).toBe("idle"))
    expect(await app.handlers.listQueuedInputs({ sessionId })).toMatchObject({
      ok: true,
      value: { items: [] },
    })
    const stored = await app.threadStore.readThread(sessionId)
    const lifecycle = stored?.rollout.flatMap(({ item }) =>
      item.type === "turn_started" || item.type === "turn_completed"
        ? [`${item.type}:${item.turnId}`]
        : [],
    )
    expect(lifecycle).toEqual([
      "turn_started:initial",
      "turn_completed:initial",
      "turn_started:next",
      "turn_completed:next",
      "turn_started:another",
      "turn_completed:another",
    ])
    await app.close()
    const recovered = await new JsonlThreadStore({
      root: app.sessionStoreRoot,
    }).readThread(sessionId)
    expect(
      recovered?.rollout.flatMap(({ item }) =>
        item.type === "turn_started" || item.type === "turn_completed"
          ? [`${item.type}:${item.turnId}`]
          : [],
      ),
    ).toEqual(lifecycle)
  } finally {
    release.resolve()
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
