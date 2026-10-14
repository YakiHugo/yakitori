import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import type { ModelRequest, StreamFn } from "../../src/runtime/model.ts"
import { getInstructionProfile } from "../../src/runtime/prompt-registry.ts"
import {
  createDefaultTools,
  createToolRegistry,
} from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"

it.each([
  { label: "no search tools", names: [] },
  { label: "grep only", names: ["grep"] },
  { label: "glob only", names: ["glob"] },
  { label: "shell only", names: ["exec_command"] },
  {
    label: "dedicated tools and shell",
    names: ["grep", "glob", "exec_command"],
  },
])("maps search preferences to the actual request: $label", async ({
  names,
}) => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-search-guidance-"))
  const requests: ModelRequest[] = []
  const availableTools = createDefaultTools().filter(({ toolName }) =>
    names.includes(toolName.name),
  )
  const stream: StreamFn = async function* (request) {
    requests.push(request)
    yield {
      type: "response",
      response: {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
      },
    }
  }
  const manager = new ThreadManager({
    store: new JsonlThreadStore({ root }),
    createTurnProcessor: () =>
      createTurnProcessor({
        stream,
        provider: "codex",
        model: "gpt-5.5",
        toolRegistry: createToolRegistry(availableTools),
        loadProjectInstructions: async () => undefined,
      }),
  })
  try {
    const thread = await manager.createThread({
      workingDirectory: root,
      mateId: "test",
      mateRevisionId: "revision",
    })
    await thread.startIfIdle({
      content: createUserInput("Find the parser and its error messages."),
    })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "done" })
    expect(requests).toHaveLength(1)
    const request = requests[0]
    if (request === undefined) throw new Error("Missing request")
    expect(request.tools.map(({ name }) => name).sort()).toEqual(
      [...names].sort(),
    )
    for (const tool of availableTools) {
      expect(
        request.tools.find(({ name }) => name === tool.toolName.name)
          ?.inputSchema,
      ).toEqual(tool.inputSchema)
    }
    // Preserve the model's trained guidance and explain how it maps to this host.
    expect(request.system[0]?.text).toBe(getInstructionProfile("gpt-5.5").text)
    const guidance = request.messages
      .filter(
        (message) =>
          (message.role === "developer" || message.role === "user") &&
          message.context?.type === "world_state" &&
          message.context.sectionId === "tools",
      )
      .flatMap((message) =>
        message.content.flatMap((part) =>
          part.type === "text" ? [part.text] : [],
        ),
      )
      .join("\n")
    if (names.includes("grep")) {
      expect(guidance).toContain("Vendor tool Grep corresponds to grep.")
      expect(guidance).toContain("Prefer grep for bounded content searches.")
      expect(guidance).toContain(
        "model guidance recommending rg for search performance also applies here",
      )
    } else {
      expect(guidance).not.toMatch(/\bgrep\b/)
    }
    if (names.includes("glob")) {
      expect(guidance).toContain("Vendor tool Glob corresponds to glob.")
      expect(guidance).toContain(
        "Prefer glob for bounded file-pattern searches.",
      )
      expect(guidance).toContain(
        "counterpart of model guidance recommending rg --files",
      )
    } else {
      expect(guidance).not.toContain("glob")
    }
    if (names.includes("exec_command")) {
      expect(guidance).toContain(
        "shell pipelines or unsupported search options",
      )
      expect(guidance).toContain(
        "a suitable dedicated search tool is unavailable in this step",
      )
      expect(guidance).toContain("Follow the current permission policy.")
    } else {
      expect(guidance).not.toContain("exec_command")
    }
  } finally {
    await manager.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})
