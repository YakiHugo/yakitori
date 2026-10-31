import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { SessionStatus } from "../../src/core/session-io.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import {
  createHookRunner,
  HookEvent,
  hookHandlerHash,
} from "../../src/runtime/hooks.ts"
import { ModelStopReason } from "../../src/runtime/model.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnLoop } from "../../src/runtime/turn-loop.ts"
import { createFauxProvider } from "../support/faux-provider.ts"

it.each([
  false,
  true,
])("persists a completed tool effect when its post hook is interrupted and recovers it without replay (toolFails=%s)", async (toolFails) => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-post-hook-cancel-")),
    ready = join(root, "hook-ready"),
    effect = join(root, "effect"),
    script = join(root, "hook.mjs"),
    store = new JsonlThreadStore({ root: join(root, "store") })
  await writeFile(
    script,
    `import {writeFileSync} from 'node:fs';for await(const _ of process.stdin){};writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`,
  )
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`,
    handler = {
      type: "command" as const,
      command: `exec ${quote(process.execPath)} ${quote(script)}`,
    },
    hooks = createHookRunner({
      [HookEvent.PostToolUse]: [
        {
          matcher: "effect",
          hooks: [{ ...handler, trustedHash: hookHandlerHash(handler) }],
        },
      ],
    }),
    provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          { type: "tool_call", id: "effect_call", name: "effect", input: {} },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ])
  let effects = 0
  const createManager = () =>
    new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnLoop({
          stream: provider.stream,
          hookRunner: hooks,
          toolRegistry: createToolRegistry([
            {
              toolName: { name: "effect" },
              description: "Commit an owned effect",
              inputSchema: { type: "object" },
              effect: "mutate",
              approvalRequirement: { kind: "none" },
              async execute() {
                effects++
                await writeFile(effect, "committed exactly once")
                return toolFails
                  ? {
                      ok: false,
                      code: "effect_failed",
                      message: "Failed after commit",
                      content: "EFFECT_FAILED_AFTER_COMMIT",
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
    await thread.startIfIdle({
      submissionId: "post_hook_turn",
      content: createUserInput("commit the effect"),
    })
    await expect
      .poll(async () => {
        try {
          return Number(await readFile(ready, "utf8"))
        } catch (cause) {
          if (
            cause instanceof Error &&
            "code" in cause &&
            cause.code === "ENOENT"
          )
            return 0
          throw cause
        }
      })
      .toBeGreaterThan(0)
    const hookPid = Number(await readFile(ready, "utf8"))
    expect(await thread.interruptTurn("post_hook_turn")).toBe(true)
    await expect.poll(() => thread.status).toBe(SessionStatus.Idle)
    expect(() => process.kill(hookPid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    )
    expect(await readFile(effect, "utf8")).toBe("committed exactly once")
    const durable = await store.readThread(thread.id)
    const completion = durable?.rollout.flatMap(({ item }) =>
      item.type === "item_completed" &&
      "toolCallId" in item.item &&
      item.item.toolCallId === "effect_call"
        ? [item.item]
        : [],
    )
    expect(completion).toMatchObject([
      {
        output: { committed: true },
        ...(toolFails ? { error: { code: "effect_failed" } } : {}),
      },
    ])
    if (!toolFails) expect(completion?.[0]).not.toHaveProperty("error")
    await manager.shutdown()
    manager = createManager()
    const restored = await manager.resumeThread(thread.id)
    expect(
      restored
        ?.snapshot()
        .context.history.find(
          ({ item }) =>
            item.role === "tool" && item.toolCallId === "effect_call",
        )?.item,
    ).toMatchObject({
      role: "tool",
      ...(toolFails ? { isError: true } : {}),
      content: expect.arrayContaining([
        {
          type: "text",
          text: expect.stringContaining(
            toolFails ? "EFFECT_FAILED_AFTER_COMMIT" : "EFFECT_COMMITTED",
          ),
        },
        {
          type: "text",
          text: expect.stringContaining("PostToolUse was interrupted"),
        },
      ]),
    })
    expect(effects).toBe(1)
  } finally {
    await manager.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})
