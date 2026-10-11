import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { createFauxProvider } from "../support/faux-provider.ts"

it("restores and forks historical default tools without rewriting persisted history or instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-collaboration-defaults-"))
  const oldStore = new JsonlThreadStore({ root })
  const selection = { provider: "faux", model: "scripted" }
  const { collaborationToolsVersion: _version, ...legacy } =
    SessionConfiguration.create({
      selection,
      workspaceRoot: root,
      promptCacheKey: "old-cache-identity",
      approvalPolicy: "always_approve",
      baseInstructions: "Keep these explicit persisted instructions.",
      enabledTools: [
        "read_file",
        "view_image",
        "read_document",
        "grep",
        "glob",
        "edit_file",
        "write_file",
        "apply_patch",
        "exec_command",
        "write_stdin",
        "web_fetch",
        "web_search",
        "request_user_input_async",
        "spawn_agent",
        "send_message",
        "followup_task",
        "wait_agent",
        "interrupt_agent",
        "list_agents",
      ],
    }).snapshot
  const createdAt = "2026-10-01T00:00:00Z"
  const old = await oldStore.createThread({
    id: "historical-root",
    conversationId: "historical-root",
    createdAt,
    updatedAt: createdAt,
    workingDirectory: root,
    mateId: "mate-test",
    mateRevisionId: "mate-revision-test",
  })
  await oldStore.persistThread(old.metadata.id, "turn_start")
  for (const turnId of ["legacy-first", "legacy-cut"]) {
    await oldStore.appendItems(old.metadata.id, [
      {
        type: "turn_context",
        context: { turnId, selection, configuration: legacy },
      },
      { type: "turn_started", turnId, inputItemId: `${turnId}-input` },
      {
        type: "response_item",
        item: {
          id: `${turnId}-input`,
          turnId,
          createdAt,
          item: { role: "user", content: [{ type: "text", text: turnId }] },
        },
      },
      { type: "turn_completed", turnId, outcome: "completed" },
    ])
  }
  await oldStore.shutdownThread(old.metadata.id)
  const rolloutPath = join(
    root,
    "rollouts",
    old.metadata.rolloutId,
    "rollout.jsonl",
  )
  const originalBytes = await readFile(rolloutPath, "utf8")
  const provider = createFauxProvider(
    Array.from({ length: 2 }, () => ({
      assertRequest(request) {
        expect(request.tools.map(({ name }) => name)).toEqual(
          expect.arrayContaining([
            "list_threads",
            "read_thread",
            "send_message_to_thread",
            "wait_threads",
          ]),
        )
        expect(request.system[0]?.text).toBe(
          "Keep these explicit persisted instructions.",
        )
      },
      content: [{ type: "text" as const, text: "recovered" }],
    })),
  )
  const store = new JsonlThreadStore({ root })
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () =>
      createTurnProcessor({
        stream: provider.stream,
        loadProjectInstructions: async () => undefined,
        baseInstructions:
          "A newer host default must not replace persisted instructions.",
      }),
  })
  try {
    const source = await manager.resumeThread(old.metadata.id)
    if (source === undefined) throw new Error("Missing historical thread")
    const { thread: fork } = await manager.forkThread({
      sourceThreadId: source.id,
      beforeTurnId: "legacy-cut",
    })
    expect(await readFile(rolloutPath, "utf8")).toBe(originalBytes)
    for (const thread of [fork, source]) {
      await thread.startIfIdle({ content: createUserInput("continue") })
      await expect
        .poll(() => thread.agentStatus)
        .toEqual({ completed: "recovered" })
      const stored = await store.readThread(thread.id)
      const configurations = stored?.rollout.flatMap(({ item }) =>
        item.type === "turn_context" ? [item.context.configuration] : [],
      )
      expect(configurations?.[0]).toEqual(legacy)
      expect(configurations?.at(-1)?.collaborationToolsVersion).toBe(2)
    }
    expect(
      (await readFile(rolloutPath, "utf8")).startsWith(originalBytes),
    ).toBe(true)
  } finally {
    await manager.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})
