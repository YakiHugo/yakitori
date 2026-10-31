import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { SessionStatus } from "../../src/core/session-io.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import { ModelStopReason } from "../../src/runtime/model.ts"
import { createPermissionGate } from "../../src/runtime/permission-gate.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import type { ToolExecutionContext } from "../../src/runtime/tools/types.ts"
import { createTurnLoop } from "../../src/runtime/turn-loop.ts"
import { createFauxProvider } from "../support/faux-provider.ts"

it.each([
  "allow",
  "deny",
] as const)("keeps nested %s decisions and effects durable without inventing model tool calls", async (behavior) => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-composed-tools-")),
    effect = join(root, "effect"),
    store = new JsonlThreadStore({ root: join(root, "store") }),
    gate = createPermissionGate(),
    provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          { type: "tool_call", id: "compose_call", name: "compose", input: {} },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ])
  let effects = 0,
    replyWasDurable = false,
    lateCalls: ToolExecutionContext["toolCalls"]
  const createManager = () =>
    new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnLoop({
          stream: provider.stream,
          permissionGate: gate,
          approvalPolicy: "auto_file_tools",
          toolRegistry: createToolRegistry([
            {
              toolName: { name: "compose" },
              description: "Compose a tool",
              inputSchema: { type: "object" },
              effect: "opaque",
              composesTools: true,
              supportsParallelToolCalls: false,
              approvalRequirement: { kind: "none" },
              async execute(_input, context) {
                if (!context.toolCalls || !context.threadId)
                  throw new Error("Missing composed execution scope")
                lateCalls = context.toolCalls
                const child = await context.toolCalls.execute("effect", {})
                const durable = await store.readThread(context.threadId)
                replyWasDurable =
                  durable?.rollout.some(
                    ({ item }) =>
                      item.type === "item_completed" &&
                      "toolCallId" in item.item &&
                      item.item.toolCallId === child.toolCallId,
                  ) ?? false
                return {
                  ok: true,
                  content: JSON.stringify({ childOk: child.result.ok }),
                  output: { childOk: child.result.ok },
                }
              },
            },
            {
              toolName: { name: "effect" },
              description: "An approved effect",
              inputSchema: { type: "object" },
              effect: "mutate",
              supportsParallelToolCalls: false,
              approvalRequirement: {
                kind: "approval",
                action: "command_execution",
              },
              async execute(_input, context) {
                if (!context.threadId) throw new Error("Missing child session")
                const durable = await store.readThread(context.threadId)
                expect(
                  durable?.rollout.some(
                    ({ item }) =>
                      item.type === "item_started" &&
                      "toolCallId" in item.item &&
                      item.item.toolCallId === context.toolCallId &&
                      item.item.parentToolCallId === "compose_call",
                  ),
                ).toBe(true)
                effects++
                await writeFile(effect, "nested effect")
                return {
                  ok: true,
                  content: "nested effect",
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
    await thread.startIfIdle({ content: createUserInput("compose an effect") })
    await expect
      .poll(
        () =>
          gate.list(thread.id).length > 0 ||
          thread.status === SessionStatus.Idle,
      )
      .toBe(true)
    expect(
      gate.list(thread.id),
      JSON.stringify(thread.snapshot().context.history),
    ).toHaveLength(1)
    expect(effects).toBe(0)
    const request = gate.list(thread.id)[0]
    if (!request) throw new Error("Missing nested permission request")
    expect(request.toolCallId).not.toBe("compose_call")
    gate.resolve({
      sessionId: thread.id,
      turnId: request.turnId,
      permissionRequestId: request.permissionRequestId,
      behavior,
    })
    await expect.poll(() => thread.status).toBe(SessionStatus.Idle)
    expect(thread.agentStatus).toEqual({ completed: "done" })
    expect(replyWasDurable).toBe(true)
    await expect(lateCalls?.execute("effect", {})).rejects.toThrow(
      "closed its child execution scope",
    )
    expect(effects).toBe(behavior === "allow" ? 1 : 0)
    if (behavior === "allow")
      expect(await readFile(effect, "utf8")).toBe("nested effect")
    else
      await expect(readFile(effect, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      })
    expect(
      provider.requests[1]?.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.toolCallId),
    ).toEqual(["compose_call"])
    const durable = await store.readThread(thread.id)
    const completed =
      durable?.rollout.flatMap(({ item }) =>
        item.type === "item_completed" && "toolCallId" in item.item
          ? [item.item]
          : [],
      ) ?? []
    const parent = completed.find((item) => item.toolCallId === "compose_call")
    const child = completed.find(
      (item) => item.parentToolCallId === "compose_call",
    )
    expect(parent?.modelCallId).toBeTypeOf("string")
    expect(child?.modelCallId).toBe(parent?.modelCallId)
    expect(
      durable?.rollout.filter(
        ({ item }) =>
          item.type === "item_completed" &&
          "toolCallId" in item.item &&
          item.item.parentToolCallId === "compose_call",
      ),
    ).toHaveLength(1)
    await manager.shutdown()
    manager = createManager()
    const restored = await manager.resumeThread(thread.id)
    expect(
      restored
        ?.snapshot()
        .context.history.flatMap(({ item }) =>
          item.role === "tool" ? [item.toolCallId] : [],
        ),
    ).toEqual(["compose_call"])
    expect(effects).toBe(behavior === "allow" ? 1 : 0)
  } finally {
    await manager.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})
