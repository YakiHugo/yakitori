import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import type { Server as HttpServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import packageJson from "../../package.json" with { type: "json" }
import { PersistContext } from "../../src/core/thread-store.ts"
import { MateEventType, MateLifecycle } from "../../src/mates/events.ts"
import { createMateKernel } from "../../src/mates/mate-kernel.ts"
import { createSqliteMateStore } from "../../src/mates/sqlite-mate-store.ts"
import { type ModelRequest, ModelStopReason } from "../../src/runtime/model.ts"
import { listCatalogModels } from "../../src/runtime/model-catalog.ts"
import {
  createYakitoriApplication,
  resolveWorkspaceDirectory,
  type YakitoriApplication,
} from "../../src/server/application.ts"
import {
  ApiErrorCode,
  type ApiHandlerResult,
  type ApiListAgentsResponse,
  type ApiListProvidersResponse,
  type ApiListSessionsResponse,
} from "../../src/server/protocol.ts"
import type { ConfigurationSnapshot } from "../../src/server/user-config.ts"
import { createFauxProvider } from "../support/faux-provider.ts"
import { deferred } from "./rpc/testkit.ts"

async function listen(server: HttpServer): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("Expected HTTP server to listen on a TCP address.")
  }
  return `http://${address.address}:${address.port}`
}

