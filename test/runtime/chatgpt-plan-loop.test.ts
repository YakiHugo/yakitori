import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { createChatGPTModelConnections } from "../../src/server/chatgpt-model-connections.ts"
import { MemoryThreadStore } from "../core/memory-thread-store.ts"

const identity = { clientId: "oaiapp_fake", subject: "fake-account" }
const providerId = "chatgpt-fake-registration"
const model = "account-only-model"

function sse(output: unknown[]) {
  return new Response(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "fake-response",
        model,
        status: "completed",
        output,
        error: null,
        incomplete_details: null,
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

function toolCall(name: string, callId: string, input: unknown) {
  return {
    id: callId,
    type: "function_call",
    call_id: callId,
    namespace: "yakitori",
    name,
    arguments: JSON.stringify(input),
    status: "completed",
  }
}

describe("ChatGPT plan registered Turn loop", () => {
  it("discovers a cold account model then searches and executes deferred local tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-chatgpt-loop-"))
    const store = new MemoryThreadStore()
    const toolRegistry = createToolRegistry([])
    const executions: unknown[] = []
    toolRegistry.replaceExternalSource("fake-calendar", [
      {
        toolName: { namespace: "calendar", name: "search_events" },
        exposure: "deferred",
        description: "Search calendar events",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        effect: "observe",
        approvalRequirement: { kind: "none" },
        async execute(input) {
          executions.push(input)
          return {
            ok: true,
            output: { events: ["planning"] },
            content: "planning",
          }
        },
      },
    ])
    const bodies: Record<string, unknown>[] = []
    const provider = createChatGPTModelConnections({
      resolve: async () => ({ ...identity, accessToken: "fake-access" }),
      fetchFn: async (url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer fake-access",
        )
        if (String(url) === "https://api.openai.com/v1/models")
          return Response.json({
            models: [
              {
                slug: model,
                display_name: "Account model",
                visibility: "list",
              },
            ],
          })
        expect(String(url)).toBe("https://api.openai.com/v1/responses")
        const body: Record<string, unknown> = JSON.parse(String(init?.body))
        bodies.push(body)
        if (bodies.length === 1)
          return sse([
            toolCall("tool_search", "search_1", { query: "calendar events" }),
          ])
        if (bodies.length === 2) {
          expect(body.input).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "function_call_output",
                call_id: "search_1",
                output: expect.stringContaining("calendar__search_events"),
              }),
            ]),
          )
          return sse([
            toolCall("use_tool", "calendar_1", {
              tool_name: "calendar__search_events",
              tool_input: { query: "planning" },
            }),
          ])
        }
        expect(body.input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "function_call_output",
              call_id: "calendar_1",
              output: "planning",
            }),
          ]),
        )
        return sse([
          {
            id: "final-message",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "Found planning", annotations: [] },
            ],
          },
        ])
      },
    }).provider(identity, providerId)
    const registry = createProviderRegistry({ [providerId]: provider })
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          modelClient: registry.createClient(),
          toolRegistry,
          loadProjectInstructions: async () => undefined,
        }),
    })
    try {
      const thread = await manager.createThread({
        workingDirectory: root,
        mateId: "mate_fake",
        mateRevisionId: "mate_revision_fake",
      })
      // No model picker or other caller has primed the account catalog.
      await thread.startIfIdle({
        content: {
          kind: "parts",
          parts: [{ type: "text", text: "Find the planning event" }],
        },
        modelSelection: { provider: providerId, model },
      })
      await expect
        .poll(() => thread.agentStatus)
        .toEqual({ completed: "Found planning" })
      expect(executions).toEqual([{ query: "planning" }])
      expect(bodies).toHaveLength(3)
      for (const body of bodies) {
        expect(body).toMatchObject({
          model,
          stream: true,
          store: false,
          tools: [
            {
              type: "namespace",
              name: "yakitori",
              tools: [
                { type: "function", name: "tool_search" },
                { type: "function", name: "use_tool" },
              ],
            },
          ],
        })
        expect(body).not.toHaveProperty("previous_response_id")
        expect(body).not.toHaveProperty("max_output_tokens")
        expect(body).not.toHaveProperty("generate")
        expect(JSON.stringify(body)).not.toContain('"type":"tool_search"')
        expect(JSON.stringify(body)).not.toContain("defer_loading")
      }
      const history = thread.snapshot().context.history.map(({ item }) => item)
      expect(history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "tool", toolCallId: "search_1" }),
          expect.objectContaining({
            role: "tool",
            toolCallId: "calendar_1",
            content: [{ type: "text", text: "planning" }],
          }),
        ]),
      )
      const persisted = await store.readThread(thread.id)
      expect(persisted?.rollout.map(({ item }) => item)).toContainEqual(
        expect.objectContaining({ type: "turn_completed" }),
      )
    } finally {
      await manager.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  })
})
