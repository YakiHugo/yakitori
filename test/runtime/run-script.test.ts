import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { SessionStatus } from "../../src/core/session-io.ts"
import { TaskCleanupError } from "../../src/core/session-task.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import { ModelStopReason } from "../../src/runtime/model.ts"
import { createPermissionGate } from "../../src/runtime/permission-gate.ts"
import { createEditFileTool } from "../../src/runtime/tools/edit-file.ts"
import { createReadFileTool } from "../../src/runtime/tools/read-file.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createRunScriptTool } from "../../src/runtime/tools/run-script.ts"
import type { RuntimeTool } from "../../src/runtime/tools/types.ts"
import { createTurnLoop } from "../../src/runtime/turn-loop.ts"
import { createFauxProvider } from "../support/faux-provider.ts"

async function fixture(
  code: string,
  extra: RuntimeTool[] = [],
  sibling = false,
) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-script-")),
    gate = createPermissionGate(),
    store = new JsonlThreadStore({ root: join(root, "store") })
  const provider = createFauxProvider([
    {
      stopReason: ModelStopReason.ToolUse,
      content: [
        {
          type: "tool_call",
          id: "script",
          name: "run_script",
          input: { code },
        },
        ...(sibling
          ? [
              {
                type: "tool_call" as const,
                id: "sibling",
                name: "sibling",
                input: {},
              },
            ]
          : []),
      ],
    },
    { content: [{ type: "text", text: "done" }] },
  ])
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () =>
      createTurnLoop({
        stream: provider.stream,
        permissionGate: gate,
        approvalPolicy: "auto_file_tools",
        toolRegistry: createToolRegistry([
          {
            ...createRunScriptTool(),
            ...(sibling ? { supportsParallelToolCalls: true } : {}),
          },
          createReadFileTool(),
          createEditFileTool(),
          ...extra,
        ]),
      }),
  })
  const thread = await manager.createThread({
    workingDirectory: root,
    mateId: "mate_test",
    mateRevisionId: "revision_test",
  })
  return {
    root,
    gate,
    store,
    manager,
    thread,
    provider,
    async start() {
      await thread.startIfIdle({ content: createUserInput("run the script") })
    },
    async finish() {
      await expect.poll(() => thread.status).toBe(SessionStatus.Idle)
      expect(thread.agentStatus).toEqual({ completed: "done" })
      return provider.requests[1]?.messages.filter(
        (item) => item.role === "tool",
      )
    },
    async close() {
      await manager.shutdown()
      await rm(root, { recursive: true, force: true })
    },
  }
}

it.each([
  false,
  true,
])("reads and edits through the normal file boundary, rejecting stale replaceAll=%s", async (stale) => {
  let root = ""
  const external: RuntimeTool = {
    toolName: { name: "external_change" },
    description: "Fixture external writer",
    inputSchema: { type: "object" },
    effect: "mutate",
    approvalRequirement: { kind: "none" },
    async execute() {
      await writeFile(join(root, "file.txt"), "external\nvalue\nvalue\n")
      return { ok: true, output: null, content: "changed" }
    },
  }
  const f = await fixture(
    `await tools.call('read_file',{path:'file.txt'}); ${stale ? "await tools.call('external_change',{});" : ""} return await tools.call('edit_file',{path:'file.txt',oldString:'value',newString:'edited',replaceAll:true})`,
    [external],
  )
  root = f.root
  try {
    await writeFile(join(root, "file.txt"), "value\nvalue\n")
    await f.start()
    const messages = await f.finish()
    expect(messages?.map((message) => message.toolCallId)).toEqual(["script"])
    expect(messages?.[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining(
            stale ? "file_changed_since_observation" : "edited",
          ),
        }),
      ]),
    )
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe(
      stale ? "external\nvalue\nvalue\n" : "edited\nedited\n",
    )
    expect(messages?.[0]?.fileObservations?.map((grant) => grant.kind)).toEqual(
      stale ? ["whole_file_read"] : ["whole_file_read", "edit"],
    )
    const persisted = await f.store.readThread(f.thread.id)
    const children = persisted?.rollout.flatMap(({ item }) =>
      item.type === "item_completed" &&
      "parentToolCallId" in item.item &&
      item.item.parentToolCallId === "script"
        ? [item.item]
        : [],
    )
    expect(children?.map((child) => child.name)).toEqual(
      stale
        ? ["read_file", "external_change", "edit_file"]
        : ["read_file", "edit_file"],
    )
  } finally {
    await f.close()
  }
})

