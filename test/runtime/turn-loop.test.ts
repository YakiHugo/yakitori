import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import type { ModelRequest, StreamFn } from "../../src/runtime/model.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createWriteFileTool } from "../../src/runtime/tools/write-file.ts"
import { createTurnLoop } from "../../src/runtime/turn-loop.ts"

it("executes a real file tool and recovers durable completion without native context capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-bare-loop-"))
  const skillDir = join(root, ".agents", "skills", "demo")
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(root, "AGENTS.md"), "ProjectCapabilityMarker")
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: demo\ndescription: SkillCapabilityMarker\n---\nSkillBodyMarker",
  )
  const requests: ModelRequest[] = []
  const stream: StreamFn = async function* (request) {
    requests.push(request)
    yield {
      type: "response",
      response:
        requests.length === 1
          ? {
              stopReason: "tool_use",
              content: [
                {
                  type: "tool_call",
                  id: "write_once",
                  name: "write_file",
                  input: { path: "result.txt", content: "durable effect" },
                },
              ],
            }
          : {
              stopReason: "end_turn",
              content: [{ type: "text", text: "completed with a tool" }],
            },
    }
  }
  const store = new JsonlThreadStore({ root: join(root, "store") })
  const createManager = () =>
    new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnLoop({
          stream,
          toolRegistry: createToolRegistry([createWriteFileTool()]),
        }),
    })
  const manager = createManager()
  let restarted: ThreadManager | undefined
  try {
    const thread = await manager.createThread({
      workingDirectory: root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    await thread.startIfIdle({
      submissionId: "base_turn",
      content: createUserInput("$demo write a result"),
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "completed with a tool" })
    expect(await readFile(join(root, "result.txt"), "utf8")).toBe(
      "durable effect",
    )
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("write_once")
    expect(JSON.stringify(requests)).not.toMatch(
      /ProjectCapabilityMarker|SkillCapabilityMarker|SkillBodyMarker/,
    )
    const durable = await store.readThread(thread.id)
    expect(
      durable?.rollout.filter(({ item }) => item.type === "turn_completed"),
    ).toMatchObject([{ item: { turnId: "base_turn", outcome: "completed" } }])
    await manager.shutdown()
    restarted = createManager()
    const recovered = await restarted.resumeThread(thread.id)
    expect(recovered?.agentStatus).toEqual({
      completed: "completed with a tool",
    })
    expect(JSON.stringify(recovered?.snapshot().context.history)).toContain(
      "write_once",
    )
    expect(requests).toHaveLength(2)
  } finally {
    await manager.shutdown()
    await restarted?.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})
