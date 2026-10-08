import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { StoredThread } from "../../src/core/rollout.ts"
import { createRolloutAssets } from "../../src/core/rollout-assets.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import { draftToEditorParts } from "../../src/gui/input-draft.ts"
import {
  type ModelRequest,
  ModelStopReason,
  type StreamFn,
} from "../../src/runtime/model.ts"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createModelRequestStream } from "../../src/runtime/model-request.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { readPdf } from "../../src/runtime/tools/read-pdf.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { createYakitoriApplication } from "../../src/server/application.ts"
import {
  createSideChatService,
  type SideChatSnapshot,
} from "../../src/server/side-chat.ts"
import { inputFixture } from "../fixtures/user-input.ts"
import { pdfFixture } from "../runtime/tools/pdf-fixture.ts"
import { readRequestAsset } from "../support/faux-provider.ts"
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

async function fixture(stream: StreamFn, now?: () => number) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-side-chat-"))
  const changes: SideChatSnapshot[] = []
  const errors: unknown[] = []
  const service = createSideChatService({
    defaultCwd: root,
    defaultModel: { provider: "faux", model: "first-model" },
    mateId: "test-mate",
    mateRevisionId: "test-revision",
    ...(now === undefined ? {} : { now }),
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
  it("renews the deadline on successful admissions and keeps expired history readable", async () => {
    const day = 24 * 60 * 60 * 1_000
    const createdAt = Date.parse("2026-01-01T00:00:00.000Z")
    let time = createdAt
    let requests = 0
    const context = await fixture(
      async function* () {
        requests++
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [{ type: "text", text: `reply ${requests}` }],
          },
        }
      },
      () => time,
    )
    try {
      const unused = await rpc<SideChatSnapshot>(
        context.connection,
        "sideChat/create",
        {},
      )
      expect(unused.expiresAt).toBe("2026-01-02T00:00:00.000Z")
      time += day - 1
      const created = await rpc<SideChatSnapshot>(
        context.connection,
        "sideChat/create",
        {},
      )
      const first = await rpc<SideChatSnapshot>(
        context.connection,
        "sideChat/send",
        {
          sideChatId: created.id,
          requestId: "first",
          content: inputFixture([{ type: "text" as const, text: "hello" }]),
        },
      )
      expect(first.expiresAt).toBe("2026-01-02T23:59:59.999Z")
      await until(
        () => context.service.read(created.id).activeTurnId === undefined,
      )
      time += day - 1
      expect(
        await context.connection.sendRequest("sideChat/send", {
          sideChatId: unused.id,
          requestId: "too-late",
          content: inputFixture([{ type: "text" as const, text: "hello" }]),
        }),
      ).toMatchObject({
        error: {
          data: { code: "conflict" },
          message: expect.stringContaining("read-only"),
        },
      })
      const second = await rpc<SideChatSnapshot>(
        context.connection,
        "sideChat/send",
        {
          sideChatId: created.id,
          requestId: "second",
          content: inputFixture([{ type: "text" as const, text: "follow-up" }]),
        },
      )
      expect(second.expiresAt).toBe("2026-01-03T23:59:59.998Z")
      await until(
        () => context.service.read(created.id).activeTurnId === undefined,
      )
      time += day
      const expired = await rpc<SideChatSnapshot>(
        context.connection,
        "sideChat/read",
        { sideChatId: created.id },
      )
      expect(expired.expiresAt).toBe(second.expiresAt)
      expect(
        expired.messages.map((message) =>
          message.role === "assistant"
            ? message.text
            : draftToEditorParts(message.content)
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join(""),
        ),
      ).toEqual(["hello", "reply 1", "follow-up", "reply 2"])
      await expect(
        context.service.importAttachmentPaths(created.id, "owner", []),
      ).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining("read-only"),
      })
      await expect(
        context.service.importAttachmentBytes(created.id, "owner", []),
      ).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining("read-only"),
      })
      const replay = await rpc<SideChatSnapshot>(
        context.connection,
        "sideChat/send",
        {
          sideChatId: created.id,
          requestId: "first",
          content: inputFixture([{ type: "text" as const, text: "hello" }]),
        },
      )
      expect(replay).toEqual(expired)
      expect(
        await context.connection.sendRequest("sideChat/send", {
          sideChatId: created.id,
          requestId: "first",
          content: inputFixture([{ type: "text" as const, text: "changed" }]),
        }),
      ).toMatchObject({ error: { data: { code: "conflict" } } })
      expect(
        await context.connection.sendRequest("sideChat/send", {
          sideChatId: created.id,
          requestId: "third",
          content: inputFixture([
            { type: "text" as const, text: "new message" },
          ]),
        }),
      ).toMatchObject({
        error: {
          data: { code: "conflict" },
          message: expect.stringContaining("read-only"),
        },
      })
      expect(requests).toBe(2)
    } finally {
      await context.close()
    }
  })

  it("lets an active turn finish after its deadline without extending the deadline", async () => {
    const createdAt = Date.parse("2026-01-01T00:00:00.000Z")
    let time = createdAt
    let finish: (() => void) | undefined
    const context = await fixture(
      async function* () {
        yield { type: "delta", text: "working" }
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [{ type: "text", text: "finished" }],
          },
        }
      },
      () => time,
    )
    try {
      const created = await context.service.create({})
      await context.service.send({
        sideChatId: created.id,
        requestId: "active",
        content: inputFixture([{ type: "text" as const, text: "question" }]),
      })
      await until(() => finish !== undefined)
      const deadline = context.service.read(created.id).expiresAt
      time = Date.parse(deadline)
      expect(
        await context.connection.sendRequest("sideChat/send", {
          sideChatId: created.id,
          requestId: "later",
          content: inputFixture([{ type: "text" as const, text: "follow-up" }]),
        }),
      ).toMatchObject({
        error: {
          data: { code: "conflict" },
          message: expect.stringContaining("read-only"),
        },
      })
      finish?.()
      await until(
        () =>
          context.service.read(created.id).activeTurnId === undefined &&
          context.service
            .read(created.id)
            .messages.filter((message) => message.role === "assistant")
            .at(-1)?.text === "finished",
      )
      expect(context.service.read(created.id)).toMatchObject({
        expiresAt: deadline,
        messages: [
          {
            role: "user",
            content: createUserInput("question"),
          },
          { role: "assistant", text: "finished", streaming: false },
        ],
      })
    } finally {
      finish?.()
      await context.close()
    }
  })

  it("allows cancellation of an active turn after expiry", async () => {
    let time = Date.parse("2026-01-01T00:00:00.000Z")
    const context = await fixture(
      async function* (request) {
        yield { type: "delta", text: "unfinished answer" }
        const signal = request.signal
        if (!signal) throw new Error("Expected cancellation signal")
        if (!signal.aborted)
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          )
        yield { type: "cancelled" }
      },
      () => time,
    )
    try {
      const created = await context.service.create({})
      await context.service.send({
        sideChatId: created.id,
        requestId: "cancel-after-expiry",
        content: inputFixture([{ type: "text" as const, text: "question" }]),
      })
      await until(() =>
        context.service
          .read(created.id)
          .messages.some(
            (message) =>
              message.role === "assistant" &&
              message.text === "unfinished answer",
          ),
      )
      time = Date.parse(context.service.read(created.id).expiresAt)
      await context.service.cancel(created.id, "cancel-after-expiry")
      await until(
        () => context.service.read(created.id).activeTurnId === undefined,
      )
      expect(context.service.read(created.id).messages.at(-1)).toMatchObject({
        text: "unfinished answer",
        streaming: false,
      })
    } finally {
      await context.close()
    }
  })

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
        content: inputFixture(
          [{ type: "text" as const, text: "" }],
          { references: [attachment] }.references,
        ),
      })
      await until(
        () => context.service.read(created.id).activeTurnId === undefined,
      )
      expect(context.service.read(created.id).messages[0]).toMatchObject({
        role: "user",
        content: inputFixture([], [attachment]),
      })
      expect(JSON.stringify(requests[0]?.messages)).toContain(
        "quoted source text",
      )
      expect(
        await context.connection.sendRequest("sideChat/send", {
          sideChatId: created.id,
          requestId: "bad_context",
          content: inputFixture(
            [{ type: "text" as const, text: "" }],
            {
              references: [
                {
                  ...attachment,
                  kind: "annotation",
                  anchor: { startOffset: 8, endOffset: 2 },
                },
              ],
            }.references,
          ),
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
      yield { type: "delta", text: "partial" }
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
        content: inputFixture([
          {
            type: "text" as const,
            text: "Selected excerpt: independent context",
          },
        ]),
      })
      await until(
        () =>
          context.service
            .read(created.id)
            .messages.some(
              (message) =>
                message.role === "assistant" && message.text === "answer 1",
            ) && context.service.read(created.id).activeTurnId === undefined,
      )
      const first = context.service.read(created.id)
      expect(
        first.messages.map((message) => ({
          role: message.role,
          text:
            message.role === "assistant"
              ? message.text
              : draftToEditorParts(message.content)
                  .flatMap((part) => (part.type === "text" ? [part.text] : []))
                  .join(""),
        })),
      ).toEqual([
        { role: "user", text: "Selected excerpt: independent context" },
        { role: "assistant", text: "answer 1" },
      ])
      expect(
        context.changes.some((change) =>
          change.messages.some(
            (message) =>
              message.role === "assistant" &&
              message.text === "partial" &&
              message.streaming,
          ),
        ),
      ).toBe(true)
      expect(
        context.connection.notifications("sideChat/changed").length,
      ).toBeGreaterThan(0)
      await rpc(context.connection, "sideChat/send", {
        sideChatId: created.id,
        requestId: "second-turn",
        modelSelection: {
          provider: "faux",
          model: "second-model",
          effort: "high",
        },
        content: inputFixture([{ type: "text" as const, text: "Follow-up" }]),
      })
      await until(
        () =>
          context.service
            .read(created.id)
            .messages.some(
              (message) =>
                message.role === "assistant" && message.text === "answer 2",
            ) && context.service.read(created.id).activeTurnId === undefined,
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
        content: inputFixture([
          {
            type: "text" as const,
            text: "Selected excerpt: independent context",
          },
        ]),
      })
      expect(requests).toHaveLength(2)
      await rpc(context.connection, "sideChat/send", {
        sideChatId: created.id,
        requestId: "first-turn",
        modelSelection: { model: "first-model", provider: "faux" },
        content: inputFixture([
          {
            type: "text" as const,
            text: "Selected excerpt: independent context",
          },
        ]),
      })
      expect(requests).toHaveLength(2)
      expect(
        await context.connection.sendRequest("sideChat/send", {
          sideChatId: created.id,
          requestId: "first-turn",
          content: inputFixture([{ type: "text" as const, text: "different" }]),
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

  it("replaces failed attempt text in a side chat before the next response completes", async () => {
    let attempts = 0
    let finish!: () => void
    const completed = new Promise<void>((resolve) => {
      finish = resolve
    })
    const context = await fixture(
      createModelRequestStream(
        async function* () {
          if (++attempts === 1) {
            yield { type: "delta", text: "discard this" }
            yield {
              type: "failure",
              failure: {
                kind: "stream_disconnected",
                stage: "response_body",
                provider: "faux",
                wireApi: "unknown",
                message: "Disconnected",
              },
            }
            return
          }
          yield { type: "delta", text: "fresh answer" }
          await completed
          yield {
            type: "response",
            response: {
              stopReason: ModelStopReason.EndTurn,
              content: [{ type: "text", text: "fresh answer" }],
            },
          }
        },
        { wireApi: "unknown", sleep: async () => {} },
      ),
    )
    try {
      const created = await context.service.create({})
      await context.service.send({
        sideChatId: created.id,
        requestId: "retry",
        content: inputFixture([{ type: "text" as const, text: "recover" }]),
      })
      await until(() =>
        context.service
          .read(created.id)
          .messages.some(
            (message) =>
              message.role === "assistant" && message.text === "fresh answer",
          ),
      )
      expect(
        context.service
          .read(created.id)
          .messages.filter((message) => message.role === "assistant"),
      ).toEqual([
        expect.objectContaining({ text: "fresh answer", streaming: true }),
      ])
      finish()
      await until(
        () => context.service.read(created.id).activeTurnId === undefined,
      )
      expect(context.service.read(created.id).messages.at(-1)).toMatchObject({
        text: "fresh answer",
        streaming: false,
      })
    } finally {
      finish()
      await context.close()
    }
  })

  it("preserves streamed prefixes on cancellation and failure and releases active streams on close", async () => {
    let calls = 0
    const aborted: number[] = []
    const context = await fixture(async function* (request) {
      const call = ++calls
      yield { type: "delta", text: `prefix ${call}` }
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
        content: inputFixture([{ type: "text" as const, text: "first" }]),
      })
      await until(() =>
        context.service
          .read(created.id)
          .messages.some(
            (message) =>
              message.role === "assistant" && message.text === "prefix 1",
          ),
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
        content: inputFixture([{ type: "text" as const, text: "second" }]),
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
        content: inputFixture([{ type: "text" as const, text: "third" }]),
      })
      await until(() =>
        context.service
          .read(created.id)
          .messages.some(
            (message) =>
              message.role === "assistant" && message.text === "prefix 3",
          ),
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

  it.each([
    "user",
    "tool",
  ] as const)("owns inherited %s PDFs through source deletion and nested side-chat close", async (origin) => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-side-pdf-"))
    const parentId = "session_parent"
    const owners = new Set([parentId])
    const assets = createRolloutAssets(root, {
      async withMutationLease(id, mutate) {
        if (!owners.has(id)) throw new Error("Missing ephemeral owner")
        await mkdir(join(root, "rollouts", id), { recursive: true })
        return mutate()
      },
      async validatePdf(bytes) {
        const result = await readPdf({ bytes, format: "native" })
        if (!result.ok) throw new Error(result.message)
      },
    })
    const bytes = pdfFixture(["Inherited PDF content"])
    const saved = await assets.saveToolFile(
      parentId,
      "parent_pdf",
      "report.pdf",
      bytes,
    )
    const document = {
      type: "document" as const,
      name: "report.pdf",
      mediaType: "application/pdf" as const,
      sizeBytes: bytes.length,
      file: saved.reference,
    }
    const createdAt = new Date().toISOString()
    const source: StoredThread = {
      metadata: {
        id: parentId,
        rolloutId: parentId,
        conversationId: parentId,
        createdAt,
        updatedAt: createdAt,
        workingDirectory: root,
      },
      rollout: [
        {
          threadId: parentId,
          rolloutId: parentId,
          seq: 0,
          createdAt,
          item: {
            type: "response_item",
            item: {
              id: "parent_content",
              turnId: "parent_turn",
              createdAt,
              item:
                origin === "user"
                  ? { role: "user", content: [document] }
                  : {
                      role: "tool",
                      toolCallId: "parent_pdf",
                      content: [document],
                    },
            },
          },
        },
        {
          threadId: parentId,
          rolloutId: parentId,
          seq: 1,
          createdAt,
          item: {
            type: "turn_completed",
            turnId: "parent_turn",
            outcome: "completed",
          },
        },
      ],
    }
    const requests: ModelRequest[] = []
    const readDocuments: Buffer[][] = []
    const providers = createProviderRegistry({
      openai: createModelProvider({
        info: {
          id: "openai",
          wireApi: "openai_responses",
          capabilities: { remoteCompaction: false, nativePdf: true },
        },
        stream: async function* (request) {
          requests.push(request)
          readDocuments.push(
            await Promise.all(
              request.messages.flatMap((message) =>
                message.role === "user"
                  ? message.content
                      .filter((block) => block.type === "document")
                      .map((document) =>
                        readRequestAsset(request, document.file),
                      )
                  : [],
              ),
            ),
          )
          yield {
            type: "response",
            response: {
              stopReason: ModelStopReason.EndTurn,
              content: [{ type: "text", text: "PDF answer" }],
            },
          }
        },
      }),
    })
    const errors: unknown[] = []
    const service = createSideChatService({
      defaultCwd: root,
      defaultModel: { provider: "openai", model: "gpt-6-astra" },
      mateId: "test-mate",
      mateRevisionId: "test-revision",
      readSource: async () => source,
      rolloutAssets: assets,
      createProcessor(stored) {
        owners.add(stored.metadata.id)
        return createTurnProcessor({
          modelClient: providers.createClient(),
          rolloutAssets: assets,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        })
      },
      async releaseAssets(id) {
        await assets.discardEphemeralRolloutFiles(id)
        owners.delete(id)
      },
      changed() {},
      reportError: (error) => errors.push(error),
    })
    try {
      const side = await service.create({ sourceSessionId: parentId })
      await assets.discardEphemeralRolloutFiles(parentId)
      await service.send({
        sideChatId: side.id,
        requestId: "side_pdf",
        content: createUserInput("Explain the PDF"),
      })
      await until(() => service.read(side.id).activeTurnId === undefined)
      const nested = await service.create({ sourceSessionId: side.id })
      await service.remove(side.id)
      const [draft] = await service.importAttachmentBytes(
        nested.id,
        "followup_draft",
        [{ name: "follow-up.pdf", data: bytes }],
      )
      if (draft?.mediaType !== "application/pdf")
        throw new Error("Missing PDF draft")
      await service.send({
        sideChatId: nested.id,
        requestId: "nested_pdf",
        content: inputFixture([
          { type: "text", text: "Explain the same PDF again" },
          { type: "document", ...draft },
          { type: "text", text: "Compare this copy" },
        ]),
      })
      await until(() => service.read(nested.id).activeTurnId === undefined)
      expect(requests).toHaveLength(2)
      for (const [index, request] of requests.entries()) {
        const documents = request.messages.flatMap((message) =>
          message.role === "user"
            ? message.content.filter((block) => block.type === "document")
            : [],
        )
        expect(documents).toHaveLength(index === 0 ? 1 : 2)
        expect(documents[0]).toMatchObject({
          name: "report.pdf",
          file: { rolloutId: index === 0 ? side.id : nested.id },
        })
        expect(readDocuments[index]).toEqual(
          Array.from({ length: index === 0 ? 1 : 2 }, () => bytes),
        )
        expect(
          JSON.stringify(
            request.messages.filter((message) => message.role === "developer"),
          ),
        ).not.toContain(bytes.toString("base64"))
      }
      expect(
        requests
          .at(-1)
          ?.messages.filter(
            (message) =>
              message.role === "user" && message.context === undefined,
          )
          .at(-1)?.content,
      ).toMatchObject([
        {
          type: "document",
          name: "follow-up.pdf",
          file: { rolloutId: nested.id },
        },
        {
          type: "text",
          text: "Explain the same PDF again[Document 1]Compare this copy",
        },
      ])
      await expect(assets.read(draft.file)).rejects.toMatchObject({
        code: "ENOENT",
      })
      expect(errors).toEqual([])
      await service.remove(nested.id)
      expect(owners).toEqual(new Set([parentId]))
      expect(await readdir(join(root, "rollouts"))).toEqual([])
      await expect(
        service.create({ sourceSessionId: parentId }),
      ).rejects.toMatchObject({ code: "ENOENT" })
      expect(owners).toEqual(new Set([parentId]))
      expect(await readdir(join(root, "rollouts"))).toEqual([])
    } finally {
      await service.close()
      await rm(root, { recursive: true, force: true })
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
        content: inputFixture([
          { type: "text" as const, text: "temporary secret" },
        ]),
      })
      await until(
        () =>
          application.sideChats
            .read(created.id)
            .messages.some(
              (message) =>
                message.role === "assistant" &&
                message.text === "temporary answer",
            ) &&
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