// Minimal JSON-RPC client for the /rpc WebSocket channel: the REST routes
// these tests used are gone.
async function rpcRequest<T>(
  baseUrl: string,
  method: string,
  params: unknown,
): Promise<T> {
  const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/rpc`)
  const call = (id: number, requestMethod: string, requestParams: unknown) =>
    new Promise<T>((resolve, reject) => {
      const onMessage = (data: WebSocket.RawData) => {
        const frame = JSON.parse(data.toString()) as {
          id?: number
          result?: unknown
          error?: { message: string }
        }
        if (frame.id !== id) return
        ws.off("message", onMessage)
        if (frame.error !== undefined) {
          reject(new Error(frame.error.message))
          return
        }
        resolve(frame.result as T)
      }
      ws.on("message", onMessage)
      ws.send(
        JSON.stringify({ id, method: requestMethod, params: requestParams }),
      )
    })
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve)
      ws.once("error", reject)
    })
    await call(1, "initialize", {
      clientInfo: { name: "application-test", version: "0.0.0" },
      capabilities: {},
    })
    return await call(2, method, params)
  } finally {
    // node:http counts the upgraded socket as an open connection, so the
    // caller's server.close() cannot finish until this close completes.
    await new Promise<void>((resolve) => {
      ws.once("close", resolve)
      ws.close()
    })
  }
}

function testApplicationOptions(input: {
  readonly rootDir: string
  readonly workspace: string
  readonly activeMateId?: string
}) {
  return {
    ...input,
    stream: createFauxProvider([]).stream,
    userConfigPath: join(input.rootDir, "config.toml"),
    modelDirectory: {
      listModels: async (provider: string) =>
        listCatalogModels(provider).map((model) => ({
          id: model.model,
          displayName: model.displayName ?? model.model,
          instructionProfileId: model.instructionProfileId,
          ...(model.efforts === undefined ? {} : { efforts: model.efforts }),
          ...(model.speeds === undefined ? {} : { speeds: model.speeds }),
        })),
    },
  }
}

describe("application composition", () => {
  // The packaged app exports provider env (YAKITORI_PROVIDER, KIMI_API_KEY, …)
  // into shells it spawns; these tests must see a clean slate.
  const touchedEnv = [
    "YAKITORI_PROVIDER",
    "YAKITORI_MODEL",
    "YAKITORI_FAUX_SCENARIO",
    "CODEX_HOME",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
    "KIMI_API_KEY",
    "GROK_CREDENTIALS",
  ] as const
  let savedEnv: Record<(typeof touchedEnv)[number], string | undefined>

  beforeEach(() => {
    savedEnv = Object.fromEntries(
      touchedEnv.map((key) => [key, process.env[key]]),
    ) as typeof savedEnv
    for (const key of touchedEnv) delete process.env[key]
    process.env.CODEX_HOME = join(tmpdir(), "yakitori-test-missing-codex-home")
    process.env.GROK_CREDENTIALS = join(tmpdir(), "missing-grok-auth.json")
  })

  afterEach(() => {
    for (const key of touchedEnv) {
      const value = savedEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it("broadcasts successful background completions without replaying them to later subscribers", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const application = await createYakitoriApplication({
        ...testApplicationOptions({ rootDir, workspace }),
        stream: createFauxProvider([
          { content: [{ type: "text", text: "Task finished" }] },
        ]).stream,
      })
      const server = application.createHttpServer()
      const baseUrl = await listen(server)
      const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/rpc`)
      const frames: {
        id?: number
        method?: string
        params?: unknown
        result?: unknown
      }[] = []
      socket.on("message", (data) => frames.push(JSON.parse(data.toString())))
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once("open", resolve)
          socket.once("error", reject)
        })
        socket.send(
          JSON.stringify({
            id: 1,
            method: "initialize",
            params: {
              clientInfo: { name: "completion-test", version: "0.0.0" },
            },
          }),
        )
        await vi.waitFor(() =>
          expect(frames.find((frame) => frame.id === 1)).toHaveProperty(
            "result",
          ),
        )

        const created = await application.handlers.createSession({
          title: "Background task",
        })
        expectOk(created)
        const sessionId = created.body.session.id
        const input = {
          sessionId,
          requestId: "request_completion",
          content: { kind: "text" as const, text: "Finish the task" },
        }
        expectOk(await application.handlers.admitInput(input))
        await vi.waitFor(() => {
          expect(
            frames.filter((frame) => frame.method === "session/completed"),
          ).toEqual([
            {
              method: "session/completed",
              params: {
                sessionId,
                turnId: "request_completion",
                title: "Background task",
              },
            },
          ])
        })

        // The client never subscribed to this Session while the Turn ran.
        expect(frames.some((frame) => frame.method === "session/event")).toBe(
          false,
        )
        frames.length = 0
        socket.send(
          JSON.stringify({
            id: 2,
            method: "session/subscribe",
            params: { sessionId, after: 0 },
          }),
        )
        await vi.waitFor(() =>
          expect(
            frames.some((frame) => frame.method === "session/replayComplete"),
          ).toBe(true),
        )
        expect(
          frames.filter((frame) => frame.method === "session/event"),
        ).not.toHaveLength(0)
        expect(
          frames.filter((frame) => frame.method === "session/completed"),
        ).toEqual([])

        expectOk(await application.handlers.admitInput(input))
        await waitForThreadIdle(application, sessionId)
        expect(
          frames.filter((frame) => frame.method === "session/completed"),
        ).toEqual([])
      } finally {
        await new Promise<void>((resolve) => {
          socket.once("close", resolve)
          socket.close()
        })
        await closeServer(server)
        await application.close()
      }
    })
  })

  it("creates the workspace default project once across restarts", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const application = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      const firstPage = await application.projectStore.listProjects()
      expect(firstPage.projects).toHaveLength(1)
      expect(firstPage.projects[0]).toMatchObject({
        name: application.workspace.split("/").at(-1),
        roots: [application.workspace],
        position: 0,
      })
      await application.close()

      const restarted = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      try {
        const secondPage = await restarted.projectStore.listProjects()
        expect(secondPage.projects).toEqual(firstPage.projects)
      } finally {
        await restarted.close()
      }
    })
  })

  it("keeps an empty Session live until the first input commits its replayable history", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const options = testApplicationOptions({ rootDir, workspace })
      const application = await createYakitoriApplication(options)
      let emptyId = ""
      let committedId = ""
      try {
        const empty = await application.handlers.createSession()
        expectOk(empty)
        emptyId = empty.body.session.id
        const readEmpty = await application.handlers.readSession({
          sessionId: emptyId,
        })
        expectOk(readEmpty)
        const emptyEvents = await application.handlers.readSessionEvents({
          sessionId: emptyId,
        })
        expectOk(emptyEvents)
        expect(emptyEvents.body.events.map((event) => event.type)).toEqual([
          "session.created",
        ])
        expect((await application.threadStore.listThreads()).threads).toEqual(
          [],
        )

        const created = await application.handlers.createSession()
        expectOk(created)
        committedId = created.body.session.id
        const admitted = await application.handlers.admitInput({
          sessionId: committedId,
          requestId: "request_first_commit",
          content: { kind: "text", text: "persist this prompt" },
        })
        expectOk(admitted)
        expect(
          (await application.threadStore.listThreads()).threads.map(
            (thread) => thread.id,
          ),
        ).toEqual([committedId])
        const replay = await application.handlers.readSessionEvents({
          sessionId: committedId,
        })
        expectOk(replay)
        expect(
          replay.body.events
            .map((event) => event.type)
            .filter((type) =>
              ["session.created", "input.admitted", "turn.started"].includes(
                type,
              ),
            ),
        ).toEqual(["session.created", "input.admitted", "turn.started"])
      } finally {
        await application.close()
      }

      const reopened = await createYakitoriApplication(options)
      try {
        expect(await reopened.threadStore.readThread(emptyId)).toBeUndefined()
        const saved = await reopened.threadStore.readThread(committedId)
        expect(
          saved?.rollout.some((entry) => entry.item.type === "turn_started"),
        ).toBe(true)
      } finally {
        await reopened.close()
      }
    })
  })

  it("lists only the current root's agents over RPC with live and stored status", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const childMayFinish = deferred<void>()
      const options = testApplicationOptions({ rootDir, workspace })
      const application = await createYakitoriApplication({
        ...options,
        stream: async function* (request) {
          const isChild = request.messages.some(
            (message) =>
              message.role === "user" &&
              message.content.some((block) => block.text === "inspect child"),
          )
          if (isChild) await childMayFinish.promise
          const hasToolResult = request.messages.some(
            (message) => message.role === "tool",
          )
          yield {
            type: "response",
            response:
              isChild || hasToolResult
                ? {
                    stopReason: ModelStopReason.EndTurn,
                    content: [
                      {
                        type: "text",
                        text: isChild ? "child findings" : "parent finished",
                      },
                    ],
                  }
                : {
                    stopReason: ModelStopReason.ToolUse,
                    content: [
                      {
                        type: "tool_call",
                        id: "tool_spawn_listing",
                        name: "spawn_agent",
                        input: {
                          task_name: "survey",
                          message: "inspect child",
                        },
                      },
                    ],
                  },
          }
        },
      })
      const server = application.createHttpServer()
      const baseUrl = await listen(server)
      let rootThreadId = ""
      let childThreadId = ""
      try {
        const created = await application.handlers.createSession()
        expectOk(created)
        rootThreadId = created.body.session.id
        const other = await application.handlers.createSession()
        expectOk(other)
        const admitted = await application.handlers.admitInput({
          sessionId: rootThreadId,
          requestId: "request_agent_listing",
          content: { kind: "text", text: "delegate" },
        })
        expectOk(admitted)
        await waitForThreadIdle(application, rootThreadId)

        await vi.waitFor(async () => {
          const listed = await rpcRequest<ApiListAgentsResponse>(
            baseUrl,
            "agent/list",
            { sessionId: rootThreadId },
          )
          expect(listed.agents).toEqual([
            {
              agentId: expect.any(String),
              taskName: "survey",
              path: "/root/survey",
              parentPath: "/root",
              status: "running",
            },
          ])
          childThreadId = listed.agents[0]?.agentId ?? ""
        })
        const listRoots = await rpcRequest<ApiListSessionsResponse>(
          baseUrl,
          "session/list",
          {},
        )
        expect(listRoots.sessions.map((session) => session.id)).toEqual([
          rootThreadId,
        ])
        expect(
          application.threadManager.getThread(other.body.session.id)?.status,
        ).toBe("idle")
        expect(
          await rpcRequest(baseUrl, "agent/list", {
            sessionId: other.body.session.id,
          }),
        ).toEqual({ agents: [] })
        expect(
          await rpcRequest(baseUrl, "agent/list", { sessionId: childThreadId }),
        ).toEqual(
          await rpcRequest(baseUrl, "agent/list", { sessionId: rootThreadId }),
        )
        await expect(
          rpcRequest(baseUrl, "agent/list", { sessionId: "" }),
        ).rejects.toThrow()
        await expect(
          rpcRequest(baseUrl, "agent/list", {
            sessionId: "session_00000000-0000-4000-8000-000000000000",
          }),
        ).rejects.toThrow("was not found")

        childMayFinish.resolve()
        await vi.waitFor(async () => {
          const listed = await rpcRequest<ApiListAgentsResponse>(
            baseUrl,
            "agent/list",
            { sessionId: rootThreadId },
          )
          expect(listed.agents[0]?.status).toEqual({
            completed: "child findings",
          })
        })
      } finally {
        childMayFinish.resolve()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await application.close()
      }

      const restarted = await createYakitoriApplication(options)
      try {
        const before = await restarted.threadStore.readThread(rootThreadId)
        const listed = await restarted.handlers.listAgents({
          sessionId: rootThreadId,
        })
        expectOk(listed)
        expect(listed.body.agents).toEqual([
          {
            agentId: childThreadId,
            taskName: "survey",
            path: "/root/survey",
            parentPath: "/root",
            status: { completed: "child findings" },
          },
        ])
        expect(restarted.threadManager.residentThreadCount).toBe(0)
        expect(await restarted.threadStore.readThread(rootThreadId)).toEqual(
          before,
        )
      } finally {
        await restarted.close()
      }
    })
  })

  it("streams a spawned child after subscribing without replacing the root subscription", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const childMayFinish = deferred<void>()
      const application = await createYakitoriApplication({
        ...testApplicationOptions({ rootDir, workspace }),
        stream: async function* (request) {
          const isChild = request.messages.some(
            (message) =>
              message.role === "user" &&
              message.content.some((block) => block.text === "child task"),
          )
          if (isChild) {
            yield { type: "snapshot", text: "child " }
            await childMayFinish.promise
            yield { type: "snapshot", text: "child live answer" }
          }
          const hasToolResult = request.messages.some(
            (message) => message.role === "tool",
          )
          yield {
            type: "response",
            response:
              isChild || hasToolResult
                ? {
                    stopReason: ModelStopReason.EndTurn,
                    content: [
                      {
                        type: "text",
                        text: isChild ? "child live answer" : "root answer",
                      },
                    ],
                  }
                : {
                    stopReason: ModelStopReason.ToolUse,
                    content: [
                      {
                        type: "tool_call",
                        id: "tool_spawn_live",
                        name: "spawn_agent",
                        input: { task_name: "live", message: "child task" },
                      },
                    ],
                  },
          }
        },
      })
      const server = application.createHttpServer()
      const baseUrl = await listen(server)
      const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/rpc`)
      const frames: {
        id?: number
        method?: string
        params?: unknown
        result?: unknown
      }[] = []
      socket.on("message", (data) => frames.push(JSON.parse(data.toString())))
      let nextId = 0
      const send = async (method: string, params: unknown) => {
        const id = ++nextId
        socket.send(JSON.stringify({ id, method, params }))
        await vi.waitFor(() =>
          expect(frames.find((frame) => frame.id === id)).toHaveProperty(
            "result",
          ),
        )
      }
      const subscribe = async (sessionId: string) => {
        await send("session/subscribe", { sessionId })
        await vi.waitFor(() =>
          expect(frames).toContainEqual({
            method: "session/replayComplete",
            params: expect.objectContaining({ sessionId }),
          }),
        )
      }
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once("open", resolve)
          socket.once("error", reject)
        })
        await send("initialize", {
          clientInfo: { name: "child-stream-test", version: "0.0.0" },
        })
        const created = await application.handlers.createSession()
        expectOk(created)
        const rootSessionId = created.body.session.id
        await subscribe(rootSessionId)
        expectOk(
          await application.handlers.admitInput({
            sessionId: rootSessionId,
            requestId: "request_live_spawn",
            content: { kind: "text", text: "delegate" },
          }),
        )
        await waitForThreadIdle(application, rootSessionId)
        const listed = await application.handlers.listAgents({
          sessionId: rootSessionId,
        })
        expectOk(listed)
        const childSessionId = listed.body.agents[0]?.agentId
        if (childSessionId === undefined)
          throw new Error("Child was not spawned.")
        await subscribe(childSessionId)
        frames.length = 0
        childMayFinish.resolve()
        await vi.waitFor(() =>
          expect(frames).toContainEqual({
            method: "session/transient",
            params: expect.objectContaining({
              type: "turn.finished",
              sessionId: childSessionId,
              outcome: { status: "completed" },
            }),
          }),
        )
        expect(frames).toContainEqual({
          method: "session/event",
          params: expect.objectContaining({
            sessionId: childSessionId,
            event: expect.objectContaining({
              type: "item.completed",
              data: expect.objectContaining({
                item: expect.objectContaining({
                  type: "agent_message",
                  content: [{ type: "text", text: "child live answer" }],
                }),
              }),
            }),
          }),
        })
        expect(frames).toContainEqual({
          method: "session/transient",
          params: expect.objectContaining({
            sessionId: childSessionId,
            type: "assistant.delta",
            delta: "live answer",
          }),
        })

        expectOk(
          await application.handlers.admitInput({
            sessionId: rootSessionId,
            requestId: "request_root_still_subscribed",
            content: { kind: "text", text: "continue" },
          }),
        )
        await vi.waitFor(() =>
          expect(frames).toContainEqual({
            method: "session/transient",
            params: expect.objectContaining({
              type: "turn.finished",
              sessionId: rootSessionId,
              turnId: "request_root_still_subscribed",
              outcome: { status: "completed" },
            }),
          }),
        )
      } finally {
        childMayFinish.resolve()
        await new Promise<void>((resolve) => {
          socket.once("close", resolve)
          socket.close()
        })
        await closeServer(server)
        await application.close()
      }
    })
  })

  it("keeps a stored child subscription live when runtime followup installs and reinstalls its actor", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const options = testApplicationOptions({ rootDir, workspace })
      const first = await createYakitoriApplication({
        ...options,
        stream: async function* (request) {
          const child = request.messages.some(
            (message) =>
              message.role === "user" &&
              message.content.some((block) => block.text === "initial child"),
          )
          yield {
            type: "response",
            response:
              child ||
              request.messages.some((message) => message.role === "tool")
                ? {
                    stopReason: ModelStopReason.EndTurn,
                    content: [{ type: "text", text: "initial result" }],
                  }
                : {
                    stopReason: ModelStopReason.ToolUse,
                    content: [
                      {
                        type: "tool_call",
                        id: "tool_spawn_observer",
                        name: "spawn_agent",
                        input: {
                          task_name: "observer",
                          message: "initial child",
                        },
                      },
                    ],
                  },
          }
        },
      })
      let rootSessionId = ""
      let childSessionId = ""
      try {
        const created = await first.handlers.createSession()
        expectOk(created)
        rootSessionId = created.body.session.id
        expectOk(
          await first.handlers.admitInput({
            sessionId: rootSessionId,
            requestId: "request_spawn_observer",
            content: { kind: "text", text: "delegate" },
          }),
        )
        await waitForThreadIdle(first, rootSessionId)
        await vi.waitFor(async () => {
          const listed = await first.handlers.listAgents({
            sessionId: rootSessionId,
          })
          expectOk(listed)
          expect(listed.body.agents[0]?.status).toEqual({
            completed: "initial result",
          })
          childSessionId = listed.body.agents[0]?.agentId ?? ""
        })
      } finally {
        await first.close()
      }

      let mayFinish = deferred<void>()
      let needsFollowup = true
      let turn = 1
      const restarted = await createYakitoriApplication({
        ...options,
        stream: async function* (request) {
          const child = request.messages.some(
            (message) =>
              message.role === "user" &&
              message.content.some((block) => block.text === "resume child"),
          )
          if (child) {
            yield { type: "snapshot", text: `live followup ${turn}` }
            await mayFinish.promise
          }
          const followup = !child && needsFollowup
          if (followup) needsFollowup = false
          yield {
            type: "response",
            response: followup
              ? {
                  stopReason: ModelStopReason.ToolUse,
                  content: [
                    {
                      type: "tool_call",
                      id: `tool_followup_${turn}`,
                      name: "followup_task",
                      input: { target: "observer", message: "resume child" },
                    },
                  ],
                }
              : {
                  stopReason: ModelStopReason.EndTurn,
                  content: [
                    {
                      type: "text",
                      text: child ? `final followup ${turn}` : "root finished",
                    },
                  ],
                },
          }
        },
      })
      const server = restarted.createHttpServer()
      const baseUrl = await listen(server)
      const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/rpc`)
      const frames: {
        id?: number
        method?: string
        params?: unknown
        result?: unknown
      }[] = []
      socket.on("message", (data) => frames.push(JSON.parse(data.toString())))
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once("open", resolve)
          socket.once("error", reject)
        })
        socket.send(
          JSON.stringify({
            id: 1,
            method: "initialize",
            params: {
              clientInfo: { name: "resumed-child-test", version: "0.0.0" },
            },
          }),
        )
        await vi.waitFor(() =>
          expect(frames.find((frame) => frame.id === 1)).toHaveProperty(
            "result",
          ),
        )
        socket.send(
          JSON.stringify({
            id: 2,
            method: "session/subscribe",
            params: { sessionId: childSessionId },
          }),
        )
        await vi.waitFor(() =>
          expect(frames).toContainEqual({
            method: "session/replayComplete",
            params: expect.objectContaining({ sessionId: childSessionId }),
          }),
        )
        expect(restarted.threadManager.residentThreadCount).toBe(0)

        for (turn = 1; turn <= 2; turn += 1) {
          frames.length = 0
          needsFollowup = true
          mayFinish = deferred<void>()
          expectOk(
            await restarted.handlers.admitInput({
              sessionId: rootSessionId,
              requestId: `request_resume_child_${turn}`,
              content: { kind: "text", text: "resume observer" },
            }),
          )
          await vi.waitFor(() =>
            expect(frames).toContainEqual({
              method: "session/transient",
              params: expect.objectContaining({
                sessionId: childSessionId,
                type: "assistant.delta",
                delta: `live followup ${turn}`,
              }),
            }),
          )
          mayFinish.resolve()
          await vi.waitFor(() =>
            expect(frames).toContainEqual({
              method: "session/transient",
              params: expect.objectContaining({
                sessionId: childSessionId,
                type: "turn.finished",
                outcome: { status: "completed" },
              }),
            }),
          )
          expect(frames).toContainEqual({
            method: "session/event",
            params: expect.objectContaining({
              sessionId: childSessionId,
              event: expect.objectContaining({
                type: "item.completed",
                data: expect.objectContaining({
                  item: expect.objectContaining({
                    type: "agent_message",
                    content: [{ type: "text", text: `final followup ${turn}` }],
                  }),
                }),
              }),
            }),
          })
          await waitForThreadIdle(restarted, rootSessionId)
          expectOk(
            await restarted.handlers.closeSession({
              sessionId: childSessionId,
            }),
          )
          expect(
            restarted.threadManager.getThread(childSessionId),
          ).toBeUndefined()
        }
      } finally {
        mayFinish.resolve()
        await new Promise<void>((resolve) => {
          socket.once("close", resolve)
          socket.close()
        })
        await closeServer(server)
        await restarted.close()
      }
    })
  })

  it("runs spawn_agent through a real child Thread", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      let notificationRequest: ModelRequest | undefined
      const application = await createYakitoriApplication({
        ...testApplicationOptions({ rootDir, workspace }),
        stream: async function* (request) {
          const lastTask = [...request.messages]
            .reverse()
            .find(
              (message) =>
                message.role === "user" && message.context === undefined,
            )
          const taskText =
            lastTask?.role === "user"
              ? lastTask.content.map((block) => block.text).join("")
              : ""
          if (
            request.messages.some(
              (message) =>
                message.role === "user" &&
                message.content.some((block) =>
                  block.text.includes("use child result"),
                ),
            )
          ) {
            notificationRequest = request
            yield {
              type: "response",
              response: {
                stopReason: ModelStopReason.EndTurn,
                content: [{ type: "text", text: "used child result" }],
              },
            }
            return
          }
          if (taskText === "inspect child") {
            yield {
              type: "response",
              response: {
                stopReason: ModelStopReason.EndTurn,
                content: [{ type: "text", text: "child findings" }],
              },
            }
            return
          }
          const hasToolResult = request.messages.some(
            (message) => message.role === "tool",
          )
          yield {
            type: "response",
            response: hasToolResult
              ? {
                  stopReason: ModelStopReason.EndTurn,
                  content: [{ type: "text", text: "parent continues" }],
                }
              : {
                  stopReason: ModelStopReason.ToolUse,
                  content: [
                    {
                      type: "tool_call",
                      id: "tool_spawn_child",
                      name: "spawn_agent",
                      input: {
                        task_name: "survey",
                        message: "inspect child",
                      },
                    },
                  ],
                },
          }
        },
      })
      try {
        const created = await application.handlers.createSession()
        expectOk(created)
        const rootThreadId = created.body.session.id
        const admitted = await application.handlers.admitInput({
          sessionId: rootThreadId,
          requestId: "request_spawn_child",
          content: { kind: "text", text: "delegate" },
        })
        expectOk(admitted)
        await waitForThreadIdle(application, rootThreadId)

        let childThreadId: string | undefined
        await vi.waitFor(async () => {
          const threadIds = await application.threadStore.listThreadIds()
          childThreadId = threadIds.find((id) => id !== rootThreadId)
          expect(childThreadId).toBeDefined()
          expect(
            application.threadManager.getThread(childThreadId ?? "")
              ?.agentStatus,
          ).toEqual({ completed: "child findings" })
        })
        const child = await application.threadStore.readThread(
          childThreadId ?? "",
        )
        expect(child?.metadata).toMatchObject({
          conversationId: rootThreadId,
          parentThreadId: rootThreadId,
          metadata: {
            agent: {
              kind: "subagent",
              rootThreadId,
              path: "/root/survey",
            },
          },
        })
        const root = await application.threadStore.readThread(rootThreadId)
        const toolResults = root?.rollout.flatMap((entry) =>
          entry.item.type === "response_item" &&
          entry.item.item.item.role === "tool"
            ? [entry.item.item.item.content]
            : [],
        )
        expect(toolResults?.join("\n")).toContain("/root/survey")
        expect(toolResults?.join("\n")).not.toContain("agents_unavailable")

        await Promise.resolve()
        await Promise.resolve()
        const followup = await application.handlers.admitInput({
          sessionId: rootThreadId,
          requestId: "request_use_child_result",
          content: { kind: "text", text: "use child result" },
        })
        expectOk(followup)
        await waitForThreadIdle(application, rootThreadId)
        expect(JSON.stringify(notificationRequest?.messages)).toContain(
          "<subagent_notification",
        )
        expect(JSON.stringify(notificationRequest?.messages)).toContain(
          "child findings",
        )
        const updatedRoot =
          await application.threadStore.readThread(rootThreadId)
        expect(
          updatedRoot?.rollout.some(
            (entry) =>
              entry.item.type === "agent_message" &&
              entry.item.item.item.role === "user" &&
              entry.item.item.item.content.some((block) =>
                block.text.includes("<subagent_notification"),
              ),
          ),
        ).toBe(true)
        const deleted = await application.handlers.deleteSession({
          sessionId: rootThreadId,
        })
        expectOk(deleted)
        await expect(application.threadStore.listThreadIds()).resolves.toEqual(
          [],
        )
        expect(
          application.threadManager.getThread(childThreadId ?? ""),
        ).toBeUndefined()
      } finally {
        await application.close()
      }
    })
  })

  it("restores open child identities before listing after restart", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const first = await createYakitoriApplication({
        ...testApplicationOptions({ rootDir, workspace }),
        stream: async function* (request) {
          const isChild = request.messages.some(
            (message) =>
              message.role === "user" &&
              message.content.some((block) => block.text === "child task"),
          )
          const hasToolResult = request.messages.some(
            (message) => message.role === "tool",
          )
          yield {
            type: "response",
            response: isChild
              ? {
                  stopReason: ModelStopReason.EndTurn,
                  content: [{ type: "text", text: "persisted result" }],
                }
              : hasToolResult
                ? {
                    stopReason: ModelStopReason.EndTurn,
                    content: [{ type: "text", text: "spawned" }],
                  }
                : {
                    stopReason: ModelStopReason.ToolUse,
                    content: [
                      {
                        type: "tool_call",
                        id: "tool_spawn_persisted",
                        name: "spawn_agent",
                        input: {
                          task_name: "persisted",
                          message: "child task",
                        },
                      },
                    ],
                  },
          }
        },
      })
      const created = await first.handlers.createSession()
      expectOk(created)
      const rootThreadId = created.body.session.id
      const admitted = await first.handlers.admitInput({
        sessionId: rootThreadId,
        requestId: "request_spawn_persisted",
        content: { kind: "text", text: "spawn persistent child" },
      })
      expectOk(admitted)
      await waitForThreadIdle(first, rootThreadId)
      let persistedChildId: string | undefined
      await vi.waitFor(async () => {
        const ids = await first.threadStore.listThreadIds()
        persistedChildId = ids.find((id) => id !== rootThreadId)
        expect(
          first.threadManager.getThread(persistedChildId ?? "")?.agentStatus,
        ).toEqual({ completed: "persisted result" })
      })
      await first.close()

      const resumed = await createYakitoriApplication({
        ...testApplicationOptions({ rootDir, workspace }),
        stream: async function* (request) {
          const toolResult = [...request.messages]
            .reverse()
            .find(
              (message) =>
                message.role === "tool" &&
                message.toolCallId === "tool_list_restored",
            )
          yield {
            type: "response",
            response:
              toolResult === undefined
                ? {
                    stopReason: ModelStopReason.ToolUse,
                    content: [
                      {
                        type: "tool_call",
                        id: "tool_list_restored",
                        name: "list_agents",
                        input: {},
                      },
                    ],
                  }
                : {
                    stopReason: ModelStopReason.EndTurn,
                    content: [{ type: "text", text: "listed" }],
                  },
          }
        },
      })
      try {
        expect(
          resumed.threadManager.getThread(persistedChildId ?? ""),
        ).toBeUndefined()
        const afterRestart = await resumed.handlers.admitInput({
          sessionId: rootThreadId,
          requestId: "request_list_restored",
          content: { kind: "text", text: "list children" },
        })
        expectOk(afterRestart)
        await waitForThreadIdle(resumed, rootThreadId)
        const storedRoot = await resumed.threadStore.readThread(rootThreadId)
        const listResult =
          storedRoot?.rollout
            .flatMap((entry) =>
              entry.item.type === "response_item" &&
              entry.item.item.item.role === "tool" &&
              entry.item.item.item.toolCallId === "tool_list_restored"
                ? [entry.item.item.item.content]
                : [],
            )
            .at(-1) ?? ""
        expect(listResult).toContain("/root/persisted")
        expect(listResult).toContain("persisted result")
        expect(
          resumed.threadManager.getThread(persistedChildId ?? ""),
        ).toBeUndefined()
      } finally {
        await resumed.close()
      }
    })
  })

  it("stores admitted images beside the Session and hydrates model requests", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      let captured: ModelRequest | undefined
      const application = await createYakitoriApplication({
        ...testApplicationOptions({ rootDir, workspace }),
        stream: async function* (request) {
          captured = request
          yield {
            type: "response",
            response: {
              stopReason: ModelStopReason.EndTurn,
              content: [{ type: "text", text: "seen" }],
            },
          }
        },
      })
      const server = application.createHttpServer()
      try {
        const baseUrl = await listen(server)
        const created = await application.handlers.createSession({})
        expectOk(created)
        const sessionId = created.body.session.id
        await application.threadStore.persistThread(
          sessionId,
          PersistContext.TurnStart,
        )
        const imageBytes = pngBuffer(128)
        const draftRolloutId = "draft_application_test"
        const attachments = await application.rolloutAssets.importImageBytes(
          draftRolloutId,
          "draft_application_test",
          [{ name: "screen.png", data: imageBytes }],
        )
        const admitted = await application.handlers.admitInput({
          sessionId,
          requestId: "request_image",
          content: {
            kind: "text",
            text: "inspect",
            attachments,
          },
        })
        expectOk(admitted)
        await waitForThreadIdle(application, sessionId)

        expect(admitted.body.event).toMatchObject({
          data: {
            content: {
              attachments: [
                {
                  detail: "high",
                  file: {
                    rolloutId: sessionId,
                    path: "attachments/requests/request_image/1.png",
                  },
                },
              ],
            },
          },
        })
        expect(JSON.stringify(admitted.body.event)).not.toContain(
          imageBytes.toString("base64"),
        )
        expect(
          await readFile(
            join(
              application.sessionStoreRoot,
              "rollouts",
              sessionId,
              "files",
              "attachments",
              "requests",
              "request_image",
              "1.png",
            ),
          ),
        ).toEqual(imageBytes)
        await expect(
          readFile(
            join(
              application.sessionStoreRoot,
              "rollouts",
              draftRolloutId,
              "files",
              attachments[0]?.file.path ?? "",
            ),
          ),
        ).rejects.toMatchObject({ code: "ENOENT" })
        expect(captured?.messages).toContainEqual({
          role: "user",
          content: [{ type: "text", text: "inspect" }],
          images: [
            {
              type: "image",
              mediaType: "image/png",
              detail: "high",
              data: imageBytes.toString("base64"),
            },
          ],
        })

        const image = await fetch(
          `${baseUrl}/rollouts/${sessionId}/assets/attachments/requests/request_image/1.png`,
        )
        expect(image.status).toBe(200)
        expect(image.headers.get("content-type")).toBe("image/png")
        expect(Buffer.from(await image.arrayBuffer())).toEqual(imageBytes)
        const logRoute = await fetch(
          `${baseUrl}/rollouts/${sessionId}/assets/tools/call_1/stdout.log`,
        )
        expect(logRoute.status).toBe(404)

        const replacementBytes = Buffer.from(imageBytes)
        replacementBytes[12] = 1
        const replacementDraft =
          await application.rolloutAssets.importImageBytes(
            sessionId,
            "draft_application_conflict",
            [{ name: "screen.png", data: replacementBytes }],
          )
        const conflictingImage = await application.handlers.admitInput({
          sessionId,
          requestId: "request_image",
          content: {
            kind: "text",
            text: "inspect",
            attachments: replacementDraft,
          },
        })
        expectError(conflictingImage, 409, ApiErrorCode.Conflict)
        expect(conflictingImage.body.error.details).toMatchObject({
          reason: "request_conflict",
        })
        expect(
          await readFile(
            join(
              application.sessionStoreRoot,
              "rollouts",
              sessionId,
              "files",
              "attachments",
              "requests",
              "request_image",
              "1.png",
            ),
          ),
        ).toEqual(imageBytes)

        const rejectedFork = await application.handlers.forkSession({
          sessionId,
          atInputId: admitted.body.inputId,
          reason: "edit",
          content: {
            kind: "text",
            text: "changed",
            attachments: [
              {
                name: "screen.png",
                mediaType: "image/png",
                data: Buffer.from("image-bytes").toString("base64"),
                sizeBytes: 11,
              },
            ],
          },
        })
        expect(rejectedFork).toMatchObject({
          status: 400,
          body: { error: { code: ApiErrorCode.InvalidInput } },
        })

        const forked = await application.handlers.forkSession({
          sessionId,
          atInputId: admitted.body.inputId,
          reason: "edit",
          content: {
            kind: "text",
            text: "inspect more closely",
          },
        })
        expectOk(forked)
        expect(forked.body.historyEndSeqExclusive).toBe(2)
        await waitForThreadIdle(application, forked.body.session.id)

        const child = await application.threadStore.readThread(
          forked.body.session.id,
        )
        expect(child?.metadata).toMatchObject({
          parentThreadId: sessionId,
          forkedFromInputId: admitted.body.inputId,
          forkReason: "edit",
        })
        const childInput = child?.rollout.find(
          ({ item }) =>
            item.type === "response_item" && item.item.id.startsWith("input_"),
        )?.item
        expect(childInput).toMatchObject({
          item: {
            item: {
              images: [
                {
                  file: {
                    rolloutId: forked.body.session.id,
                    path: expect.stringMatching(
                      /^attachments\/requests\/request_.+\/1\.png$/,
                    ),
                  },
                },
              ],
            },
          },
        })
        const childImagePath =
          childInput?.type === "response_item" &&
          childInput.item.item.role === "user"
            ? childInput.item.item.images?.[0]?.file?.path
            : undefined
        if (childImagePath === undefined) {
          throw new Error("Expected the forked input to retain its image.")
        }
        expect(
          await readFile(
            join(
              application.sessionStoreRoot,
              "rollouts",
              forked.body.session.id,
              "files",
              childImagePath,
            ),
          ),
        ).toEqual(imageBytes)

        const concurrentSession = await application.handlers.createSession()
        expectOk(concurrentSession)
        await application.threadStore.persistThread(
          concurrentSession.body.session.id,
          PersistContext.TurnStart,
        )
        const [draftA, draftB] = await Promise.all([
          application.rolloutAssets.importImageBytes(
            concurrentSession.body.session.id,
            "draft_concurrent_a",
            [{ name: "screen.png", data: imageBytes }],
          ),
          application.rolloutAssets.importImageBytes(
            concurrentSession.body.session.id,
            "draft_concurrent_b",
            [{ name: "screen.png", data: imageBytes }],
          ),
        ])
        const concurrent = await Promise.all([
          application.handlers.admitInput({
            sessionId: concurrentSession.body.session.id,
            requestId: "request_concurrent_image",
            content: { kind: "text", text: "A", attachments: draftA },
          }),
          application.handlers.admitInput({
            sessionId: concurrentSession.body.session.id,
            requestId: "request_concurrent_image",
            content: { kind: "text", text: "B", attachments: draftB },
          }),
        ])
        expect(concurrent.map((result) => result.status).sort()).toEqual([
          201, 409,
        ])
        await expect(
          application.rolloutAssets.read({
            rolloutId: concurrentSession.body.session.id,
            path: "attachments/requests/request_concurrent_image/1.png",
          }),
        ).resolves.toEqual(imageBytes)
      } finally {
        await closeServer(server)
        await application.close()
      }
    })
  })

  it("drains live event listeners while closing an active Turn", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const provider = createFauxProvider([{ waitForAbort: true }])
      const application = await createYakitoriApplication({
        rootDir,
        workspace,
        stream: provider.stream,
      })
      try {
        const created = await application.handlers.createSession()
        expectOk(created)
        const admitted = await application.handlers.admitInput({
          sessionId: created.body.session.id,
          requestId: "request_close_active",
          content: { kind: "text", text: "wait" },
        })
        expectOk(admitted)
        expect(
          application.threadManager.getThread(created.body.session.id)?.status,
        ).toBe("active")

        await application.close()

        expect(
          application.threadManager.getThread(created.body.session.id)?.status,
        ).toBeUndefined()
      } finally {
        await application.close()
      }
    })
  })

  it("does not materialize stored images for text-only models", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      let captured: ModelRequest | undefined
      const application = await createYakitoriApplication({
        ...testApplicationOptions({ rootDir, workspace }),
        model: "text-only",
        stream: async function* (request) {
          captured = request
          yield {
            type: "response",
            response: {
              stopReason: ModelStopReason.EndTurn,
              content: [{ type: "text", text: "seen" }],
            },
          }
        },
      })
      try {
        const created = await application.handlers.createSession({})
        expectOk(created)
        const sessionId = created.body.session.id
        await application.threadStore.persistThread(
          sessionId,
          PersistContext.TurnStart,
        )
        const attachments = await application.rolloutAssets.importImageBytes(
          sessionId,
          "text_only_draft",
          [{ name: "screen.png", data: pngBuffer(128) }],
        )
        const read = vi.spyOn(application.rolloutAssets, "read")
        const admitted = await application.handlers.admitInput({
          sessionId,
          requestId: "text_only_request",
          content: {
            kind: "text",
            text: "inspect",
            attachments,
          },
        })
        expectOk(admitted)

        await waitForThreadIdle(application, sessionId)

        expect(read).not.toHaveBeenCalled()
        expect(captured?.messages).toContainEqual({
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            {
              type: "text",
              text: expect.stringContaining("does not support image input"),
            },
          ],
        })
      } finally {
        await application.close()
      }
    })
  })

  it("streams native images from rollout asset storage", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const application = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      const server = application.createHttpServer()
      try {
        const baseUrl = await listen(server)
        const created = await application.handlers.createSession({})
        expectOk(created)
        await application.threadStore.persistThread(
          created.body.session.id,
          PersistContext.TurnStart,
        )
        const imageBytes = pngBuffer(128 * 1024 + 17)
        const sourcePath = join(rootDir, "large.png")
        await writeFile(sourcePath, imageBytes)
        const [attachment] = await application.rolloutAssets.importImagePaths(
          created.body.session.id,
          "draft_large_http",
          [sourcePath],
        )
        if (attachment === undefined) throw new Error("missing imported image")

        const response = await fetch(
          `${baseUrl}/rollouts/${attachment.file.rolloutId}/assets/${attachment.file.path}`,
        )

        expect(response.status).toBe(200)
        expect(Buffer.from(await response.arrayBuffer())).toEqual(imageBytes)
      } finally {
        await closeServer(server)
        await application.close()
      }
    })
  }, 15_000)

  it("serves the RPC WebSocket endpoint with the package version as userAgent", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const application = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      const server = application.createHttpServer()
      const wsUrl = `${(await listen(server)).replace("http://", "ws://")}/rpc`
      const ws = new WebSocket(wsUrl)
      try {
        const response = await new Promise<Record<string, unknown>>(
          (resolve, reject) => {
            ws.once("error", reject)
            ws.once("open", () => {
              ws.send(
                JSON.stringify({
                  id: 1,
                  method: "initialize",
                  params: { clientInfo: { name: "test", version: "0" } },
                }),
              )
            })
            ws.once("message", (data) => {
              resolve(JSON.parse(data.toString()) as Record<string, unknown>)
            })
          },
        )
        expect(response).toMatchObject({
          id: 1,
          result: { userAgent: `yakitori/${packageJson.version}` },
        })
      } finally {
        ws.close()
        await new Promise((resolve) => ws.once("close", resolve))
        await closeServer(server)
        await application.close()
      }
    })
  })

  it("binds the runtime lock to the canonical Session store", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const secondRoot = await mkdtemp(join(tmpdir(), "yakitori-app-second-"))
      const sessionStoreRoot = join(rootDir, "shared-sessions")
      const first = await createYakitoriApplication({
        ...testApplicationOptions({ rootDir, workspace }),
        sessionStoreRoot,
      })
      try {
        await expect(
          createYakitoriApplication({
            ...testApplicationOptions({
              rootDir: secondRoot,
              workspace,
            }),
            sessionStoreRoot,
          }),
        ).rejects.toThrow("Runtime lock is held by live process")
      } finally {
        await first.close()
        await rm(secondRoot, { recursive: true, force: true })
      }
    })
  })

  it("releases the Session lock when Mate storage construction fails", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const invalidDatabasePath = join(rootDir, "mate-database-directory")
      await mkdir(invalidDatabasePath)
      await expect(
        createYakitoriApplication({
          ...testApplicationOptions({ rootDir, workspace }),
          mateDatabasePath: invalidDatabasePath,
        }),
      ).rejects.toThrow()
      await rm(invalidDatabasePath, { recursive: true })

      const retried = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      await retried.close()
    })
  })

  it("creates one default Mate only once across restarts", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const first = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      const firstMateId = first.activeMate.mateId
      const firstRevisionId = first.activeMate.mateRevisionId
      expect(first.sessionStoreRoot).toBe(
        await realpath(join(rootDir, "sessions")),
      )
      expect(first.mateDatabasePath).toBe(join(rootDir, "mates.sqlite"))
      await Promise.all([first.close(), first.close()])

      const second = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      try {
        expect(second.activeMate.mateId).toBe(firstMateId)
        expect(second.activeMate.mateRevisionId).toBe(firstRevisionId)

        const listed = await second.mateKernel.listMates()
        expect(listed.mates).toHaveLength(1)
        expect(listed.mates[0]?.id).toBe(firstMateId)
      } finally {
        await second.close()
      }
    })
  })

  it("does not treat events.sqlite as the Mate database", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const legacyPath = join(rootDir, "events.sqlite")
      const mateStore = createSqliteMateStore({ databasePath: legacyPath })
      const legacyMate = await createMateKernel(mateStore).createMate({
        instructions: "Old development data.",
        name: "Legacy",
        role: "Builder",
      })
      mateStore.close()

      const application = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      try {
        expect(application.mateDatabasePath).toBe(join(rootDir, "mates.sqlite"))
        expect(application.activeMate.mateId).not.toBe(legacyMate.mate.id)
        expect((await application.mateKernel.listMates()).mates).toHaveLength(1)
      } finally {
        await application.close()
      }
    })
  })

  it("selects an explicitly configured active Mate and pins its revision", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const mateStore = createSqliteMateStore({
        databasePath: join(rootDir, "mates.sqlite"),
      })
      const mateKernel = createMateKernel(mateStore)
      const created = await mateKernel.createMate({
        instructions: "Prefer explicit tests.",
        name: "Configured",
        role: "Builder",
      })
      mateStore.close()

      const application = await createYakitoriApplication(
        testApplicationOptions({
          activeMateId: created.mate.id,
          rootDir,
          workspace,
        }),
      )
      try {
        expect(application.activeMate).toEqual({
          mateId: created.mate.id,
          mateRevisionId: created.mate.currentRevision.id,
          name: "Configured",
          revision: 1,
        })

        const createdSession = await application.handlers.createSession({
          title: "Pinned",
        })
        expectOk(createdSession)
        expect(createdSession.body.session).toMatchObject({
          title: "Pinned",
          workingDirectory: application.workspace,
          mateId: created.mate.id,
          mateRevisionId: created.mate.currentRevision.id,
        })
      } finally {
        await application.close()
      }
    })
  })

  it("fails startup when the configured Mate is missing or inactive", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      await expect(
        createYakitoriApplication(
          testApplicationOptions({
            activeMateId: "mate_00000000-0000-4000-8000-000000000000",
            rootDir,
            workspace,
          }),
        ),
      ).rejects.toThrow("Configured Mate was not found")

      const mateStore = createSqliteMateStore({
        databasePath: join(rootDir, "mates.sqlite"),
      })
      const mateKernel = createMateKernel(mateStore)
      const created = await mateKernel.createMate({
        instructions: "inactive later",
        name: "SoonInactive",
        role: "Builder",
      })
      await mateStore.appendEvent(
        created.mate.id,
        {
          type: MateEventType.LifecycleChanged,
          data: { lifecycle: MateLifecycle.Inactive },
        },
        { expectedSeq: created.mate.seq },
      )
      mateStore.close()

      await expect(
        createYakitoriApplication(
          testApplicationOptions({
            activeMateId: created.mate.id,
            rootDir,
            workspace,
          }),
        ),
      ).rejects.toThrow("Configured Mate is inactive")
    })
  })

  it("fails startup when multiple active Mates exist without an explicit selection", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const mateStore = createSqliteMateStore({
        databasePath: join(rootDir, "mates.sqlite"),
      })
      const mateKernel = createMateKernel(mateStore)
      await mateKernel.createMate({
        instructions: "one",
        name: "One",
        role: "Builder",
      })
      await mateKernel.createMate({
        instructions: "two",
        name: "Two",
        role: "Reviewer",
      })
      mateStore.close()

      await expect(
        createYakitoriApplication(
          testApplicationOptions({ rootDir, workspace }),
        ),
      ).rejects.toThrow("Multiple active Mates found")
    })
  })

  it("rejects a missing path, a file, and a nonexistent per-request working directory", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      await expect(
        resolveWorkspaceDirectory(join(rootDir, "missing-workspace")),
      ).rejects.toThrow("Workspace path does not exist")

      const filePath = join(rootDir, "not-a-directory.txt")
      await writeFile(filePath, "nope")
      await expect(resolveWorkspaceDirectory(filePath)).rejects.toThrow(
        "Workspace path is not a directory",
      )

      const application = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      try {
        const rejected = await application.handlers.createSession({
          workingDirectory: join(rootDir, "missing-dir"),
        })
        expectError(rejected, 400, ApiErrorCode.InvalidInput)
        expect(rejected.body.error.message).toContain(
          "workingDirectory must be an existing directory",
        )

        const other = join(rootDir, "other-project")
        await mkdir(other)
        const accepted = await application.handlers.createSession({
          workingDirectory: other,
          title: "Other project",
        })
        expectOk(accepted)
        expect(accepted.body.session.workingDirectory).toBe(
          await realpath(other),
        )
        expect(accepted.body.session.mateId).toBe(application.activeMate.mateId)
        expect(accepted.body.session.mateRevisionId).toBe(
          application.activeMate.mateRevisionId,
        )
      } finally {
        await application.close()
      }
    })
  })

  it("loads trusted project instructions from each Session working directory", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const nested = join(workspace, "packages", "app")
      const configPath = join(rootDir, "config.toml")
      await mkdir(join(workspace, ".yakitori"), { recursive: true })
      await mkdir(nested, { recursive: true })
      await writeFile(
        configPath,
        [
          `[projects.${JSON.stringify(workspace)}]`,
          'trust_level = "trusted"',
        ].join("\n"),
      )
      await writeFile(
        join(workspace, ".yakitori", "config.toml"),
        'instructions = "Use the Session project instructions."\n',
      )
      let request: ModelRequest | undefined
      const application = await createYakitoriApplication({
        rootDir,
        workspace,
        userConfigPath: configPath,
        stream: async function* (received) {
          request = received
          yield {
            type: "response",
            response: {
              stopReason: ModelStopReason.EndTurn,
              content: [{ type: "text", text: "done" }],
            },
          }
        },
      })
      try {
        const created = await application.handlers.createSession({
          workingDirectory: nested,
        })
        expectOk(created)
        const admitted = await application.handlers.admitInput({
          sessionId: created.body.session.id,
          requestId: "request_project_config",
          content: { kind: "text", text: "run" },
        })
        expectOk(admitted)
        await waitForThreadIdle(application, created.body.session.id)

        expect(request?.system.map((section) => section.text)).toContain(
          "Use the Session project instructions.",
        )
      } finally {
        await application.close()
      }
    })
  })

  it("uses the owning Project root for an outside-workspace Session and config/read", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const projectRoot = join(rootDir, "other-project")
      const nested = join(projectRoot, "packages", "app")
      const configPath = join(rootDir, "config.toml")
      await mkdir(join(projectRoot, ".yakitori"), { recursive: true })
      await mkdir(nested, { recursive: true })
      await writeFile(
        configPath,
        [
          `[projects.${JSON.stringify(projectRoot)}]`,
          'trust_level = "trusted"',
        ].join("\n"),
      )
      await writeFile(
        join(projectRoot, ".yakitori", "config.toml"),
        'instructions = "Use the outside Project configuration."\n',
      )
      let request: ModelRequest | undefined
      const application = await createYakitoriApplication({
        rootDir,
        workspace,
        userConfigPath: configPath,
        stream: async function* (received) {
          request = received
          yield {
            type: "response",
            response: {
              stopReason: ModelStopReason.EndTurn,
              content: [{ type: "text", text: "done" }],
            },
          }
        },
      })
      const server = application.createHttpServer()
      try {
        const project = await application.projectStore.createProject({
          name: "other-project",
          roots: [await realpath(projectRoot)],
        })
        const created = await application.handlers.createSession({
          projectId: project.project.id,
          workingDirectory: nested,
        })
        expectOk(created)
        const admitted = await application.handlers.admitInput({
          sessionId: created.body.session.id,
          requestId: "request_outside_project_config",
          content: { kind: "text", text: "run" },
        })
        expectOk(admitted)
        await waitForThreadIdle(application, created.body.session.id)
        expect(request?.system.map((section) => section.text)).toContain(
          "Use the outside Project configuration.",
        )

        const baseUrl = await listen(server)
        const snapshot = await rpcRequest<ConfigurationSnapshot>(
          baseUrl,
          "config/read",
          { cwd: nested },
        )
        expect(snapshot.configuration.baseInstructions).toBe(
          "Use the outside Project configuration.",
        )
        const written = await rpcRequest<ConfigurationSnapshot>(
          baseUrl,
          "config/write",
          {
            cwd: nested,
            keyPath: ["ui", "theme"],
            value: "dark",
          },
        )
        expect(written.configuration.baseInstructions).toBe(
          "Use the outside Project configuration.",
        )
        expect(written.effective.ui).toEqual({ theme: "dark" })
      } finally {
        await closeServer(server)
        await application.close()
      }
    })
  })

  it("resolves MCP cwd by provenance and reloads changes before the next Step", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const configPath = join(rootDir, "config.toml")
      const projectConfigDirectory = join(workspace, ".yakitori")
      const mcpDirectory = join(projectConfigDirectory, "tools")
      const script = join(rootDir, "cwd-mcp.mjs")
      const observedCwd = join(rootDir, "mcp-cwd.txt")
      await mkdir(mcpDirectory, { recursive: true })
      await writeFile(
        script,
        [
          "import { writeFileSync } from 'node:fs';",
          "import readline from 'node:readline';",
          "writeFileSync(process.argv[2], process.cwd());",
          "const rl=readline.createInterface({input:process.stdin});",
          "rl.on('line',(line)=>{const m=JSON.parse(line); if(m.id===undefined)return;",
          "const result=m.method==='tools/list'?{tools:[]}:{protocolVersion:m.params?.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};",
          "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});",
        ].join("\n"),
      )
      await writeFile(
        configPath,
        [
          `[projects.${JSON.stringify(workspace)}]`,
          'trust_level = "trusted"',
        ].join("\n"),
      )
      await writeFile(
        join(projectConfigDirectory, "config.toml"),
        [
          "[mcp_servers.cwd_probe]",
          `command = ${JSON.stringify(process.execPath)}`,
          `args = [${JSON.stringify(script)}, ${JSON.stringify(observedCwd)}]`,
          'cwd = "tools"',
          // The probe must have run by the time createSession returns and by
          // the first step after a config reload; required keeps that
          // deterministic now that optional servers connect in the background.
          "required = true",
        ].join("\n"),
      )

      const provider = createFauxProvider([
        { content: [{ type: "text", text: "done" }] },
      ])
      const application = await createYakitoriApplication({
        ...testApplicationOptions({ rootDir, workspace }),
        userConfigPath: configPath,
        stream: provider.stream,
      })
      try {
        const created = await application.handlers.createSession({
          workingDirectory: workspace,
        })
        expectOk(created)
        expect(await readFile(observedCwd, "utf8")).toBe(
          await realpath(mcpDirectory),
        )
        const nextDirectory = join(projectConfigDirectory, "next-tools")
        await mkdir(nextDirectory)
        const projectConfig = join(projectConfigDirectory, "config.toml")
        await writeFile(
          projectConfig,
          (await readFile(projectConfig, "utf8")).replace(
            'cwd = "tools"',
            'cwd = "next-tools"',
          ),
        )
        const admitted = await application.handlers.admitInput({
          sessionId: created.body.session.id,
          requestId: "request_mcp_reload",
          content: { kind: "text", text: "run" },
        })
        expectOk(admitted)
        await waitForThreadIdle(application, created.body.session.id)
        expect(provider.callCount).toBe(1)
        expect(await readFile(observedCwd, "utf8")).toBe(
          await realpath(nextDirectory),
        )
      } finally {
        await application.close()
      }
    })
  })

  it("pins an injected provider and model into the Turn execution context", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const provider = createFauxProvider([
        { content: [{ type: "text", text: "configured" }] },
      ])
      const application = await createYakitoriApplication({
        rootDir,
        workspace,
        userConfigPath: join(rootDir, "config.toml"),
        stream: provider.stream,
        provider: "openai",
        model: "gpt-test",
      })
      try {
        const created = await application.handlers.createSession()
        expectOk(created)
        const admitted = await application.handlers.admitInput({
          sessionId: created.body.session.id,
          requestId: "request_provider_config",
          content: { kind: "text", text: "hello" },
        })
        expectOk(admitted)
        await waitForThreadIdle(application, created.body.session.id)

        const stored = await application.threadStore.readThread(
          created.body.session.id,
        )
        expect(
          stored?.rollout.find((entry) => entry.item.type === "turn_context")
            ?.item,
        ).toMatchObject({
          context: { selection: { provider: "openai", model: "gpt-test" } },
        })
      } finally {
        await application.close()
      }
    })
  })

  it("does not let an optional provider stream bypass primary credentials", async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      await withApplicationRoot(async (rootDir, workspace) => {
        const injected = createFauxProvider([])
        await expect(
          createYakitoriApplication({
            rootDir,
            workspace,
            provider: "anthropic",
            model: "claude-test",
            providerStreams: { anthropic: injected.stream },
          }),
        ).rejects.toThrow(
          "ANTHROPIC_API_KEY is required when YAKITORI_PROVIDER=anthropic.",
        )
      })
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousApiKey
    }
  })

  it("rejects object prototype keys as unknown providers", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      await expect(
        createYakitoriApplication({
          rootDir,
          workspace,
          provider: "constructor",
          model: "unexpected",
        }),
      ).rejects.toThrow('Provider "constructor" is not configured.')
    })
  })

  it("routes an admitted next-Turn selection through another registered provider", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const primary = createFauxProvider([
        { content: [{ type: "text", text: "unused" }] },
      ])
      const selected = createFauxProvider([
        { content: [{ type: "text", text: "selected provider" }] },
      ])
      const application = await createYakitoriApplication({
        rootDir,
        workspace,
        stream: primary.stream,
        provider: "faux",
        model: "scripted",
        providerStreams: { openai: selected.stream },
      })
      try {
        const created = await application.handlers.createSession()
        expectOk(created)
        const admitted = await application.handlers.admitInput({
          sessionId: created.body.session.id,
          requestId: "request_switch_provider",
          content: { kind: "text", text: "switch" },
          modelSelection: { provider: "openai", model: "gpt-6-astra" },
        })
        expectOk(admitted)
        await waitForThreadIdle(application, created.body.session.id)

        expect(primary.callCount).toBe(0)
        expect(selected.callCount).toBe(1)
        expect(selected.requests[0]?.target).toEqual({
          provider: "openai",
          model: "gpt-6-astra",
          instructionProfileId: "gpt-6-astra",
        })
      } finally {
        await application.close()
      }
    })
  })

  it("rejects Grok selection when no executable transport is configured", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const previousApiKey = process.env.XAI_API_KEY
      const previousCredentials = process.env.GROK_CREDENTIALS
      delete process.env.XAI_API_KEY
      process.env.GROK_CREDENTIALS = join(rootDir, "missing-grok-auth.json")
      const application = await createYakitoriApplication({
        rootDir,
        workspace,
        provider: "faux",
        fauxScenario: "text",
      })
      try {
        const created = await application.handlers.createSession()
        expectOk(created)
        const admitted = await application.handlers.admitInput({
          sessionId: created.body.session.id,
          requestId: "request_switch_grok_oidc",
          content: { kind: "text", text: "use grok" },
          modelSelection: { provider: "grok", model: "grok-4.5" },
        })
        expectError(admitted, 400, ApiErrorCode.InvalidInput)
      } finally {
        await application.close()
        if (previousApiKey === undefined) delete process.env.XAI_API_KEY
        else process.env.XAI_API_KEY = previousApiKey
        if (previousCredentials === undefined)
          delete process.env.GROK_CREDENTIALS
        else process.env.GROK_CREDENTIALS = previousCredentials
      }
    })
  })

  it("reuses the default faux scenario across sequential Inputs", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const application = await createYakitoriApplication({
        rootDir,
        workspace,
        provider: "faux",
        fauxScenario: "text",
      })
      try {
        const created = await application.handlers.createSession()
        expectOk(created)
        for (const [requestId, text] of [
          ["request_first", "first"],
          ["request_second", "second"],
        ] as const) {
          const admitted = await application.handlers.admitInput({
            sessionId: created.body.session.id,
            requestId,
            content: { kind: "text", text },
          })
          expectOk(admitted)
          await waitForThreadIdle(application, created.body.session.id)
        }

        const stored = await application.threadStore.readThread(
          created.body.session.id,
        )
        const terminals = stored?.rollout.filter(
          (entry) => entry.item.type === "turn_completed",
        )
        expect(terminals).toHaveLength(2)
        expect(
          terminals?.filter(
            (entry) =>
              entry.item.type === "turn_completed" &&
              entry.item.outcome === "failed",
          ),
        ).toEqual([])
      } finally {
        await application.close()
      }
    })
  })

  it("replays idempotent admission with its durable host attributes", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const provider = createFauxProvider([
        { content: [{ type: "text", text: "once" }] },
      ])
      const application = await createYakitoriApplication({
        rootDir,
        workspace,
        stream: provider.stream,
        userConfigPath: join(rootDir, "config.toml"),
      })
      try {
        const created = await application.handlers.createSession()
        expectOk(created)
        const input = {
          sessionId: created.body.session.id,
          requestId: "request_idempotent_host",
          content: { kind: "text", text: "only once" },
          modelSelection: { provider: "faux", model: "scripted" },
          parentInputId: "input_parent",
          metadata: { source: "test" },
        }
        const admitted = await application.handlers.admitInput(input)
        expectOk(admitted)
        await waitForThreadIdle(application, created.body.session.id)
        const replayed = await application.handlers.admitInput(input)
        expectOk(replayed)
        expect(replayed.status).toBe(200)
        expect(replayed.body).toEqual(admitted.body)

        const conflicting = await application.handlers.admitInput({
          ...input,
          content: { kind: "text", text: "different" },
        })
        expectError(conflicting, 409, ApiErrorCode.Conflict)
        const read = await application.handlers.readSession({
          sessionId: created.body.session.id,
        })
        expectOk(read)
        expect(read.body.session.counts.inputs).toBe(1)
        const events = await application.handlers.readSessionEvents({
          sessionId: created.body.session.id,
        })
        expectOk(events)
        expect(
          events.body.events.filter((event) => event.type === "input.admitted"),
        ).toHaveLength(1)
        expect(admitted.body.event).toMatchObject({
          data: {
            modelSelection: input.modelSelection,
            parentInputId: input.parentInputId,
            metadata: input.metadata,
          },
        })
        expect(provider.callCount).toBe(1)
      } finally {
        await application.close()
      }
    })
  })

  it("forks, edits, and drives a Turn without touching the source Session", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const provider = createFauxProvider([
        { content: [{ type: "text", text: "first reply" }] },
        { content: [{ type: "text", text: "abandoned reply" }] },
        { content: [{ type: "text", text: "replacement reply" }] },
      ])
      const forkModelSelection = {
        provider: process.env.YAKITORI_PROVIDER ?? "faux",
        model: "fork-model",
      }
      const application = await createYakitoriApplication({
        rootDir,
        workspace,
        stream: provider.stream,
      })
      try {
        const created = await application.handlers.createSession({
          title: "Fork source",
        })
        expectOk(created)
        const first = await application.handlers.admitInput({
          sessionId: created.body.session.id,
          requestId: "request_fork_first",
          content: { kind: "text", text: "first" },
        })
        expectOk(first)
        await waitForThreadIdle(application, created.body.session.id)
        const second = await application.handlers.admitInput({
          sessionId: created.body.session.id,
          requestId: "request_fork_second",
          content: { kind: "text", text: "replace this" },
        })
        expectOk(second)
        await waitForThreadIdle(application, created.body.session.id)

        const forked = await application.handlers.forkSession({
          sessionId: created.body.session.id,
          atInputId: second.body.inputId,
          reason: "edit",
          content: { kind: "text", text: "replacement" },
          modelSelection: forkModelSelection,
        })
        expectOk(forked)
        await waitForThreadIdle(application, forked.body.session.id)

        const source = await application.threadStore.readThread(
          created.body.session.id,
        )
        const target = await application.threadStore.readThread(
          forked.body.session.id,
        )
        expect(completedTurnCount(source)).toBe(2)
        expect(userTexts(source)).toEqual(["first", "replace this"])
        expect(completedTurnCount(target)).toBe(2)
        expect(userTexts(target)).toEqual(["first", "replacement"])
        expect(target?.metadata).toMatchObject({
          parentThreadId: created.body.session.id,
          forkedFromTurnId: "request_fork_second",
          workingDirectory: application.workspace,
        })
        expect(
          target?.rollout.find(
            (entry) =>
              entry.item.type === "turn_context" &&
              entry.item.context.turnId !== "request_fork_first",
          )?.item,
        ).toMatchObject({ context: { selection: forkModelSelection } })
        expect(provider.callCount).toBe(3)
      } finally {
        await application.close()
      }
    })
  })

  it("does not expose the removed durable pending-input queue", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const application = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      try {
        const created = await application.handlers.createSession()
        expectOk(created)
        const cancelled = await application.handlers.cancelInput({
          sessionId: created.body.session.id,
          inputId: "input_00000000-0000-4000-8000-000000000000",
        })
        expectError(cancelled, 409, ApiErrorCode.Conflict)
      } finally {
        await application.close()
      }
    })
  })

  it("serves catalog models per provider and prepends a configured default outside the catalog", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const application = await createYakitoriApplication({
        rootDir,
        workspace,
        userConfigPath: join(rootDir, "config.toml"),
        stream: createFauxProvider([]).stream,
        provider: "openai",
        model: "gpt-custom-9",
        providerStreams: { grok: createFauxProvider([]).stream },
        modelDirectory: {
          async listModels(provider) {
            if (provider === "openai") {
              return [
                {
                  id: "gpt-5.1-codex",
                  displayName: "GPT-5.1 Codex",
                  instructionProfileId: "gpt-5.1-codex",
                  efforts: ["low", "medium", "high"],
                  inputModalities: ["text", "image"],
                  imageDetailModes: ["high", "original"],
                },
                {
                  id: "gpt-5",
                  displayName: "GPT-5",
                  instructionProfileId: "gpt-5",
                },
              ]
            }
            if (provider === "grok") {
              return [
                {
                  id: "grok-code-fast-1",
                  displayName: "Grok Code Fast 1",
                  instructionProfileId: "grok-4.5",
                  efforts: ["low", "medium", "high"],
                },
              ]
            }
            return []
          },
        },
      })
      const server = application.createHttpServer()
      try {
        const baseUrl = await listen(server)
        const body = await rpcRequest<ApiListProvidersResponse>(
          baseUrl,
          "provider/list",
          {},
        )

        expect(body.defaultProvider).toBe("openai")
        expect(body.defaultModel).toBe("gpt-custom-9")
        expect(body.userPreference).toBeUndefined()
        expect(
          body.providers.find((provider) => provider.name === "openai"),
        ).toEqual({
          name: "openai",
          availability: "available",
          defaultModel: "gpt-custom-9",
          models: [
            {
              id: "gpt-custom-9",
              displayName: "gpt-custom-9",
              instructionProfileId: "default",
            },
            {
              id: "gpt-5.1-codex",
              displayName: "GPT-5.1 Codex",
              instructionProfileId: "gpt-5.1-codex",
              efforts: ["low", "medium", "high"],
              inputModalities: ["text", "image"],
              imageDetailModes: ["high", "original"],
            },
            {
              id: "gpt-5",
              displayName: "GPT-5",
              instructionProfileId: "gpt-5",
            },
          ],
        })
        expect(
          body.providers.find((provider) => provider.name === "grok"),
        ).toEqual({
          name: "grok",
          availability: "available",
          rateLimits: { status: "unavailable" },
          models: [
            {
              id: "grok-code-fast-1",
              displayName: "Grok Code Fast 1",
              instructionProfileId: "grok-4.5",
              efforts: ["low", "medium", "high"],
            },
          ],
        })
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error)
              return
            }
            resolve()
          })
          server.closeAllConnections()
        })
        await application.close()
      }
    })
  })

  it("persists the user preference outside Session storage across restarts", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const userConfigPath = join(rootDir, "user-home", "config.toml")
      const options = {
        ...testApplicationOptions({ rootDir, workspace }),
        userConfigPath,
        modelDirectory: {
          async listModels() {
            return []
          },
        },
      }
      const first = await createYakitoriApplication(options)
      const firstServer = first.createHttpServer()
      try {
        const baseUrl = await listen(firstServer)
        const updated = await rpcRequest<{ userPreference: unknown }>(
          baseUrl,
          "userPreference/write",
          {
            provider: "faux",
            model: "arbitrary-model-slug",
            speed: "priority",
          },
        )
        expect(updated.userPreference).toEqual({
          provider: "faux",
          model: "arbitrary-model-slug",
          speed: "priority",
        })
      } finally {
        await closeServer(firstServer)
        await first.close()
      }

      const second = await createYakitoriApplication(options)
      const secondServer = second.createHttpServer()
      try {
        const baseUrl = await listen(secondServer)
        const body = await rpcRequest<ApiListProvidersResponse>(
          baseUrl,
          "provider/list",
          {},
        )
        expect(body.userPreference).toEqual({
          provider: "faux",
          model: "arbitrary-model-slug",
          speed: "priority",
        })
      } finally {
        await closeServer(secondServer)
        await second.close()
      }
    })
  })

  it("does not duplicate a configured default that is already in the catalog", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const application = await createYakitoriApplication({
        ...testApplicationOptions({ rootDir, workspace }),
        modelDirectory: {
          async listModels(provider) {
            if (provider === "faux") {
              return [
                {
                  id: "scripted",
                  displayName: "Scripted",
                  instructionProfileId: "default",
                },
              ]
            }
            return []
          },
        },
      })
      const server = application.createHttpServer()
      try {
        const baseUrl = await listen(server)
        const body = await rpcRequest<ApiListProvidersResponse>(
          baseUrl,
          "provider/list",
          {},
        )

        expect(
          body.providers.find((provider) => provider.name === "faux"),
        ).toEqual({
          name: "faux",
          availability: "available",
          defaultModel: "scripted",
          models: [
            {
              id: "scripted",
              displayName: "Scripted",
              instructionProfileId: "default",
            },
          ],
        })
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error)
              return
            }
            resolve()
          })
          server.closeAllConnections()
        })
        await application.close()
      }
    })
  })

  it("serves the built GUI when guiStaticDir is configured", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const guiStaticDir = join(rootDir, "gui")
      await mkdir(guiStaticDir)
      await writeFile(
        join(guiStaticDir, "index.html"),
        "<!doctype html><html><body>yakitori gui</body></html>",
      )
      const application = await createYakitoriApplication({
        ...testApplicationOptions({ rootDir, workspace }),
        guiStaticDir,
      })
      const server = application.createHttpServer()

      try {
        const baseUrl = await listen(server)

        const index = await fetch(`${baseUrl}/`)
        expect(index.status).toBe(200)
        expect(index.headers.get("content-type")).toBe(
          "text/html; charset=utf-8",
        )
        expect(await index.text()).toContain("yakitori gui")

        const fallback = await fetch(`${baseUrl}/client-side-route`)
        expect(fallback.status).toBe(200)
        expect(await fallback.text()).toContain("yakitori gui")

        const apiNotFound = await fetch(`${baseUrl}/sessions/unknown/extra`)
        expect(apiNotFound.status).toBe(404)
        expect(apiNotFound.headers.get("content-type")).toContain(
          "application/json",
        )
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error)
              return
            }
            resolve()
          })
          server.closeAllConnections()
        })
        await application.close()
      }
    })
  })

  it("resumes stored Threads on demand without startup reconciliation", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const first = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      const created = await first.handlers.createSession()
      expectOk(created)
      const admitted = await first.handlers.admitInput({
        sessionId: created.body.session.id,
        requestId: "request_before_restart",
        content: { kind: "text", text: "resume after restart" },
      })
      expectOk(admitted)
      await waitForThreadIdle(first, created.body.session.id)
      await first.close()

      const started = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      try {
        expect(started.threadManager.getThread(created.body.session.id)).toBe(
          undefined,
        )
        const read = await started.handlers.readSession({
          sessionId: created.body.session.id,
        })
        expectOk(read)
        expect(read.body.session.counts.turns).toBe(1)
        expect(started.threadManager.getThread(created.body.session.id)).toBe(
          undefined,
        )
      } finally {
        await started.close()
      }
    })
  })
})

