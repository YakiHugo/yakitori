import { existsSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createUserShellEnv,
  filterCommandEnvironment,
  isSparsePath,
  mergeShellEnvironment,
  parseNullEnvironment,
  parsePrintenvEnvironment,
} from "../../src/runtime/user-shell-env.ts"

const workspaces: string[] = []

afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((workspace) => rm(workspace, { recursive: true, force: true })),
  )
})

describe("user shell environment", () => {
  it("filters exact, suffix, app, and Electron secrets", () => {
    expect(
      filterCommandEnvironment({
        PATH: "/bin",
        HOME: "/Users/test",
        LANG: "en_US.UTF-8",
        SSH_AUTH_SOCK: "/tmp/agent",
        USER: "test",
        VISIBLE_TEST_VAR: "visible",
        TOKEN: "secret",
        GITHUB_TOKEN: "secret",
        AWS_ACCESS_KEY_ID: "secret",
        SERVICE_DATABASE_URL: "secret",
        ACCOUNT_CREDENTIAL: "secret",
        BASH_ENV: "/tmp/bash-env",
        ENV: "/tmp/sh-env",
        ZDOTDIR: "/tmp/zsh",
        YAKITORI_STORE_DIR: "secret",
        ELECTRON_RUN_AS_NODE: "1",
      }),
    ).toEqual({
      PATH: "/bin",
      HOME: "/Users/test",
      LANG: "en_US.UTF-8",
      SSH_AUTH_SOCK: "/tmp/agent",
      USER: "test",
      VISIBLE_TEST_VAR: "visible",
    })
  })

  it("uses the probed PATH for a sparse app and keeps a rich app PATH", () => {
    const shell = {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      MANPATH: "/opt/man",
    }
    expect(
      mergeShellEnvironment({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, shell),
    ).toMatchObject(shell)
    expect(
      mergeShellEnvironment({ PATH: "/custom/bin:/usr/bin" }, shell),
    ).toMatchObject({ PATH: "/custom/bin:/usr/bin" })
    expect(isSparsePath("/usr/bin:/bin:/usr/sbin:/sbin")).toBe(true)
    expect(isSparsePath("/opt/homebrew/bin:/usr/bin")).toBe(false)
  })

  it("parses NUL bindings and drops multiline printenv values", () => {
    expect(
      parseNullEnvironment(Buffer.from("PATH=/bin\0VALUE=a=b\0EMPTY=\0")),
    ).toEqual({ PATH: "/bin", VALUE: "a=b", EMPTY: "" })
    expect(
      parsePrintenvEnvironment(
        Buffer.from("PATH=/bin\nMULTILINE=first\ncontinued\nHOME=/home/test\n"),
      ),
    ).toEqual({ PATH: "/bin", HOME: "/home/test" })
  })

  it("falls back to printenv and freezes the ready map", async () => {
    const calls: string[] = []
    const logs: string[] = []
    const environment = createUserShellEnv({
      appEnv: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", PORT: "4141" },
      resolveShell: async () => ({ shell: "/bin/zsh", warnings: [] }),
      runProbe: async (_shell, command) => {
        calls.push(command)
        return command === "env -0"
          ? { exitCode: 1, stdout: Buffer.from("unsupported") }
          : {
              exitCode: 0,
              stdout: Buffer.from(
                "PATH=/opt/homebrew/bin:/usr/bin\nHOME=/Users/test\n",
              ),
            }
      },
      log: (message) => logs.push(message),
    })

    await expect(environment.probe()).resolves.toBe("ready")
    await expect(environment.probe()).resolves.toBe("ready")
    const command = await environment.commandEnvironment("/workspace")
    expect(calls).toEqual(["env -0", "printenv"])
    expect(logs).toEqual([
      "run_command shell-env probe: pending",
      "run_command shell-env probe: fallback_printenv (exit code 1)",
      "run_command shell-env probe: ready",
    ])
    expect(command).toMatchObject({
      shell: "/bin/zsh",
      env: {
        PATH: "/opt/homebrew/bin:/usr/bin",
        HOME: "/Users/test",
        PORT: "4141",
        PWD: "/workspace",
      },
    })
  })

  it.skipIf(process.platform === "win32" || !existsSync("/bin/zsh"))(
    "recovers a custom ZDOTDIR PATH after startup banner output",
    async () => {
      const workspace = await realpath(
        await mkdtemp(join(tmpdir(), "yakitori-shell-env-")),
      )
      workspaces.push(workspace)
      const zdotdir = join(workspace, "zsh")
      await mkdir(zdotdir)
      await writeFile(
        join(zdotdir, ".zprofile"),
        'echo startup-banner\nexport PATH="/custom/from-zdot:$PATH"\n',
      )
      const environment = createUserShellEnv({
        appEnv: {
          HOME: workspace,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          ZDOTDIR: zdotdir,
        },
        resolveShell: async () => ({ shell: "/bin/zsh", warnings: [] }),
        log: () => {},
      })

      await expect(environment.probe()).resolves.toBe("ready")
      const command = await environment.commandEnvironment(workspace)
      expect(command.env.PATH).toMatch(/^\/custom\/from-zdot:/)
      expect(command.env.ZDOTDIR).toBeUndefined()
    },
  )
})
