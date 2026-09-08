import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createHookRunner,
  HookEvent,
  hookHandlerHash,
} from "../../src/runtime/hooks.ts"

describe("hook runner", () => {
  it("waits for SessionEnd hooks even when they are configured async", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-hooks-"))
    try {
      const output = join(root, "ended.txt")
      const handler = {
        type: "command" as const,
        command: `${process.execPath} -e ${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(output)},'done'),25)`)}`,
        async: true,
      }
      const runner = createHookRunner({
        SessionEnd: [
          { hooks: [{ ...handler, trustedHash: hookHandlerHash(handler) }] },
        ],
      })

      await runner.run({
        event: HookEvent.SessionEnd,
        payload: {},
        cwd: root,
      })

      await expect(readFile(output, "utf8")).resolves.toBe("done")
      await runner.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("terminates and joins owned async hooks during disposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-hooks-"))
    try {
      const started = join(root, "started.txt")
      const stopped = join(root, "stopped.txt")
      const script = join(root, "async-hook.mjs")
      await writeFile(
        script,
        `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(started)},'yes'); process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(stopped)},'yes');process.exit(0)}); setInterval(()=>{},1000);`,
      )
      const handler = {
        type: "command" as const,
        command: `exec ${process.execPath} ${JSON.stringify(script)}`,
        async: true,
      }
      const runner = createHookRunner({
        UserPromptSubmit: [
          { hooks: [{ ...handler, trustedHash: hookHandlerHash(handler) }] },
        ],
      })
      await runner.run({
        event: HookEvent.UserPromptSubmit,
        payload: {},
        cwd: root,
      })
      await expect
        .poll(() => readFile(started, "utf8").catch(() => undefined))
        .toBe("yes")

      await runner.dispose()

      await expect(readFile(stopped, "utf8")).resolves.toBe("yes")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

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
