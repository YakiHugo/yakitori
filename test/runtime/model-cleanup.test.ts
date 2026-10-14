import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, onTestFinished } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { SessionStatus } from "../../src/core/session-io.ts"
import { TaskCleanupError } from "../../src/core/session-task.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import {
  createModelRequestStream,
  ModelStreamCleanupError,
} from "../../src/runtime/model-request.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"

it.each([
  "injected",
  "client",
])("does not retry HTTP inference or release $0 execution after model stream cleanup fails", async (ownership) => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-model-cleanup-"))
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  })
  const closed = once(child, "close")
  await once(child, "spawn")
  let requests = 0
  const server = createServer((request, response) => {
    request.resume()
    requests += 1
    response.writeHead(503, { "Content-Type": "application/json" })
    response.end(
      JSON.stringify({ error: { message: "Try again", type: "server_error" } }),
    )
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
  const cleanupFailure = new Error("Model-owned process could not close")
  const stream = createModelRequestStream(
    async function* (request) {
      try {
        yield* raw(request)
      } finally {
        // biome-ignore lint/correctness/noUnsafeFinally: Model a failed iterator resource teardown.
        throw cleanupFailure
      }
    },
    {
      wireApi: "openai_chat_completions",
      maxAttempts: 3,
      sleep: async () => {},
    },
  )
  const store = new JsonlThreadStore({ root: join(root, "store") })
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () =>
      createTurnProcessor({
        ...(ownership === "injected"
          ? { stream }
          : {
              modelClient: createProviderRegistry({
                faux: stream,
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
        if (
          !(
            error instanceof TaskCleanupError &&
            error.cause instanceof ModelStreamCleanupError
          )
        )
          throw error
      })
    } finally {
      const stopped = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      server.closeAllConnections()
      await stopped
      await rm(root, { recursive: true, force: true })
    }
  })
  const thread = await manager.createThread({
    workingDirectory: root,
    mateId: "mate_test",
    mateRevisionId: "revision_test",
  })
  await thread.startIfIdle({
    submissionId: "model_cleanup_turn",
    content: createUserInput("request inference"),
  })
  await expect
    .poll(() => thread.agentStatus)
    .toEqual({
      errored: "Task resource cleanup failed; the Session remains occupied.",
    })
  expect(requests).toBe(1)
  expect(thread.status).toBe(SessionStatus.Active)
  expect(() => process.kill(child.pid ?? 0, 0)).not.toThrow()
  expect(
    await thread.startIfIdle({ content: createUserInput("next") }),
  ).toEqual({
    type: "not_submitted",
    reason: "not_idle",
  })
  const stored = await store.readThread(thread.id)
  expect(
    stored?.rollout.filter(({ item }) => item.type === "turn_completed"),
  ).toEqual([])
})