describe("codex login registration", () => {
  const touchedEnv = [
    "YAKITORI_PROVIDER",
    "YAKITORI_MODEL",
    "YAKITORI_FAUX_SCENARIO",
    "CODEX_HOME",
    "OPENAI_API_KEY",
    "XAI_API_KEY",
    "KIMI_API_KEY",
    "GROK_CREDENTIALS",
  ] as const
  let savedEnv: Record<(typeof touchedEnv)[number], string | undefined>

  beforeEach(() => {
    savedEnv = Object.fromEntries(
      touchedEnv.map((key) => [key, process.env[key]]),
    ) as typeof savedEnv
    delete process.env.YAKITORI_PROVIDER
    delete process.env.YAKITORI_MODEL
    delete process.env.YAKITORI_FAUX_SCENARIO
    delete process.env.OPENAI_API_KEY
    delete process.env.XAI_API_KEY
    delete process.env.KIMI_API_KEY
    process.env.GROK_CREDENTIALS = join(
      process.env.CODEX_HOME ?? tmpdir(),
      "missing-grok-auth.json",
    )
  })

  afterEach(() => {
    for (const key of touchedEnv) {
      const value = savedEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  async function providersWithLogin(
    rootDir: string,
    workspace: string,
    login: unknown | undefined,
  ): Promise<ApiListProvidersResponse> {
    const codexHome = join(rootDir, "codex-home")
    await mkdir(codexHome, { recursive: true })
    if (login !== undefined) {
      await writeFile(join(codexHome, "auth.json"), JSON.stringify(login))
    }
    process.env.CODEX_HOME = codexHome
    process.env.GROK_CREDENTIALS = join(codexHome, "missing-grok-auth.json")
    const application = await createYakitoriApplication(
      testApplicationOptions({ rootDir, workspace }),
    )
    const server = application.createHttpServer()
    try {
      const baseUrl = await listen(server)
      // Await, not return: the finally below closes the server, and returning
      // a pending promise would tear it down before the RPC completes.
      return await rpcRequest<ApiListProvidersResponse>(
        baseUrl,
        "provider/list",
        {},
      )
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
        server.closeAllConnections()
      })
      await application.close()
    }
  }

  it("registers the codex provider with the curated catalog for ChatGPT logins", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const body = await providersWithLogin(rootDir, workspace, {
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: "id",
          access_token: "access",
          refresh_token: "refresh",
          account_id: "account-1",
        },
        last_refresh: "2026-08-10T00:00:00.000Z",
      })

      const codex = body.providers.find((provider) => provider.name === "codex")
      expect(codex?.models.map((model) => model.id)).toEqual([
        "gpt-6-astra",
        "gpt-6-sol",
        "gpt-6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
      ])
      expect(codex?.models[0]).toMatchObject({
        displayName: "GPT-6-Astra",
        instructionProfileId: "gpt-6-astra",
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      })
      expect(codex).toMatchObject({
        availability: "available",
        credentialKind: "oauth",
      })
    })
  })

  it("registers plain openai for API-key logins when no env key claims it", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const body = await providersWithLogin(rootDir, workspace, {
        auth_mode: "apikey",
        OPENAI_API_KEY: "sk-from-auth-json",
        tokens: null,
      })

      expect(
        body.providers.some((provider) => provider.name === "openai"),
      ).toBe(true)
      expect(
        body.providers.find((provider) => provider.name === "codex"),
      ).toMatchObject({ availability: "requires_login" })
    })
  })

  it("prefers the environment key over the auth.json API key", async () => {
    process.env.OPENAI_API_KEY = "sk-from-env"
    await withApplicationRoot(async (rootDir, workspace) => {
      const body = await providersWithLogin(rootDir, workspace, {
        auth_mode: "apikey",
        OPENAI_API_KEY: "sk-from-auth-json",
        tokens: null,
      })

      expect(
        body.providers.filter((provider) => provider.name === "openai"),
      ).toHaveLength(1)
      expect(
        body.providers.find((provider) => provider.name === "codex"),
      ).toMatchObject({ availability: "requires_login" })
    })
  })

  it("presents Codex, Grok, and Kimi login state without registering a transport", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const body = await providersWithLogin(rootDir, workspace, undefined)

      expect(
        body.providers.some((provider) => provider.name === "openai"),
      ).toBe(false)
      expect(
        Object.fromEntries(
          body.providers
            .filter((provider) =>
              ["codex", "grok", "kimi"].includes(provider.name),
            )
            .map((provider) => [provider.name, provider.availability]),
        ),
      ).toEqual({
        codex: "requires_login",
        grok: "requires_login",
        kimi: "requires_login",
      })
      expect(
        body.providers
          .filter((provider) =>
            ["codex", "grok", "kimi"].includes(provider.name),
          )
          .every(
            (provider) =>
              provider.models.length === 0 &&
              provider.rateLimits?.status === "unavailable",
          ),
      ).toBe(true)
    })
  })
})

