import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import { createSubscriptionProvider } from "../../src/server/subscription-provider.ts"
import { resolveCodexAccountIdentity } from "../../src/runtime/codex-credentials.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnLoop } from "../../src/runtime/turn-loop.ts"
import { MemoryThreadStore } from "../core/memory-thread-store.ts"

it.each([
  { accountId: undefined, nextAccountId: undefined, allowed: false },
  { accountId: undefined, nextAccountId: "account-B", allowed: false },
  { accountId: "account-A", nextAccountId: "account-A", allowed: true },
])("keeps the selected Codex owner through Step preparation: $accountId to $nextAccountId", async ({
  accountId,
  nextAccountId,
  allowed,
}) => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-subscription-owner-"))
  const path = join(root, "auth.json")
  const credentials = (accessToken: string, id: string | undefined) =>
    JSON.stringify({
      last_refresh: new Date().toISOString(),
      tokens: {
        access_token: accessToken,
        refresh_token: `refresh-${accessToken}`,
        ...(id === undefined ? {} : { account_id: id }),
      },
    })
  await writeFile(path, credentials("first-token", accountId))
  const owner = await resolveCodexAccountIdentity({ path })
  if (owner === undefined) throw new Error("Missing fixture owner")
  let inferences = 0
  const fetchFn = vi.fn<typeof fetch>(async (url) => {
    if (String(url).includes("/models"))
      return Response.json({
        models: [{ slug: "gpt-6-sol", context_window: 100_000 }],
      })
    inferences++
    return new Response(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "response",
          status: "completed",
          output: [
            {
              id: "answer",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "done", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  })
  vi.stubGlobal("fetch", fetchFn)
  const provider = await createSubscriptionProvider(
    "selected",
    {
      name: "Selected account",
      wireApi: "openai_responses",
      baseURL: "https://chatgpt.com/backend-api/codex",
      models: [],
      authentication: "codex_cli",
      credentialPath: path,
      credentialOwner: owner,
    },
    join(root, "cache"),
  )
  if (provider === undefined) throw new Error("Fixture account was not bound")
  const registry = createProviderRegistry({ selected: provider })
  const manager = new ThreadManager({
    store: new MemoryThreadStore(),
    createTurnProcessor: () =>
      createTurnLoop({
        provider: "selected",
        model: "gpt-6-sol",
        modelClient: registry.createClient(),
        toolRegistry: createToolRegistry([]),
        async prepareStepContext() {
          // Catalog identity was already validated. Credential resolution must
          // still fence the request after later asynchronous preparation.
          await writeFile(path, credentials("second-token", nextAccountId))
          return {}
        },
      }),
  })
  try {
    const thread = await manager.createThread({
      workingDirectory: root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    await thread.startIfIdle({
      content: createUserInput("Private selected-account history"),
    })
    await expect.poll(() => thread.status).toBe("idle")
    expect(fetchFn).toHaveBeenCalled()
    expect(inferences).toBe(allowed ? 1 : 0)
    expect(thread.agentStatus).toEqual(
      allowed
        ? { completed: "done" }
        : { errored: expect.stringContaining("changed accounts") },
    )
  } finally {
    await manager.shutdown()
    await registry.close()
    vi.unstubAllGlobals()
    await rm(root, { recursive: true, force: true })
  }
})
