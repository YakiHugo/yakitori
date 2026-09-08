import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createHookRunner,
  HookEvent,
  hookHandlerHash,
} from "../../src/runtime/hooks.ts"

describe("hook runner", () => {
  it("passes stable tool data on stdin and honors a blocking response", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-hooks-"))
    try {
      const script = join(root, "hook.mjs")
      await writeFile(
        script,
        "let input=''; for await (const chunk of process.stdin) input += chunk; const request=JSON.parse(input); console.log(JSON.stringify({decision:'block',reason:'blocked '+request.tool_name}));",
      )
      const handler = {
        type: "command" as const,
        command: `${process.execPath} ${JSON.stringify(script)}`,
      }
      const runner = createHookRunner({
        PreToolUse: [
          {
            matcher: "exec_.*",
            hooks: [{ ...handler, trustedHash: hookHandlerHash(handler) }],
          },
        ],
      })

      await expect(
        runner.run({
          event: HookEvent.PreToolUse,
          matcher: "exec_command",
          payload: { tool_name: "exec_command", tool_input: { cmd: "pwd" } },
          cwd: root,
        }),
      ).resolves.toMatchObject({
        continue: false,
        reason: "blocked exec_command",
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("ignores a handler after its pinned identity changes", async () => {
    const original = { type: "command" as const, command: "exit 2" }
    const runner = createHookRunner({
      PreToolUse: [
        {
          hooks: [
            {
              ...original,
              command: "echo changed >&2; exit 2",
              trustedHash: hookHandlerHash(original),
            },
          ],
        },
      ],
    })
    await expect(
      runner.run({
        event: HookEvent.PreToolUse,
        payload: {},
        cwd: process.cwd(),
      }),
    ).resolves.toEqual({ continue: true, additionalContext: [] })
  })

  it("does not execute an unpinned command handler", async () => {
    const runner = createHookRunner({
      PreToolUse: [{ hooks: [{ type: "command", command: "exit 2" }] }],
    })

    await expect(
      runner.run({
        event: HookEvent.PreToolUse,
        payload: {},
        cwd: process.cwd(),
      }),
    ).resolves.toEqual({ continue: true, additionalContext: [] })
  })
})
