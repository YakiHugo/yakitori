import { existsSync } from "node:fs"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createUserShellEnv } from "../../../src/runtime/user-shell-env.ts"
import {
  createUnifiedExecProcessManager,
  createUnifiedExecTools,
  type UnifiedExecOutput,
} from "../../../src/runtime/tools/unified-exec.ts"

const context = { workspaceRoot: process.cwd() }

describe("unified exec tools", () => {
  it("exposes the Codex exec_command and write_stdin contracts", () => {
    const [execCommand, writeStdin] = createUnifiedExecTools()

    expect(execCommand).toMatchObject({
      toolName: { name: "exec_command" },
      supportsParallelToolCalls: true,
      inputSchema: { required: ["cmd"] },
    })
    expect(writeStdin).toMatchObject({
      toolName: { name: "write_stdin" },
      supportsParallelToolCalls: true,
      inputSchema: { required: ["session_id"] },
    })
  })

  it("returns an exit code directly for a short plain-pipe command", async () => {
    const [execCommand] = createUnifiedExecTools()
    if (execCommand === undefined) throw new Error("missing exec_command")

    const result = await execCommand.execute(
      { cmd: "printf short", "yield-time_ms": 250 },
      context,
    )

    expect(result).toMatchObject({
      ok: true,
      output: { exit_code: 0, output: "short" },
    })
    expect((result.output as UnifiedExecOutput).session_id).toBeUndefined()
    await execCommand.dispose?.()
  })

  it("yields a session and drains only new output through write_stdin", async () => {
    const [execCommand, writeStdin] = createUnifiedExecTools()
    if (execCommand === undefined || writeStdin === undefined) {
      throw new Error("missing unified exec tools")
    }
    const initial = await execCommand.execute(
      {
        cmd: "printf first; sleep 0.35; printf second",
        "yield-time_ms": 250,
      },
      context,
    )
    const initialOutput = requireOutput(initial)

    expect(initialOutput.output).toBe("first")
    expect(initialOutput.session_id).toEqual(expect.any(Number))
    const completed = await writeStdin.execute(
      { session_id: initialOutput.session_id, "yield-time_ms": 5_000 },
      context,
    )

    expect(completed).toMatchObject({
      ok: true,
      output: { exit_code: 0, output: "second" },
    })
    await execCommand.dispose?.()
  })

  it("writes interactive stdin only to a PTY process", async () => {
    const [execCommand, writeStdin] = createUnifiedExecTools()
    if (execCommand === undefined || writeStdin === undefined) {
      throw new Error("missing unified exec tools")
    }
    const initial = requireOutput(
      await execCommand.execute(
        {
          cmd: "read value; printf 'got:%s' \"$value\"",
          tty: true,
          "yield-time_ms": 250,
        },
        context,
      ),
    )
    const interaction = await writeStdin.execute(
      {
        session_id: initial.session_id,
        chars: "hello\n",
        "yield-time_ms": 250,
      },
      context,
    )
    const interactionOutput = requireOutput(interaction)
    const completed =
      interactionOutput.session_id === undefined
        ? interactionOutput
        : requireOutput(
            await writeStdin.execute(
              {
                session_id: interactionOutput.session_id,
                "yield-time_ms": 5_000,
              },
              context,
            ),
          )

    expect(completed.exit_code).toBe(0)
    expect(interactionOutput.output + completed.output).toContain("got:hello")
    await execCommand.dispose?.()
  })

  it("rejects ordinary plain-pipe stdin but permits Ctrl-C", async () => {
    const [execCommand, writeStdin] = createUnifiedExecTools()
    if (execCommand === undefined || writeStdin === undefined) {
      throw new Error("missing unified exec tools")
    }
    const initial = requireOutput(
      await execCommand.execute(
        { cmd: "sleep 10", "yield-time_ms": 250 },
        context,
      ),
    )

    await expect(
      writeStdin.execute(
        { session_id: initial.session_id, chars: "hello\n" },
        context,
      ),
    ).resolves.toMatchObject({ ok: false, code: "write_stdin_failed" })
    const interrupted = requireOutput(
      await writeStdin.execute(
        {
          session_id: initial.session_id,
          chars: "\u0003",
          "yield-time_ms": 5_000,
        },
        context,
      ),
    )
    expect(interrupted.exit_code).not.toBe(0)
    await execCommand.dispose?.()
  })

  it("serializes concurrent interactions against one process", async () => {
    const [execCommand, writeStdin] = createUnifiedExecTools()
    if (execCommand === undefined || writeStdin === undefined) {
      throw new Error("missing unified exec tools")
    }
    const initial = requireOutput(
      await execCommand.execute(
        {
          cmd: 'while IFS= read -r value; do printf \'<%s>\' "$value"; test "$value" = stop && break; done',
          tty: true,
          "yield-time_ms": 250,
        },
        context,
      ),
    )

    const first = writeStdin.execute(
      {
        session_id: initial.session_id,
        chars: "one\n",
        "yield-time_ms": 250,
      },
      context,
    )
    const second = writeStdin.execute(
      {
        session_id: initial.session_id,
        chars: "stop\n",
        "yield-time_ms": 250,
      },
      context,
    )

    expect(requireOutput(await first).output).toContain("<one>")
    expect(requireOutput(await second)).toMatchObject({
      exit_code: 0,
    })
    expect(requireOutput(await second).output).toContain("<stop>")
    await execCommand.dispose?.()
  })

  it("reports original size while bounding a response by max_output_tokens", async () => {
    const [execCommand] = createUnifiedExecTools()
    if (execCommand === undefined) throw new Error("missing exec_command")

    const output = requireOutput(
      await execCommand.execute(
        {
          cmd: "printf 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'",
          max_output_tokens: 5,
        },
        context,
      ),
    )

    expect(output.original_token_count).toBe(13)
    expect(output.output).toContain("bytes omitted")
    await execCommand.dispose?.()
  })

  it("allocates a real PTY when tty is true", async () => {
    const [execCommand] = createUnifiedExecTools()
    if (execCommand === undefined) throw new Error("missing exec_command")

    const result = await execCommand.execute(
      {
        cmd: "if test -t 0; then printf tty-yes; else printf tty-no; fi",
        tty: true,
        "yield-time_ms": 250,
      },
      context,
    )

    expect(result).toMatchObject({ ok: true, output: { exit_code: 0 } })
    expect(requireOutput(result).output).toContain("tty-yes")
    await execCommand.dispose?.()
  })

  it("rejects a model-supplied shell parameter", async () => {
    const [execCommand] = createUnifiedExecTools()
    if (execCommand === undefined) throw new Error("missing exec_command")

    const result = await execCommand.execute(
      { cmd: "printf shell-ok", shell: "/bin/sh" },
      context,
    )

    expect(result).toMatchObject({ ok: false, code: "invalid_tool_input" })
    expect(result).toMatchObject({
      message: expect.stringContaining("does not accept: shell"),
    })
    await execCommand.dispose?.()
  })

  it.skipIf(process.platform === "win32" || !existsSync("/bin/zsh"))(
    "makes login-shell aliases and functions available through the snapshot",
    async () => {
      const home = await realpath(
        await mkdtemp(join(tmpdir(), "yakitori-exec-snapshot-")),
      )
      try {
        await writeFile(
          join(home, ".zshrc"),
          "alias yak_smoke_alias='printf alias-ran'\nyak_smoke_fn() { printf fn-ran; }\n",
        )
        const userShellEnv = createUserShellEnv({
          appEnv: {
            HOME: home,
            ZDOTDIR: home,
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          },
          homeDir: home,
          resolveShell: async () => ({ shell: "/bin/zsh", warnings: [] }),
          log: () => {},
        })
        const [execCommand] = createUnifiedExecTools({ userShellEnv })
        if (execCommand === undefined) throw new Error("missing exec_command")

        const viaAlias = await execCommand.execute(
          { cmd: "yak_smoke_alias", "yield-time_ms": 250 },
          { workspaceRoot: home },
        )
        const viaFunction = await execCommand.execute(
          { cmd: "yak_smoke_fn", "yield-time_ms": 250 },
          { workspaceRoot: home },
        )

        expect(requireOutput(viaAlias).output).toContain("alias-ran")
        expect(requireOutput(viaFunction).output).toContain("fn-ran")
        await execCommand.dispose?.()
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    },
  )

  it.each([
    false,
    true,
  ])("reports timeout termination as failure when tty is %s", async (tty) => {
    const manager = createUnifiedExecProcessManager({
      backgroundTimeoutMs: 300,
      killGraceMs: 20,
    })
    const initial = await manager.exec({
      command: "sleep 10",
      cwd: process.cwd(),
      shell: "/bin/sh",
      env: process.env,
      tty,
      yieldTimeMs: 250,
      maxOutputTokens: 100,
    })
    const completed = await manager.write({
      sessionId: initial.session_id as number,
      chars: "",
      yieldTimeMs: 5_000,
      maxOutputTokens: 100,
    })

    expect(completed.exit_code).not.toBe(0)
    await manager.close()
  })

  it("does not start a manager command for an already-aborted signal", async () => {
    const manager = createUnifiedExecProcessManager()
    const controller = new AbortController()
    controller.abort()

    await expect(
      manager.exec({
        command: "sleep 10",
        cwd: process.cwd(),
        shell: "/bin/sh",
        env: process.env,
        tty: false,
        yieldTimeMs: 250,
        maxOutputTokens: 100,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" })
    await manager.close()
  })

  it.each([
    false,
    true,
  ])("terminates an already-started command on abort when tty is %s", async (tty) => {
    const manager = createUnifiedExecProcessManager({ killGraceMs: 20 })
    const controller = new AbortController()
    const running = manager.exec({
      command: "sleep 10",
      cwd: process.cwd(),
      shell: "/bin/sh",
      env: process.env,
      tty,
      yieldTimeMs: 5_000,
      maxOutputTokens: 100,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 50)

    const completed = await running
    expect(completed.exit_code).not.toBe(0)
    await manager.close()
  })

  it("prunes exited unpolled sessions at the soft process cap", async () => {
    const manager = createUnifiedExecProcessManager({ killGraceMs: 20 })
    const sessions = await Promise.all(
      Array.from({ length: 64 }, () =>
        manager.exec({
          command: "sleep 0.3",
          cwd: process.cwd(),
          shell: "/bin/sh",
          env: process.env,
          tty: false,
          yieldTimeMs: 250,
          maxOutputTokens: 100,
        }),
      ),
    )
    expect(sessions.every((result) => result.session_id !== undefined)).toBe(
      true,
    )
    await new Promise((resolve) => setTimeout(resolve, 200))

    await expect(
      manager.exec({
        command: "true",
        cwd: process.cwd(),
        shell: "/bin/sh",
        env: process.env,
        tty: false,
        yieldTimeMs: 250,
        maxOutputTokens: 100,
      }),
    ).resolves.toMatchObject({ exit_code: 0 })
    await manager.close()
  })

  it("rejects unknown sessions and closes every live process idempotently", async () => {
    const manager = createUnifiedExecProcessManager({
      backgroundTimeoutMs: 10_000,
      killGraceMs: 20,
    })
    const running = await manager.exec({
      command: "sleep 10",
      cwd: process.cwd(),
      shell: "/bin/sh",
      env: process.env,
      tty: false,
      yieldTimeMs: 250,
      maxOutputTokens: 100,
    })
    expect(running.session_id).toEqual(expect.any(Number))

    await manager.close()
    await manager.close()
    await expect(
      manager.write({
        sessionId: running.session_id as number,
        chars: "",
        yieldTimeMs: 5_000,
        maxOutputTokens: 100,
      }),
    ).rejects.toThrow("manager is closed")
  })

  it("fails closed on invalid input and the catastrophic-command fuse", async () => {
    const [execCommand, writeStdin] = createUnifiedExecTools()
    if (execCommand === undefined || writeStdin === undefined) {
      throw new Error("missing unified exec tools")
    }

    await expect(
      execCommand.execute({ cmd: "" }, context),
    ).resolves.toMatchObject({
      ok: false,
      code: "invalid_tool_input",
    })
    await expect(
      execCommand.execute({ cmd: "rm -rf /" }, context),
    ).resolves.toMatchObject({ ok: false, code: "command_blocked" })
    await expect(
      writeStdin.execute({ session_id: 999_999 }, context),
    ).resolves.toMatchObject({ ok: false, code: "write_stdin_failed" })
    await execCommand.dispose?.()
  })
})

function requireOutput(result: {
  readonly ok: boolean
  readonly output?: unknown
}): UnifiedExecOutput {
  if (!result.ok || result.output === undefined) {
    throw new Error("Expected successful unified exec output.")
  }
  return result.output as UnifiedExecOutput
}
