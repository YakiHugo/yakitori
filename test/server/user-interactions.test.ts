import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { ModelStopReason, type StreamFn } from "../../src/runtime/model.ts"
import { createYakitoriApplication } from "../../src/server/application.ts"
import { MessageProcessor } from "../../src/server/rpc/message-processor.ts"
import {
  createElicitationBroker,
  createSessionInteractions,
} from "../../src/server/user-interactions.ts"
import { initializeConnection, openTestConnection } from "./rpc/testkit.ts"

describe("session user interactions", () => {
  it("persists a question and plan, correlates answers, and deduplicates answers after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-questions-"))
    let calls = 0
    const stream: StreamFn = async function* () {
      calls++
      yield {
        type: "response",
        response:
          calls === 1
            ? {
                stopReason: ModelStopReason.ToolUse,
                content: [
                  {
                    type: "tool_call",
                    id: "ask_destination",
                    name: "request_user_input_async",
                    input: {
                      questions: [
                        {
                          title: "Where should the report be saved?",
                          options: ["Workspace", "Downloads"],
                        },
                      ],
                    },
                  },
                  {
                    type: "tool_call",
                    id: "plan_report",
                    name: "update_plan",
                    input: {
                      plan: [
                        { step: "Choose destination", status: "in_progress" },
                      ],
                    },
                  },
                ],
              }
            : {
                stopReason: ModelStopReason.EndTurn,
                content: [
                  { type: "text", text: "I can continue when you answer." },
                ],
              },
      }
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
    let processor: MessageProcessor | undefined
    try {
      const created = await app.handlers.createSession({})
      if (!created.ok) throw new Error(created.body.error.message)
      const sessionId = created.body.session.id
      const admitted = await app.handlers.admitInput({
        sessionId,
        requestId: "prepare_report",
        content: { kind: "text", text: "Prepare a report" },
      })
      expect(admitted.ok).toBe(true)
      await vi.waitFor(() =>
        expect(app.threadManager.getThread(sessionId)?.status).toBe("idle"),
      )
      await app.close()
      app = await createYakitoriApplication(options)
      processor = new MessageProcessor({
        handlers: app.handlers,
        interactions: createSessionInteractions(
          app.threadStore,
          app.handlers,
          broker,
        ),
      })
      const connection = openTestConnection(processor)
      await initializeConnection(connection)
      const params = {
        sessionId,
        toolCallId: "ask_destination",
        answers: ["Workspace"],
      }
      const first = await connection.sendRequest(
        "session/question/answer",
        params,
      )
      expect(first).toHaveProperty("result.inputId")
      const second = await connection.sendRequest(
        "session/question/answer",
        params,
      )
      expect(second).toMatchObject(
        "result" in first ? { result: first.result } : {},
      )
      const conflicting = await connection.sendRequest(
        "session/question/answer",
        { ...params, answers: ["Downloads"] },
      )
      expect(conflicting).toHaveProperty("error")
      const missing = await connection.sendRequest("session/question/answer", {
        ...params,
        toolCallId: "not_a_question",
      })
      expect(missing).toHaveProperty("error")
      await vi.waitFor(() =>
        expect(app.threadManager.getThread(sessionId)?.status).toBe("idle"),
      )
      const stored = await app.threadStore.readThread(sessionId)
      const answers = stored?.rollout.filter(
        ({ item }) =>
          item.type === "response_item" &&
          item.item.submissionMetadata?.metadata?.userQuestionId ===
            "ask_destination",
      )
      expect(answers).toHaveLength(1)
      expect(answers?.[0]?.item).toMatchObject({
        type: "response_item",
        item: {
          item: {
            role: "user",
            content: [
              {
                type: "text",
                text: "Where should the report be saved?\nWorkspace",
              },
            ],
          },
        },
      })
      expect(
        stored?.rollout.some(
          ({ item }) =>
            item.type === "item_completed" &&
            "output" in item.item &&
            JSON.stringify(item.item.output).includes('"kind":"plan"'),
        ),
      ).toBe(true)
      await processor.closeConnection(connection.id)
      await app.close()
      app = await createYakitoriApplication(options)
      const retried = await createSessionInteractions(
        app.threadStore,
        app.handlers,
        broker,
      ).answer(params)
      expect(retried.ok).toBe(true)
      if (retried.ok && "result" in first)
        expect(retried.body).toEqual(first.result)
    } finally {
      broker.close()
      await app.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("validates elicitation answers and cancels pending requests with their owner", async () => {
    const broker = createElicitationBroker()
    const controller = new AbortController()
    const result = broker.request(
      "session_a",
      "remote",
      {
        message: "Choose a project",
        requestedSchema: {
          type: "object",
          properties: { project: { type: "string", minLength: 1 } },
          required: ["project"],
        },
      },
      controller.signal,
    )
    const requestId = broker.list("session_a")[0]?.requestId
    if (!requestId) throw new Error("Missing pending request")
    expect(broker.list("session_b")).toEqual([])
    expect(() =>
      broker.resolve("session_b", requestId, { action: "decline" }),
    ).toThrow("no longer")
    expect(() =>
      broker.resolve("session_a", requestId, { action: "accept", content: {} }),
    ).toThrow()
    expect(broker.list("session_a")).toHaveLength(1)
    controller.abort()
    await expect(result).resolves.toEqual({ action: "cancel" })
    expect(broker.list("session_a")).toEqual([])
    expect(() =>
      broker.resolve("session_a", requestId, {
        action: "accept",
        content: { project: "x" },
      }),
    ).toThrow("no longer")
    const accepted = broker.request(
      "session_a",
      "remote",
      {
        mode: "url",
        message: "Finish signing in",
        elicitationId: "login",
        url: "https://example.com/login",
      },
      new AbortController().signal,
    )
    const id = broker.list("session_a")[0]?.requestId
    if (!id) throw new Error("Missing URL request")
    broker.resolve("session_a", id, { action: "accept" })
    await expect(accepted).resolves.toEqual({ action: "accept" })
    broker.close()
  })
})
