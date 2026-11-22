import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses"
import { expect, it, onTestFinished, vi } from "vitest"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import { resolveCodexAccountIdentity } from "../../src/runtime/codex-credentials.ts"
import type { ModelProvider } from "../../src/runtime/model-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnLoop } from "../../src/runtime/turn-loop.ts"
import { createChatGPTModelConnections } from "../../src/server/chatgpt-model-connections.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { createSubscriptionProvider } from "../../src/server/subscription-provider.ts"
import { MemoryThreadStore } from "../core/memory-thread-store.ts"

const models = ["gpt-6.2-sol", "gpt-6.2-astra"]
const openAI = "https://api.openai.com/v1"
const codex = "https://chatgpt.com/backend-api/codex"

it.each([
  ...models.flatMap((model) =>
    ["codex", "chatgpt-plan", "openai"].map((route) => ({ route, model })),
  ),
  { route: "relay", model: "gpt-6.2-sol" },
  { route: "xai", model: "grok-4.7" },
])("offers the expected local file tools to $model via $route", async ({
  route,
  model,
}) => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-file-tool-requests-"))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const bodies: ResponseCreateParamsStreaming[] = []
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(url, init)
    if (
      request.method === "GET" &&
      new URL(request.url).pathname.endsWith("/models")
    )
      return Response.json({
        models: models.map((slug) => ({
          slug,
          display_name: slug,
          visibility: "list",
          shell_type: "shell_command",
          apply_patch_tool_type: "freeform",
          input_modalities: ["text", "image"],
          supports_search_tool: true,
          model_messages: {
            instructions_template: `Instructions for ${slug}.`,
          },
        })),
      })
    bodies.push(await request.json())
    const toolCall =
      route === "xai"
        ? {
            type: "function_call",
            name: "edit_file",
            arguments: JSON.stringify({
              edits: [
                { path: "created.txt", oldString: "", newString: "created\n" },
                {
                  path: "nested/second.txt",
                  oldString: "",
                  newString: "second\n",
                },
              ],
            }),
          }
        : {
            type: "custom_tool_call",
            name: "apply_patch",
            input:
              "*** Begin Patch\n*** Add File: created.txt\n+created\n*** End Patch",
            ...(route === "chatgpt-plan" ? { namespace: "yakitori" } : {}),
          }
    const output =
      bodies.length === 1 && route !== "relay"
        ? { ...toolCall, id: "tool", call_id: "create", status: "completed" }
        : {
            id: "answer",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "done", annotations: [] }],
          }
    return new Response(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "response",
          status: "completed",
          output: [output],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  })
  onTestFinished(() => {
    vi.unstubAllGlobals()
  })
  const config = {
    name: "Selected account",
    wireApi: "openai_responses" as const,
    models: [{ id: model }],
  }
  let provider: ModelProvider | undefined
  if (route === "codex") {
    const path = join(root, "auth.json")
    await writeFile(
      path,
      JSON.stringify({
        last_refresh: new Date().toISOString(),
        tokens: {
          access_token: "test-token",
          refresh_token: "test-refresh",
          account_id: "test",
        },
      }),
    )
    const owner = await resolveCodexAccountIdentity({ path })
    if (!owner) throw new Error("Missing test account")
    provider = await createSubscriptionProvider(
      "selected",
      {
        ...config,
        baseURL: codex,
        authentication: "codex_cli",
        credentialPath: path,
        credentialOwner: owner,
      },
      join(root, "cache"),
    )
  } else if (route === "chatgpt-plan") {
    const identity = { clientId: "oaiapp_test", subject: "test" }
    provider = createChatGPTModelConnections({
      resolve: async () => ({ ...identity, accessToken: "test-token" }),
    }).provider(identity, "selected")
  } else {
    const baseURL =
      route === "xai"
        ? "https://api.x.ai/v1"
        : route === "relay"
          ? "https://relay.example/v1"
          : openAI
    provider = createConfiguredProvider(
      "selected",
      {
        ...config,
        baseURL,
        service: route === "xai" ? "xai" : "openai",
      },
      "test-key",
    )
  }
  if (!provider) throw new Error("Missing test provider")
  const registry = createProviderRegistry({ selected: provider })
  const manager = new ThreadManager({
    store: new MemoryThreadStore(),
    createTurnProcessor: () =>
      createTurnLoop({
        provider: "selected",
        model,
        modelClient: registry.createClient(),
        toolRegistry: createToolRegistry(),
      }),
  })
  onTestFinished(async () => {
    await manager.shutdown()
    await registry.close()
  })
  const thread = await manager.createThread({
    workingDirectory: root,
    mateId: "mate",
    mateRevisionId: "revision",
  })
  await thread.startIfIdle({ content: createUserInput("Create created.txt.") })
  await expect.poll(() => thread.agentStatus).toEqual({ completed: "done" })
  expect(bodies).toHaveLength(route === "relay" ? 1 : 2)
  if (route !== "relay") {
    expect(await readFile(join(root, "created.txt"), "utf8")).toBe("created\n")
    expect(bodies[1]?.input).toContainEqual(
      expect.objectContaining({
        type:
          route === "xai" ? "function_call_output" : "custom_tool_call_output",
        call_id: "create",
      }),
    )
  }
  const [body] = bodies
  expect(body?.model).toBe(model)
  const topLevel = body?.tools ?? []
  const namespace = topLevel[0]
  const tools = namespace?.type === "namespace" ? namespace.tools : topLevel
  const guidance = JSON.stringify([body?.instructions, body?.input])
  if (route === "chatgpt-plan")
    expect(body?.tools).toMatchObject([{ type: "namespace", name: "yakitori" }])
  if (route === "codex")
    expect(guidance).toContain(`Instructions for ${model}.`)
  for (const name of ["read_file", "grep", "glob", "exec_command"])
    expect(tools).toContainEqual(
      expect.objectContaining({ type: "function", name }),
    )
  const editing = tools.filter(
    (tool) =>
      "name" in tool &&
      ["apply_patch", "edit_file", "write_file"].includes(tool.name),
  )
  if (route === "xai") {
    expect(editing).toMatchObject([{ type: "function", name: "edit_file" }])
    expect(guidance).toContain("empty oldString")
    expect(guidance).toContain("edits array")
    expect(await readFile(join(root, "nested/second.txt"), "utf8")).toBe(
      "second\n",
    )
    expect(guidance).not.toContain("write_file")
  } else if (route === "relay") {
    expect(editing.map((tool) => "name" in tool && tool.name).sort()).toEqual([
      "edit_file",
      "write_file",
    ])
  } else {
    expect(editing).toMatchObject([
      {
        type: "custom",
        name: "apply_patch",
        format: { type: "grammar", syntax: "lark" },
      },
    ])
  }
})
