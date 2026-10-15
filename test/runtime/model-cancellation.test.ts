import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { expect, it, onTestFinished } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { SessionStatus } from "../../src/core/session-io.ts"
import { TaskCleanupError } from "../../src/core/session-task.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import type { ModelStreamEvent, StreamFn } from "../../src/runtime/model.ts"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createModelRequestStream } from "../../src/runtime/model-request.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"

it.each([
  { ownership: "injected", failure: false },
  { ownership: "client", failure: false },
  { ownership: "injected", failure: true },
  { ownership: "client", failure: true },
])("retains $ownership execution until cancelled inference cleanup settles (failure=$failure)", async ({
  ownership,
  failure,
}) => {
  const fixture = await inferenceFixture({ ownership, failure })
  await fixture.thread.startIfIdle({
    submissionId: "cancelled_turn",
    content: createUserInput("request inference"),
  })
  await fixture.requested
  await fixture.thread.interrupt()
  await fixture.stopping
  await fixture.disconnected
  await setImmediate()

  expect(fixture.thread.status).toBe(SessionStatus.Active)
  expect(
    await fixture.thread.startIfIdle({ content: createUserInput("next") }),
  ).toEqual({
    type: "not_submitted",
    reason: "not_idle",
  })
  expect(
    (await fixture.store.readThread(fixture.thread.id))?.rollout.filter(
      ({ item }) => item.type === "turn_completed",
    ),
  ).toEqual([])
  expect(() => process.kill(fixture.child.pid ?? 0, 0)).not.toThrow()

  fixture.release()
  await fixture.closed
  if (failure) {
    await expect
      .poll(() => fixture.thread.agentStatus)
      .toEqual({
        errored: "Task resource cleanup failed; the Session remains occupied.",
      })
    expect(fixture.thread.status).toBe(SessionStatus.Active)
    expect(
      (await fixture.store.readThread(fixture.thread.id))?.rollout.filter(
        ({ item }) => item.type === "turn_completed",
      ),
    ).toEqual([])
  } else {
    await expect.poll(() => fixture.thread.status).toBe(SessionStatus.Idle)
    expect(
      (await fixture.store.readThread(fixture.thread.id))?.rollout.filter(
        ({ item }) => item.type === "turn_completed",
      ),
    ).toMatchObject([
      { item: { turnId: "cancelled_turn", outcome: "interrupted" } },
    ])
    await fixture.manager.shutdown()
    const restarted = new ThreadManager({
      store: fixture.store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: fixture.stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    onTestFinished(() => restarted.shutdown())
    expect((await restarted.resumeThread(fixture.thread.id))?.agentStatus).toBe(
      "interrupted",
    )
  }
  expect(fixture.requests()).toBe(1)
})

it("waits for the timed-out inference resource to exit before opening another HTTP attempt", async () => {
  const fixture = await inferenceFixture({
    ownership: "client",
    failure: false,
    timeout: true,
  })
  await fixture.thread.startIfIdle({
    content: createUserInput("request inference"),
  })
  await fixture.stopping
  await fixture.disconnected
  await setImmediate()
  expect(fixture.requests()).toBe(1)
  expect(fixture.attempts()).toBe(1)
  expect(fixture.thread.status).toBe(SessionStatus.Active)
  fixture.release()
  await fixture.closed
  await expect.poll(() => fixture.thread.status).toBe(SessionStatus.Idle)
  expect(fixture.requests()).toBe(2)
  expect(fixture.thread.agentStatus).toEqual({ completed: "finished" })
  expect(
    (await fixture.store.readThread(fixture.thread.id))?.rollout.filter(
      ({ item }) => item.type === "turn_completed",
    ),
  ).toMatchObject([{ item: { outcome: "completed" } }])
})

async function inferenceFixture(options: {
  ownership: string
  failure: boolean
  timeout?: boolean
}) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-model-cancellation-"))
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      if (line === 'stop') process.stdout.write('stopping\\n');
      if (line === 'release') process.exit(0);
    });
    process.stdout.write('ready\\n');
  `,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  )
  const closed = once(child, "close")
  const ready = Promise.withResolvers<void>()
  const stopping = Promise.withResolvers<void>()
  let output = ""
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString()
    if (output.includes("ready\n")) ready.resolve()
    if (output.includes("stopping\n")) stopping.resolve()
  })
  await ready.promise
  let requests = 0
  const requested = Promise.withResolvers<void>()
  const disconnected = Promise.withResolvers<void>()
  const server = createServer((request, response) => {
    request.resume()
    requests += 1
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    if (requests === 1) {
      response.on("close", () => disconnected.resolve())
      response.write(
        'data: {"id":"first","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
      )
      requested.resolve()
    } else {
      response.end(
        'data: {"id":"second","choices":[{"index":0,"delta":{"content":"finished"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      )
    }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new Error("Missing test endpoint")
  const raw = createChatCompletionsProvider({
    apiKey: "local-test-only",
    model: "scripted",
    baseURL: `http://127.0.0.1:${address.port}/v1`,
  })
  let attempts = 0
  const rawStream: StreamFn = (request) => {
    const ownsChild = ++attempts === 1
    const iterator = raw(request)[Symbol.asyncIterator]()
    let closing: Promise<IteratorResult<ModelStreamEvent>> | undefined
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => iterator.next(),
          return() {
            closing ??= (async () => {
              await iterator.return?.()
              if (ownsChild) {
                child.stdin.write("stop\n")
                await closed
                if (options.failure)
                  throw new Error("Inference cleanup failed after exit")
              }
              return { done: true, value: undefined }
            })()
            return closing
          },
        }
      },
    }
  }
  const requestOptions = {
    maxAttempts: 2,
    streamIdleTimeoutMs: options.timeout ? 30 : 10_000,
    streamCleanupTimeoutMs: 5_000,
    sleep: async () => {},
  }
  const stream = createModelRequestStream(rawStream, {
    ...requestOptions,
    wireApi: "openai_chat_completions",
  })
  const store = new JsonlThreadStore({ root: join(root, "store") })
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () =>
      createTurnProcessor({
        ...(options.ownership === "injected"
          ? { stream }
          : {
              modelClient: createProviderRegistry({
                faux: createModelProvider({
                  info: {
                    id: "faux",
                    wireApi: "openai_chat_completions",
                    capabilities: { remoteCompaction: false },
                    streamIdleTimeoutMs: requestOptions.streamIdleTimeoutMs,
                    retry: requestOptions,
                  },
                  stream: rawStream,
                }),
              }).createClient(),
            }),
        toolRegistry: createToolRegistry([]),
        loadProjectInstructions: async () => undefined,
      }),
  })
  onTestFinished(async () => {
    child.kill("SIGKILL")
    await closed
    try {
      await manager.shutdown().catch((error: unknown) => {
        if (!(options.failure && error instanceof TaskCleanupError)) throw error
      })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await rm(root, { recursive: true, force: true })
    }
  })
  const thread = await manager.createThread({
    workingDirectory: root,
    mateId: "mate_test",
    mateRevisionId: "revision_test",
  })
  return {
    manager,
    thread,
    store,
    stream,
    child,
    closed,
    stopping: stopping.promise,
    requested: requested.promise,
    disconnected: disconnected.promise,
    requests: () => requests,
    attempts: () => attempts,
    release: () => child.stdin.write("release\n"),
  }
}