it("retains normal approval decisions for a script's child tool", async () => {
  let effects = 0
  const f = await fixture("return await tools.call('approved',{})", [
    {
      toolName: { name: "approved" },
      description: "Approved fixture effect",
      inputSchema: { type: "object" },
      effect: "mutate",
      approvalRequirement: { kind: "approval", action: "command_execution" },
      async execute() {
        effects++
        return { ok: true, output: null, content: "effect" }
      },
    },
  ])
  try {
    await f.start()
    await expect.poll(() => f.gate.list(f.thread.id).length).toBe(1)
    expect(effects).toBe(0)
    const request = f.gate.list(f.thread.id)[0]
    if (!request) throw new Error("Missing child approval")
    expect(request.toolCallId).not.toBe("script")
    f.gate.resolve({
      sessionId: f.thread.id,
      turnId: request.turnId,
      permissionRequestId: request.permissionRequestId,
      behavior: "deny",
    })
    const messages = await f.finish()
    expect(effects).toBe(0)
    expect(messages?.[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining('"ok":false'),
        }),
      ]),
    )
  } finally {
    await f.close()
  }
})

it("holds the outer execution barrier until unawaited child effects drain", async () => {
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    order: string[] = []
  let childSignal: AbortSignal | undefined
  const tool = (
    name: string,
    execute: RuntimeTool["execute"],
  ): RuntimeTool => ({
    toolName: { name },
    description: name,
    inputSchema: { type: "object" },
    effect: "mutate",
    supportsParallelToolCalls: false,
    approvalRequirement: { kind: "none" },
    execute,
  })
  const f = await fixture(
    "tools.call('owned',{}); await tools.call('started',{}); return 1",
    [
      {
        ...tool("owned", async (_input, context) => {
          childSignal = context.signal
          order.push("child-start")
          started.resolve()
          await release.promise
          order.push("child-end")
          return { ok: true, output: null, content: "effect committed" }
        }),
        effect: "observe",
        supportsParallelToolCalls: true,
      },
      {
        ...tool("started", async () => {
          await started.promise
          return { ok: true, output: null, content: "started" }
        }),
        effect: "observe",
        supportsParallelToolCalls: true,
      },
      tool("sibling", async () => {
        order.push("sibling")
        return { ok: true, output: null, content: "sibling" }
      }),
    ],
    true,
  )
  try {
    await f.start()
    await expect.poll(() => order.includes("child-start")).toBe(true)
    await expect.poll(() => childSignal?.aborted).toBe(true)
    expect(order).toEqual(["child-start"])
    expect(f.thread.status).not.toBe(SessionStatus.Idle)
    release.resolve()
    await f.finish()
    expect(order).toEqual(["child-start", "child-end", "sibling"])
    const persisted = await f.store.readThread(f.thread.id)
    const completed = persisted?.rollout.flatMap(({ item }) =>
      item.type === "item_completed" && "toolCallId" in item.item
        ? [item.item]
        : [],
    )
    expect(
      completed
        ?.filter((item) => item.name !== "started")
        .map((item) =>
          item.toolCallId === "script"
            ? "script"
            : item.toolCallId === "sibling"
              ? "sibling"
              : "child",
        ),
    ).toEqual(["child", "script", "sibling"])
  } finally {
    release.resolve()
    await f.close()
  }
})

it("refuses recursive composition and unknown tool access without side effects", async () => {
  const f = await fixture(
    "return [await tools.call('run_script',{code:'return 1'}), await tools.call('missing',{})]",
  )
  try {
    await f.start()
    const messages = await f.finish()
    const text = messages?.[0]?.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n")
    expect(text).toContain("nested_composition_disabled")
    expect(text).toContain("unknown_tool")
    expect(f.gate.list(f.thread.id)).toEqual([])
  } finally {
    await f.close()
  }
})

it("keeps the Session occupied when a child resource cannot be cleaned up, even if guest code catches", async () => {
  const f = await fixture(
    "try { await tools.call('broken',{}) } catch {} return 'caught'",
    [
      {
        toolName: { name: "broken" },
        description: "Owned resource cleanup",
        inputSchema: { type: "object" },
        effect: "opaque",
        approvalRequirement: { kind: "none" },
        async execute() {
          throw new TaskCleanupError(new Error("Owned fixture cleanup failed"))
        },
      },
    ],
  )
  try {
    await f.start()
    await expect
      .poll(() => f.thread.agentStatus)
      .toEqual({
        errored: "Task resource cleanup failed; the Session remains occupied.",
      })
    expect(f.thread.status).toBe(SessionStatus.Active)
    expect(f.provider.requests).toHaveLength(1)
    expect(
      await f.thread.startIfIdle({ content: createUserInput("must wait") }),
    ).toEqual({ type: "not_submitted", reason: "not_idle" })
    const durable = await f.store.readThread(f.thread.id)
    expect(
      durable?.rollout.some(({ item }) => item.type === "turn_completed"),
    ).toBe(false)
  } finally {
    try {
      await expect(f.manager.shutdown()).rejects.toMatchObject({
        cause: expect.objectContaining({
          errors: expect.arrayContaining([
            expect.objectContaining({
              cause: expect.objectContaining({
                message: "Owned fixture cleanup failed",
              }),
            }),
          ]),
        }),
      })
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  }
})
