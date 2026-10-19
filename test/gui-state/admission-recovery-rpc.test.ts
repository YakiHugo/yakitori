import { inputFixture } from "../fixtures/user-input.ts"
import { bindExecution } from "../support/session-execution.ts"
import "./setup-store-environment.ts"
import { afterEach, expect, it, vi } from "vitest"
import type { ContextExcerpt } from "../../src/core/input-context.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createExecutionViewState } from "../../src/gui/execution-view.ts"
import { inputRecoveryMemory } from "../../src/gui/input-recovery-memory.ts"
import { ApiRequestError } from "../../src/gui/lib/rpc-client.ts"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import { createSessionExecutionPolicy } from "../../src/runtime/limits.ts"
import { createSessionEventHub } from "../../src/server/event-hub.ts"
import { createThreadServerHandlers } from "../../src/server/handlers.ts"
import { MessageProcessor } from "../../src/server/rpc/message-processor.ts"
import { MemoryThreadStore } from "../core/memory-thread-store.ts"
import { FakeRpcClient } from "../gui/fake-rpc-client.ts"
import { inputParts } from "../gui/input-fixtures.ts"
import {
  initializeConnection,
  openTestConnection,
} from "../server/rpc/testkit.ts"

const fakeRef = vi.hoisted(() => ({
  current: undefined as unknown as FakeRpcClient,
}))

vi.mock("../../src/gui/lib/rpc-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/gui/lib/rpc-client.ts")>()),
  getAppRpcClient: () => fakeRef.current,
}))

afterEach(() => {
  inputRecoveryMemory.clear()
  useAppStore.setState(createInitialAppState())
})

it("reconciles a committed queued input by ID without resending after its RPC acknowledgment is lost", async () => {
  const store = new MemoryThreadStore()
  let release!: () => void
  const completion = new Promise<void>((resolve) => {
    release = resolve
  })
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () => ({
      createTask(snapshot, input) {
        const context = ((_snapshot, input) => {
          const selection = { provider: "faux", model: "scripted" }
          return {
            turnId: input.submissionId,
            selection,
            configuration: {
              schemaVersion: 5 as const,
              defaultTarget: selection,
              workspaceRoot: process.cwd(),
              enabledTools: [],
              approvalPolicy: "always_approve" as const,
              promptCacheKey: input.submissionId,
              baseInstructions: {
                text: "Test turn",
                revision: "test",
                provenance: { type: "custom" as const },
              },
              executionPolicyDefaults: createSessionExecutionPolicy(),
              modelAutoCompactTokenLimitScope: "total" as const,
            },
          }
        })(snapshot, input)
        let stop: (() => void) | undefined
        return {
          kind: input.manualCompact === true ? "compact" : "regular",
          async run(session, execution) {
            await session.beginExecution(execution, context)
            const runtime = bindExecution(session, execution)

            const task = (() => {
              return {
                completion: runtime.recordInitialInput().then(() => completion),
                abort: release,
              }
            })()
            stop = task.abort
            return (await task.completion) ?? undefined
          },
          async abort() {
            stop?.()
          },
        }
      },
    }),
  })
  const eventHub = createSessionEventHub()
  const handlers = createThreadServerHandlers({ manager, store, eventHub })
  const processor = new MessageProcessor({ handlers, eventHub })
  const connection = openTestConnection(processor)
  try {
    await initializeConnection(connection)
    const created = await handlers.createSession({
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.error.message)
    const sessionId = created.value.session.id
    const started = await handlers.admitInput({
      sessionId,
      requestId: "request_active",
      content: inputFixture(inputParts("Keep working")),
    })
    if (!started.ok) throw new Error(started.error.message)

    const client = new FakeRpcClient()
    fakeRef.current = client
    let loseAcknowledgment = true
    client.respond = async (method, params) => {
      // Use the real JSON-RPC dispatch and queue storage; only drop delivery
      // of the first successful response to the renderer.
      const response = await connection.sendRequest(method, params)
      if ("error" in response) throw new ApiRequestError(response.error.message)
      if (method === "session/input/queue" && loseAcknowledgment) {
        loseAcknowledgment = false
        throw new ApiRequestError("The connection to the server was lost.")
      }
      return response.result
    }
    const annotation: ContextExcerpt = {
      id: "annotation_one",

      text: "Selected answer",
      comment: "Check this",
      anchor: { startOffset: 0, endOffset: 15 },
      source: {
        sessionId: "session_1",
        kind: "message",
        label: "Assistant",
        messageId: "answer_one",
      },
    }
    useAppStore.setState({
      ...createInitialAppState(),
      apiBase: "http://api.test",
      selection: { sessionId },
      promptDraft: inputParts("Follow up"),
      promptExcerpts: [annotation],
      execution: {
        ...createExecutionViewState(),
        activeTurnId: "request_active",
      },
      modelSelections: { [sessionId]: { provider: "faux", model: "scripted" } },
    })
    await useAppStore.getState().admitInput(inputParts("Follow up"), "queue")
    expect(useAppStore.getState().message).toBe(
      "Sending status is unconfirmed. This input has not been resent.",
    )
    const queued = await handlers.listQueuedInputs({ sessionId })
    if (!queued.ok) throw new Error(queued.error.message)
    expect(queued.value.items).toHaveLength(1)
    const first = queued.value.items[0]
    if (first === undefined) throw new Error("Missing committed queued input")

    await useAppStore.getState().refreshQueuedInputs()
    expect(useAppStore.getState().promptDraft).toBeUndefined()
    expect(useAppStore.getState().queuedItems).toEqual([
      expect.objectContaining({
        id: first.id,
        input: expect.objectContaining({
          submissionId: first.input.submissionId,
          content: inputFixture(
            inputParts("Follow up"),
            { references: [annotation] }.references,
          ),
        }),
      }),
    ])
    expect(
      inputRecoveryMemory.listAdmissionsForSession(
        "http://api.test",
        sessionId,
      ),
    ).toEqual([])
    expect(client.requestsFor("session/input/queue")).toHaveLength(1)
  } finally {
    await processor.closeConnection(connection.id)
    release()
    await manager.shutdown()
    await handlers.close()
  }
})
