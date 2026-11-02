import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import {
  createToolRegistry,
  plainToolName,
} from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { mapRolloutEvent } from "../../src/server/session-event-projection.ts"
import { inputFixture } from "../fixtures/user-input.ts"

const home = vi.hoisted(() => ({ path: "" }))
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => home.path,
}))

it("persists Ark encrypted tool continuation across reopening without leaking to renderer or another account/provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-ark-continuation-"))
  home.path = root
  const model = "doubao-seed-2-1-pro-260915"
  const bodies: string[] = []
  let effects = 0
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, options) => {
      bodies.push(String(options?.body))
      const id = `response_${bodies.length}`
      const chunks =
        bodies.length === 1
          ? [
              { reasoning_content: "Inspect first" },
              {
                content: "",
                reasoning_content: "",
                encrypted_content: "opaque-ark-secret",
              },
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_inspect",
                    type: "function",
                    function: { name: "inspect", arguments: "{}" },
                  },
                ],
              },
            ]
          : [{ content: "Done" }]
      return new Response(
        `${chunks.map((delta, index) => `data: ${JSON.stringify({ id, choices: [{ index: 0, delta, finish_reason: index === chunks.length - 1 ? (bodies.length === 1 ? "tool_calls" : "stop") : null }] })}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    })
  const makeManager = (scope: string) => {
    const provider = (id: string) =>
      createModelProvider({
        info: {
          id,
          wireApi: "openai_chat_completions",
          capabilities: { remoteCompaction: false },
          retry: { maxAttempts: 1 },
        },
        stream: createChatCompletionsProvider({
          apiKey: "fixture",
          model,
          baseURL: "https://ark.cn-beijing.volces.com/api/v3",
          flavor: "doubao",
        }),
        continuationScope: scope,
      })
    const registry = createProviderRegistry({
      ark: provider("ark"),
      other: provider("other"),
    })
    const store = new JsonlThreadStore({ root })
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          modelClient: registry.createClient(),
          provider: "ark",
          model,
          skills: false,
          loadProjectInstructions: async () => undefined,
          toolRegistry: createToolRegistry([
            {
              toolName: plainToolName("inspect"),
              description: "Inspect",
              inputSchema: { type: "object", properties: {} },
              effect: "observe",
              approvalRequirement: { kind: "none" },
              async execute() {
                effects += 1
                return { ok: true, output: "Seen", content: "Seen" }
              },
            },
          ]),
        }),
    })
    return { store, manager }
  }
  let runtime = makeManager("account-a")
  try {
    const thread = await runtime.manager.createThread({
      workingDirectory: root,
      mateId: "mate",
      mateRevisionId: "revision",
      initialConfiguration: SessionConfiguration.create({
        selection: { provider: "ark", model },
        workspaceRoot: root,
        enabledTools: ["inspect"],
        approvalPolicy: "always_approve",
        promptCacheKey: "ark",
      }).snapshot,
    })
    const id = thread.id
    await thread.startIfIdle({
      content: inputFixture([{ type: "text", text: "Inspect" }]),
    })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "Done" })
    expect(effects).toBe(1)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toContain('"encrypted_content":"opaque-ark-secret"')
    const stored = await runtime.store.readThread(id)
    expect(JSON.stringify(stored?.rollout)).toContain("opaque-ark-secret")
    expect(
      JSON.stringify(
        stored?.rollout.map((record) => mapRolloutEvent(record, id)),
      ),
    ).not.toContain("opaque-ark-secret")
    await runtime.manager.shutdown()
    runtime = makeManager("account-a")
    const reopened = await runtime.manager.resumeThread(id)
    if (!reopened) throw new Error("Thread missing after reopening")
    await reopened.startIfIdle({
      content: inputFixture([{ type: "text", text: "Continue" }]),
    })
    await expect.poll(() => reopened.agentStatus).toEqual({ completed: "Done" })
    expect(bodies[2]).toContain('"encrypted_content":"opaque-ark-secret"')
    await reopened.startIfIdle({
      content: inputFixture([{ type: "text", text: "Switch provider" }]),
      modelSelection: { provider: "other", model },
    })
    await expect.poll(() => reopened.agentStatus).toEqual({ completed: "Done" })
    expect(bodies[3]).not.toContain("opaque-ark-secret")
    await runtime.manager.shutdown()
    runtime = makeManager("account-b")
    const accountChanged = await runtime.manager.resumeThread(id)
    if (!accountChanged) throw new Error("Thread missing after account change")
    await accountChanged.startIfIdle({
      content: inputFixture([{ type: "text", text: "Switch account" }]),
      modelSelection: { provider: "ark", model },
    })
    await expect
      .poll(() => accountChanged.agentStatus)
      .toEqual({ completed: "Done" })
    expect(bodies[4]).not.toContain("opaque-ark-secret")
    expect(effects).toBe(1)
  } finally {
    await runtime.manager.shutdown()
    fetch.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
