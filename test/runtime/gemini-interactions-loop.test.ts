import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { isJsonObject, type JsonObject } from "../../src/kernel/index.ts"
import { createConfiguredModelsManager } from "../../src/runtime/configured-models-manager.ts"
import { createGeminiInteractionsProvider } from "../../src/runtime/gemini-interactions-provider.ts"
import {
  createModelProvider,
  createProviderContinuationScope,
} from "../../src/runtime/model-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import {
  createToolRegistry,
  plainToolName,
} from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { inputFixture } from "../fixtures/user-input.ts"

it("executes successive Interactions tool rounds and replays complete native steps after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-interactions-loop-"))
  await Promise.all([
    writeFile(join(root, "alpha.txt"), "alpha"),
    writeFile(join(root, "beta.txt"), "beta"),
  ])
  const requests: Array<{ path: string | undefined; body: JsonObject }> = []
  const firstThought = {
    type: "thought",
    summary: [{ type: "text", text: "Read both sources." }],
    signature: "c2lnbmF0dXJlLW9uZQ==",
  }
  const alphaCall = {
    type: "function_call",
    id: "lookup-alpha",
    name: "lookup",
    arguments: { source: "alpha" },
  }
  const betaCall = {
    type: "function_call",
    id: "lookup-beta",
    name: "lookup",
    arguments: { source: "beta" },
  }
  const secondThought = {
    type: "thought",
    summary: [{ type: "text", text: "Combine the two results." }],
    signature: "c2lnbmF0dXJlLXR3bw==",
  }
  const combineCall = {
    type: "function_call",
    id: "combine-results",
    name: "combine",
    arguments: { left: "alpha", right: "beta" },
  }
  const finalOutput = {
    type: "model_output",
    content: [{ type: "text", text: "Finished." }],
  }
  const responses = [
    [firstThought, alphaCall, betaCall],
    [secondThought, combineCall],
    [finalOutput],
    [{ type: "model_output", content: [{ type: "text", text: "Continued." }] }],
  ]
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString())
    if (!isJsonObject(body)) {
      response.writeHead(400).end()
      return
    }
    requests.push({ path: request.url, body })
    const steps = responses[requests.length - 1]
    if (steps === undefined) {
      response.writeHead(400, { "content-type": "application/json" })
      response.end(
        JSON.stringify({ error: { message: "Unexpected model request" } }),
      )
      return
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    const event = (value: JsonObject) =>
      response.write(
        `event: ${value.event_type}\ndata: ${JSON.stringify(value)}\n\n`,
      )
    const interactionId = `interaction-${requests.length}`
    event({
      event_type: "interaction.created",
      interaction: { id: interactionId, status: "in_progress" },
    })
    steps.forEach((step, index) => {
      if ("signature" in step) {
        event({ event_type: "step.start", index, step: { type: "thought" } })
        for (const content of step.summary)
          event({
            event_type: "step.delta",
            index,
            delta: { type: "thought_summary", content },
          })
        event({
          event_type: "step.delta",
          index,
          delta: { type: "thought_signature", signature: step.signature },
        })
      } else if ("arguments" in step) {
        event({
          event_type: "step.start",
          index,
          step: {
            type: "function_call",
            id: step.id,
            name: step.name,
            arguments: {},
          },
        })
        const json = JSON.stringify(step.arguments)
        for (const argumentsDelta of [json.slice(0, 8), json.slice(8)])
          event({
            event_type: "step.delta",
            index,
            delta: { type: "arguments_delta", arguments: argumentsDelta },
          })
      } else {
        event({
          event_type: "step.start",
          index,
          step: { type: "model_output" },
        })
        for (const content of step.content)
          event({
            event_type: "step.delta",
            index,
            delta: { type: "text", text: content.text },
          })
      }
      event({ event_type: "step.stop", index })
    })
    event({
      event_type: "interaction.completed",
      interaction: {
        id: interactionId,
        status: requests.length <= 2 ? "requires_action" : "completed",
        usage: {
          total_input_tokens: 100,
          total_output_tokens: 15,
          total_thought_tokens: 5,
          total_tokens: 120,
        },
      },
    })
    response.end("data: [DONE]\n\n")
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new Error("Missing server address")
  const baseURL = `http://127.0.0.1:${address.port}/v1beta`
  const managers: ThreadManager[] = []
  const effects: string[] = []
  let releaseParallel!: () => void
  const parallelStarted = new Promise<void>((resolve) => {
    releaseParallel = resolve
  })
  const createManager = () => {
    const registry = createProviderRegistry({
      work: createModelProvider({
        info: {
          id: "work",
          wireApi: "gemini_interactions",
          capabilities: {
            remoteCompaction: false,
            tools: { supportsCustomTools: false, eagerTools: true },
          },
          retry: { maxAttempts: 1 },
        },
        models: createConfiguredModelsManager({
          provider: "work",
          wireApi: "gemini_interactions",
          models: [{ id: "gemini-fixture", contextWindowTokens: 1_000_000 }],
        }),
        continuationScope: createProviderContinuationScope(
          "work",
          baseURL,
          "test",
        ),
        stream: createGeminiInteractionsProvider({
          apiKey: "test",
          model: "gemini-fixture",
          baseURL,
        }),
      }),
    })
    const manager = new ThreadManager({
      store: new JsonlThreadStore({ root }),
      createTurnProcessor: () =>
        createTurnProcessor({
          modelClient: registry.createClient(),
          provider: "work",
          model: "gemini-fixture",
          loadProjectInstructions: async () => undefined,
          toolRegistry: createToolRegistry([
            {
              toolName: plainToolName("lookup"),
              description: "Read a source",
              inputSchema: {
                type: "object",
                properties: { source: { type: "string" } },
                required: ["source"],
              },
              effect: "observe",
              supportsParallelToolCalls: true,
              approvalRequirement: { kind: "none" },
              async execute(input) {
                if (
                  !isJsonObject(input) ||
                  !["alpha", "beta"].includes(String(input.source))
                )
                  throw new Error("Unexpected lookup input")
                const source = String(input.source)
                effects.push(source)
                if (effects.includes("alpha") && effects.includes("beta"))
                  releaseParallel()
                await parallelStarted
                const text = await readFile(join(root, `${source}.txt`), "utf8")
                return { ok: true, output: text, content: text }
              },
            },
            {
              toolName: plainToolName("combine"),
              description: "Combine source results",
              inputSchema: {
                type: "object",
                properties: {
                  left: { type: "string" },
                  right: { type: "string" },
                },
                required: ["left", "right"],
              },
              effect: "mutate",
              approvalRequirement: { kind: "none" },
              async execute(input) {
                if (
                  !isJsonObject(input) ||
                  input.left !== "alpha" ||
                  input.right !== "beta"
                )
                  throw new Error("Unexpected combine input")
                effects.push("combine")
                await writeFile(join(root, "combined.txt"), "alpha + beta")
                return {
                  ok: true,
                  output: "alpha + beta",
                  content: "alpha + beta",
                }
              },
            },
          ]),
        }),
    })
    managers.push(manager)
    return manager
  }
  try {
    const manager = createManager()
    const thread = await manager.createThread({
      workingDirectory: root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    await thread.startIfIdle({
      content: inputFixture([
        { type: "text", text: "Read and combine both sources" },
      ]),
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "Finished." })
    expect(effects).toEqual(["alpha", "beta", "combine"])
    expect(await readFile(join(root, "combined.txt"), "utf8")).toBe(
      "alpha + beta",
    )
    expect(requests).toHaveLength(3)
    await manager.shutdown()

    const resumed = await createManager().resumeThread(thread.id)
    if (resumed === undefined)
      throw new Error("Missing restored Interactions thread")
    const native = resumed
      .snapshot()
      .context.history.flatMap(({ item }) =>
        item.role === "assistant" ? (item.native ?? []) : [],
      )
    const expectedOutput = [
      firstThought,
      alphaCall,
      betaCall,
      secondThought,
      combineCall,
      finalOutput,
    ]
    expect(native.map((item) => item.value)).toEqual(expectedOutput)
    for (const item of native)
      expect(item).toMatchObject({
        provider: "work",
        model: "gemini-fixture",
        wireApi: "gemini_interactions",
      })
    await resumed.startIfIdle({
      content: inputFixture([{ type: "text", text: "Continue after restart" }]),
    })
    await expect
      .poll(() => resumed.agentStatus)
      .toEqual({ completed: "Continued." })
    expect(effects).toEqual(["alpha", "beta", "combine"])
    expect(requests).toHaveLength(4)

    for (const request of requests) {
      expect(request.path?.split("?")[0]).toBe("/v1beta/interactions")
      expect(request.body).toMatchObject({
        model: "gemini-fixture",
        stream: true,
        store: false,
      })
      expect(request.body).not.toHaveProperty("previous_interaction_id")
    }
    const expectedNativeRounds = [
      [],
      [firstThought, alphaCall, betaCall],
      [firstThought, alphaCall, betaCall, secondThought, combineCall],
      expectedOutput,
    ]
    for (const [round, request] of requests.entries()) {
      const steps = request.body.input
      if (!Array.isArray(steps) || !steps.every(isJsonObject))
        throw new Error("Missing Interactions steps")
      expect(
        steps.filter((step) =>
          ["thought", "function_call", "model_output"].includes(
            String(step.type),
          ),
        ),
      ).toEqual(expectedNativeRounds[round])
      const results = steps.filter((step) => step.type === "function_result")
      expect(results).toHaveLength(round === 0 ? 0 : round === 1 ? 2 : 3)
      for (const [id, name, text] of [
        ["lookup-alpha", "lookup", "alpha"],
        ["lookup-beta", "lookup", "beta"],
        ...(round >= 2 ? [["combine-results", "combine", "alpha + beta"]] : []),
      ]) {
        if (round === 0) break
        const result = results.find((step) => step.call_id === id)
        expect(result).toMatchObject({
          type: "function_result",
          call_id: id,
          name,
          result: [{ type: "text", text }],
        })
        expect(result?.is_error ?? false).toBe(false)
      }
      expect(
        steps
          .filter((step) =>
            [
              "thought",
              "function_call",
              "function_result",
              "model_output",
            ].includes(String(step.type)),
          )
          .map((step) => step.type),
      ).toEqual([
        ...(round >= 1
          ? [
              "thought",
              "function_call",
              "function_call",
              "function_result",
              "function_result",
            ]
          : []),
        ...(round >= 2 ? ["thought", "function_call", "function_result"] : []),
        ...(round >= 3 ? ["model_output"] : []),
      ])
    }
    expect(JSON.stringify(requests.at(-1)?.body.input)).toContain(
      "Continue after restart",
    )
  } finally {
    releaseParallel()
    for (const manager of managers.reverse()) await manager.shutdown()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(root, { recursive: true, force: true })
  }
})
