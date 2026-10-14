import { spawn } from "node:child_process"
import { once } from "node:events"
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { SessionStatus } from "../../src/core/session-io.ts"
import { TaskCleanupError } from "../../src/core/session-task.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import type { JsonObject } from "../../src/kernel/index.ts"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import {
  createHookRunner,
  HookEvent,
  hookHandlerHash,
} from "../../src/runtime/hooks.ts"
import { ModelStopReason } from "../../src/runtime/model.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import type { RuntimeTool } from "../../src/runtime/tools/types.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { createFauxProvider } from "../support/faux-provider.ts"

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

describe("turn extension boundaries", () => {
  it.each([
    { event: HookEvent.PreToolUse, toolFails: false },
    { event: HookEvent.PostToolUse, toolFails: false },
    { event: HookEvent.PostToolUse, toolFails: true },
  ])("preserves execution facts through $event rejection, HTTP serialization and restart (toolFails=$toolFails)", async ({
    event,
    toolFails,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-tool-hooks-"))
    const endpoint = await createModelEndpoint()
    const storeRoot = join(root, "store")
    const effect = join(root, "effect")
    const hookInput = join(root, "hook-input.json")
    const script = join(root, "hook.mjs")
    await writeFile(
      script,
      `import { writeFileSync } from 'node:fs'; let input = ''; for await (const chunk of process.stdin) input += chunk; writeFileSync(${JSON.stringify(hookInput)}, input); console.log(JSON.stringify({ decision: 'block', reason: 'review the committed effect', hookSpecificOutput: { additionalContext: 'check the destination before retrying' } }));`,
    )
    const handler = {
      type: "command" as const,
      command: `exec ${quote(process.execPath)} ${quote(script)}`,
    }
    const hooks = createHookRunner({
      [event]: [
        {
          matcher: "effect",
          hooks: [{ ...handler, trustedHash: hookHandlerHash(handler) }],
        },
      ],
    })
    const stream = createChatCompletionsProvider({
      apiKey: "local-test-only",
      baseURL: endpoint.url,
      model: "scripted",
    })
    const createManager = () =>
      new ThreadManager({
        store: new JsonlThreadStore({ root: storeRoot }),
        createTurnProcessor: () =>
          createTurnProcessor({
            stream,
            hookRunner: hooks,
            loadProjectInstructions: async () => undefined,
            toolRegistry: createToolRegistry([
              {
                toolName: { name: "effect" },
                description: "Append a non-idempotent effect",
                inputSchema: { type: "object" },
                effect: "mutate",
                approvalRequirement: { kind: "none" },
                async execute() {
                  await appendFile(effect, "committed\n")
                  return toolFails
                    ? {
                        ok: false,
                        code: "effect_failed",
                        message: "failed after commit",
                        content: "FAILED_AFTER_COMMIT",
                        output: { committed: true },
                      }
                    : {
                        ok: true,
                        content: "EFFECT_COMMITTED",
                        output: { committed: true },
                      }
                },
              },
            ]),
          }),
      })
    let manager = createManager()
    try {
      const thread = await manager.createThread({
        workingDirectory: root,
        mateId: "mate_test",
        mateRevisionId: "revision_test",
      })
      await thread.startIfIdle({ content: createUserInput("run the effect") })
      await expect.poll(() => thread.status).toBe(SessionStatus.Idle)
      expect(thread.agentStatus).toEqual({ completed: "done" })
      expect(endpoint.requests).toHaveLength(2)
      const sent = endpoint.requests[1]?.messages as JsonObject[]
      const toolMessage = sent.find((message) => message.role === "tool")
      expect(toolMessage?.tool_call_id).toBe("effect_call")
      const hookRequest: JsonObject = JSON.parse(
        await readFile(hookInput, "utf8"),
      )
      expect(hookRequest).toMatchObject({
        hook_event_name: event,
        tool_use_id: "effect_call",
      })
      if (event === HookEvent.PreToolUse) {
        await expect(readFile(effect, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        })
        expect(toolMessage?.content).toContain(
          "hook_blocked: review the committed effect",
        )
      } else {
        expect(await readFile(effect, "utf8")).toBe("committed\n")
        expect(hookRequest.tool_response).toEqual({ committed: true })
        expect(toolMessage?.content).toContain(
          toolFails ? "FAILED_AFTER_COMMIT" : "EFFECT_COMMITTED",
        )
        expect(toolMessage?.content).toContain("PostToolUse")
        expect(toolMessage?.content).toContain("review the committed effect")
        expect(toolMessage?.content).toContain(
          "check the destination before retrying",
        )
        expect(toolMessage?.content).not.toContain("hook_blocked:")
      }

      await manager.shutdown()
      manager = createManager()
      const restored = await manager.resumeThread(thread.id)
      if (restored === undefined) throw new Error("Thread was not restored")
      const persisted = restored
        .snapshot()
        .context.history.find(
          ({ item }) =>
            item.role === "tool" && item.toolCallId === "effect_call",
        )?.item
      expect(persisted).toMatchObject({
        role: "tool",
        ...(event === HookEvent.PreToolUse || toolFails
          ? { isError: true }
          : {}),
      })
      if (event === HookEvent.PostToolUse && !toolFails)
        expect(persisted).not.toHaveProperty("isError", true)
      await restored.startIfIdle({
        content: createUserInput("inspect the previous outcome"),
      })
      await expect.poll(() => restored.status).toBe(SessionStatus.Idle)
      expect(restored.agentStatus).toEqual({ completed: "done" })
      expect(endpoint.requests).toHaveLength(3)
      const replay = endpoint.requests[2]?.messages as JsonObject[]
      expect(replay.find((message) => message.role === "tool")).toEqual(
        toolMessage,
      )
      if (event === HookEvent.PostToolUse)
        expect(await readFile(effect, "utf8")).toBe("committed\n")
    } finally {
      await manager.shutdown()
      await hooks.dispose()
      await endpoint.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(
    ["retirement", "execution"].flatMap((failureSource) =>
      [false, true].map((interrupted) => ({ failureSource, interrupted })),
    ),
  )("keeps a Session occupied when $failureSource cannot settle an owned process (interrupted=$interrupted)", async ({
    failureSource,
    interrupted,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-resource-settlement-"))
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    )
    await once(child, "spawn")
    const childClosed = once(child, "close")
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const registry = createToolRegistry([])
    const failure = new Error("Owned process could not be closed")
    const replacement: RuntimeTool = {
      toolName: { namespace: "owned", name: "effect" },
      description: "Replacement resource",
      inputSchema: { type: "object" },
      effect: "opaque",
      approvalRequirement: { kind: "none" },
      async execute() {
        return { ok: true, content: "replacement", output: "replacement" }
      },
    }
    registry.replaceExternalSource("owned", [
      {
        ...replacement,
        async execute() {
          entered.resolve()
          if (interrupted) await release.promise
          if (failureSource === "execution") throw new TaskCleanupError(failure)
          registry.replaceExternalSource("owned", [replacement])
          return { ok: true, content: "old tool completed", output: "old" }
        },
        dispose() {
          throw failure
        },
      },
    ])
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "owned_call",
            name: "owned__effect",
            input: {},
          },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ])
    const store = new JsonlThreadStore({ root: join(root, "store") })
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: provider.stream,
          toolRegistry: registry,
          loadProjectInstructions: async () => undefined,
        }),
    })
    onTestFinished(async () => {
      release.resolve()
      child.kill("SIGKILL")
      await childClosed
      try {
        await manager.shutdown().catch((error: unknown) => {
          if (
            !(error instanceof AggregateError && error.errors.includes(failure))
          )
            throw error
        })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
    const thread = await manager.createThread({
      workingDirectory: root,
      mateId: "mate_test",
      mateRevisionId: "revision_test",
    })
    await thread.startIfIdle({
      submissionId: "owned_turn",
      content: createUserInput("run an owned resource"),
    })
    if (interrupted) {
      await entered.promise
      expect(await thread.interruptTurn("owned_turn")).toBe(true)
      release.resolve()
    }
    for (;;) {
      const event = await thread.nextEvent()
      if (event === undefined)
        throw new Error("Session closed before settlement")
      if (
        event.type === "session.error" ||
        event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.interrupted"
      ) {
        expect(event).toMatchObject({
          type: "session.error",
          message:
            "Task resource cleanup failed; the Session remains occupied.",
        })
        break
      }
    }
    expect(thread.status).toBe(SessionStatus.Active)
    expect(child.pid).toBeDefined()
    expect(() => process.kill(child.pid ?? 0, 0)).not.toThrow()
    expect(
      await thread.startIfIdle({ content: createUserInput("next turn") }),
    ).toEqual({ type: "not_submitted", reason: "not_idle" })
    const stored = await store.readThread(thread.id)
    expect(
      stored?.rollout.some(({ item }) => item.type === "turn_completed"),
    ).toBe(false)
  })
})

async function createModelEndpoint() {
  const requests: JsonObject[] = []
  const server = createServer((request, response) => {
    void (async () => {
      let body = ""
      for await (const chunk of request) body += String(chunk)
      const input: JsonObject = JSON.parse(body)
      requests.push(input)
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      const first = requests.length === 1
      response.end(
        `data: ${JSON.stringify({
          id: `response_${requests.length}`,
          object: "chat.completion.chunk",
          model: "scripted",
          created: 0,
          choices: [
            {
              index: 0,
              delta: first
                ? {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "effect_call",
                        type: "function",
                        function: { name: "effect", arguments: "{}" },
                      },
                    ],
                  }
                : { role: "assistant", content: "done" },
              finish_reason: first ? "tool_calls" : "stop",
            },
          ],
        })}\n\ndata: [DONE]\n\n`,
      )
    })().catch((error: unknown) =>
      response.destroy(
        error instanceof Error ? error : new Error(String(error)),
      ),
    )
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new Error("Missing test endpoint")
  return {
    requests,
    url: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      )
      server.closeAllConnections()
      await closed
    },
  }
}