async function withApplicationRoot(
  run: (rootDir: string, workspace: string) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "yakitori-app-"))
  const workspace = await mkdtemp(join(tmpdir(), "yakitori-workspace-"))
  try {
    await run(rootDir, workspace)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
}

async function waitForThreadIdle(
  application: YakitoriApplication,
  threadId: string,
): Promise<void> {
  const thread = application.threadManager.getThread(threadId)
  if (thread === undefined || thread.status === "idle") return
  await new Promise<void>((resolve) => {
    const unsubscribe = thread.subscribeStatus((status) => {
      if (status !== "idle") return
      unsubscribe()
      resolve()
    })
  })
}

function completedTurnCount(
  stored: Awaited<ReturnType<YakitoriApplication["threadStore"]["readThread"]>>,
): number {
  return (
    stored?.rollout.filter(
      (entry) =>
        entry.item.type === "turn_completed" &&
        entry.item.outcome === "completed",
    ).length ?? 0
  )
}

function userTexts(
  stored: Awaited<ReturnType<YakitoriApplication["threadStore"]["readThread"]>>,
): string[] {
  return (
    stored?.rollout.flatMap((entry) => {
      if (
        entry.item.type !== "response_item" ||
        entry.item.item.item.role !== "user" ||
        entry.item.item.item.context !== undefined
      ) {
        return []
      }
      return [
        entry.item.item.item.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(""),
      ]
    }) ?? []
  )
}

async function closeServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
    server.closeAllConnections()
  })
}

function pngBuffer(size: number): Buffer {
  const bytes = Buffer.alloc(Math.max(size, 24))
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(1, 16)
  bytes.writeUInt32BE(1, 20)
  return bytes
}

function expectOk<T>(
  result: ApiHandlerResult<T>,
): asserts result is Extract<ApiHandlerResult<T>, { readonly ok: true }> {
  if (!result.ok) {
    throw new Error(
      `Expected success: ${result.body.error.code}: ${result.body.error.message}`,
    )
  }
}

function expectError<T>(
  result: ApiHandlerResult<T>,
  status: number,
  code: ApiErrorCode,
): asserts result is Extract<ApiHandlerResult<T>, { readonly ok: false }> {
  if (result.ok) throw new Error("Expected error response.")
  expect(result.status).toBe(status)
  expect(result.body.error.code).toBe(code)
}
