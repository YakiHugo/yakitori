import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  ModelStopReason,
  type ModelRequest,
  type StreamFn,
} from "../../src/runtime/model.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { createYakitoriApplication } from "../../src/server/application.ts"
import {
  createSideChatService,
  type SideChatSnapshot,
} from "../../src/server/side-chat.ts"
import {
  createFakeHandlers,
  createTestProcessor,
  initializeConnection,
  openTestConnection,
  type TestConnection,
} from "./rpc/testkit.ts"

async function until(check: () => boolean) {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for side conversation state.")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function rpc<T>(
  connection: TestConnection,
  method: string,
  params: unknown,
): Promise<T> {
  const response = await connection.sendRequest(method, params)
  if (!("result" in response)) throw new Error(JSON.stringify(response))
  return response.result as T
}

async function fixture(stream: StreamFn) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-side-chat-"))
  const changes: SideChatSnapshot[] = []
  const errors: unknown[] = []
  const service = createSideChatService({
    defaultCwd: root,
    defaultModel: { provider: "faux", model: "first-model" },
    mateId: "test-mate",
    mateRevisionId: "test-revision",
    createProcessor: () =>
      createTurnProcessor({
        stream,
        toolRegistry: createToolRegistry([]),
        loadProjectInstructions: async () => undefined,
        baseInstructions: "Answer this independent side conversation.",
      }),
    changed: (sideChat) => {
      changes.push(sideChat)
      processor.broadcastNotification("sideChat/changed", { sideChat })
    },
    reportError: (error) => errors.push(error),
  })
  const { processor } = createTestProcessor({
    handlers: createFakeHandlers(),
    sideChats: service,
  })
  const connection = openTestConnection(processor)
  await initializeConnection(connection)
  return {
    root,
    service,
    connection,
    changes,
    errors,
    async close() {
      await service.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe("temporary side conversations", () => {
  it("admits structured context without visible text and rejects malformed annotation anchors", async () => {
    const requests: ModelRequest[] = []
    const context = await fixture(async function* (request) {
      requests.push(request)
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "context answer" }],
        },
      }
    })
    try {
      const created = await rpc<SideChatSnapshot>(
        context.connection,
        "sideChat/create",
        {},
      )
      const attachment = {
        id: "selected_context",
        kind: "selection",
        text: "quoted source text",
        source: {
          kind: "message",
          label: "Earlier answer",
          sessionId: "source",
          messageId: "answer",
        },
      }
      await rpc(context.connection, "sideChat/send", {
        sideChatId: created.id,
        requestId: "context_only",
        text: "",
        contextAttachments: [attachment],
      })
      await until(
        () => context.service.read(created.id).activeTurnId === undefined,
      )
      expect(context.service.read(created.id).messages[0]).toMatchObject({
        text: "",
        contextAttachments: [attachment],
      })
      expect(JSON.stringify(requests[0]?.messages)).toContain(
        "quoted source text",
      )
      expect(
        await context.connection.sendRequest("sideChat/send", {
          sideChatId: created.id,
          requestId: "bad_context",
          text: "",
          contextAttachments: [
            {
              ...attachment,
              kind: "annotation",
              anchor: { startOffset: 8, endOffset: 2 },
            },
          ],
        }),
      ).toMatchObject({ error: { code: -32602 } })
      expect(requests).toHaveLength(1)
    } finally {
      await context.close()
    }
  })

  it("streams an independent multi-turn history, changes models, and replays send requests idempotently", async () => {
    const requests: ModelRequest[] = []
    const context = await fixture(async function* (request) {
      requests.push(request)
      yield { type: "snapshot", text: "partial" }
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: `answer ${requests.length}` }],
        },
      }
    })
    try {
      const created = await rpc<SideChatSnapshot>(
        context.connection,
        "sideChat/create",
        {},
      )
      expect(created.modelSelection).toEqual({
        provider: "faux",
        model: "first-model",
      })
      await rpc(context.connection, "sideChat/send", {
        sideChatId: created.id,
        requestId: "first-turn",
        text: "Selected excerpt: independent context",
      })
      await until(
        () =>
          context.service
            .read(created.id)
            .messages.some((message) => message.text === "answer 1") &&
          context.service.read(created.id).activeTurnId === undefined,
      )
      const first = context.service.read(created.id)
      expect(first.messages.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "user", text: "Selected excerpt: independent context" },
        { role: "assistant", text: "answer 1" },
      ])
      expect(
        context.changes.some((change) =>
          change.messages.some(
            (message) => message.text === "partial" && message.streaming,
          ),
        ),
      ).toBe(true)
      expect(
        context.connection.notifications("sideChat/changed").length,
      ).toBeGreaterThan(0)
      await rpc(context.connection, "sideChat/send", {
        sideChatId: created.id,
        requestId: "second-turn",
        text: "Follow-up",
        modelSelection: {
          provider: "faux",
          model: "second-model",
          effort: "high",
        },
      })
      await until(
        () =>
          context.service
            .read(created.id)
            .messages.some((message) => message.text === "answer 2") &&
          context.service.read(created.id).activeTurnId === undefined,
      )
      expect(requests[1]?.target).toMatchObject({
        provider: "faux",
        model: "second-model",
      })
      expect(requests[1]?.messages).toContainEqual({
        role: "assistant",
        content: [{ type: "text", text: "answer 1" }],
      })
      expect(requests[1]?.messages).toContainEqual({
        role: "user",
        content: [{ type: "text", text: "Follow-up" }],
      })
      expect(requests.every((request) => request.tools.length === 0)).toBe(true)
      await rpc(context.connection, "sideChat/send", {
        sideChatId: created.id,
        requestId: "first-turn",
        text: "Selected excerpt: independent context",
      })
      expect(requests).toHaveLength(2)
      await rpc(context.connection, "sideChat/send", {
        sideChatId: created.id,
        requestId: "first-turn",
        text: "Selected excerpt: independent context",
        modelSelection: { model: "first-model", provider: "faux" },
      })
      expect(requests).toHaveLength(2)
      expect(
        await context.connection.sendRequest("sideChat/send", {
          sideChatId: created.id,
          requestId: "first-turn",
          text: "different",
        }),
      ).toMatchObject({ error: { data: { code: "conflict" } } })
      const revisions = context.changes.map((change) => change.revision)
      expect(
        revisions.every(
          (revision, index) =>
            index === 0 || revision > (revisions[index - 1] ?? 0),
        ),
      ).toBe(true)
      expect(context.errors).toEqual([])
    } finally {
      await context.close()
    }
  })

  it("preserves streamed prefixes on cancellation and failure and releases active streams on close", async () => {
    let calls = 0
    const aborted: number[] = []
    const context = await fixture(async function* (request) {
      const call = ++calls
      yield { type: "snapshot", text: `prefix ${call}` }
      if (call === 2) throw new Error("Fixture model failed")
      const signal = request.signal
      if (!signal) throw new Error("Expected cancellation signal")
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        )
      aborted.push(call)
      yield { type: "cancelled" }
    })
    try {
      const created = await context.service.create({})
      await context.service.send({
        sideChatId: created.id,
        requestId: "cancel-me",
        text: "first",
      })
      await until(() =>
        context.service
          .read(created.id)
          .messages.some((message) => message.text === "prefix 1"),
      )
      await context.service.cancel(created.id, "cancel-me")
      await until(
        () => context.service.read(created.id).activeTurnId === undefined,
      )
      expect(context.service.read(created.id).messages.at(-1)).toMatchObject({
        text: "prefix 1",
        streaming: false,
      })
      await context.service.send({
        sideChatId: created.id,
        requestId: "fail-me",
        text: "second",
      })
      await until(() => context.service.read(created.id).error !== undefined)
      expect(context.service.read(created.id)).toMatchObject({
        error: expect.stringContaining("Fixture model failed"),
      })
      expect(context.service.read(created.id).messages.at(-1)).toMatchObject({
        text: "prefix 2",
        streaming: false,
      })
      await context.service.send({
        sideChatId: created.id,
        requestId: "close-me",
        text: "third",
      })
      await until(() =>
        context.service
          .read(created.id)
          .messages.some((message) => message.text === "prefix 3"),
      )
      await context.service.remove(created.id)
      expect(aborted).toEqual([1, 3])
      expect(() => context.service.read(created.id)).toThrow(
        "no longer available",
      )
    } finally {
      await context.close()
    }
  })

  it("keeps side chats out of durable sessions and loses them when the application closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-side-chat-app-"))
    const options = {
      rootDir: join(root, "state"),
      workspace: root,
      userConfigPath: join(root, "config.toml"),
      provider: "openai",
      model: "gpt-test",
      stream: async function* () {
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [{ type: "text", text: "temporary answer" }],
          },
        }
      } satisfies StreamFn,
    }
    const application = await createYakitoriApplication(options)
    let restarted:
      | Awaited<ReturnType<typeof createYakitoriApplication>>
      | undefined
    try {
      const before = await readdir(application.sessionStoreRoot, {
        recursive: true,
      })
      const created = await application.sideChats.create({})
      await application.sideChats.send({
        sideChatId: created.id,
        requestId: "ephemeral-turn",
        text: "temporary secret",
      })
      await until(
        () =>
          application.sideChats
            .read(created.id)
            .messages.some((message) => message.text === "temporary answer") &&
          application.sideChats.read(created.id).activeTurnId === undefined,
      )
      expect(await application.threadStore.listThreadIds()).toEqual([])
      expect(
        await application.threadStore.readThread(created.id),
      ).toBeUndefined()
      expect(await application.threadStore.readSessionSidebar()).toMatchObject({
        entries: {},
      })
      expect(
        await readdir(application.sessionStoreRoot, { recursive: true }),
      ).toEqual(before)
      await application.close()
      restarted = await createYakitoriApplication(options)
      expect(() => restarted?.sideChats.read(created.id)).toThrow(
        "no longer available",
      )
    } finally {
      await restarted?.close()
      await application.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
