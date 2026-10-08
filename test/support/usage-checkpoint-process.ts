import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import {
  createToolRegistry,
  plainToolName,
} from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { inputFixture } from "../fixtures/user-input.ts"

const root = process.argv[2]
if (root === undefined) throw new Error("Missing checkpoint fixture directory.")
const store = new JsonlThreadStore({ root })
let requests = 0
let secondRequestStarted!: () => void
const started = new Promise<void>((resolve) => {
  secondRequestStarted = resolve
})
const manager = new ThreadManager({
  store,
  createTurnProcessor: () =>
    createTurnProcessor({
      loadProjectInstructions: async () => undefined,
      stream: async function* () {
        requests += 1
        if (requests === 1) {
          yield {
            type: "response",
            response: {
              stopReason: "tool_use",
              content: [
                { type: "tool_call", id: "one", name: "echo", input: {} },
              ],
              usage: {
                inputTokens: 1_000_000,
                outputTokens: 1_000,
                cacheReadInputTokens: 900_000,
              },
            },
          }
        } else {
          secondRequestStarted()
          await new Promise(() => {})
        }
      },
      toolRegistry: createToolRegistry([
        {
          toolName: plainToolName("echo"),
          description: "Fixture tool",
          inputSchema: { type: "object" },
          effect: "observe",
          approvalRequirement: { kind: "none" },
          async execute() {
            return { ok: true, content: "done", output: {} }
          },
        },
      ]),
    }),
})
const thread = await manager.createThread({
  workingDirectory: root,
  mateId: "fixture",
  mateRevisionId: "fixture",
})
await thread.startIfIdle({
  content: inputFixture([{ type: "text" as const, text: "Checkpoint test" }]),
})
await started
// Exit without shutting down the manager or flushing the store: the completed
// model request's accounting barrier must already have made usage durable.
process.stdout.write(JSON.stringify({ threadId: thread.id }), () =>
  process.exit(0),
)
