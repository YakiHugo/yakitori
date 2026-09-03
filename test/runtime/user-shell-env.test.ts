import { existsSync } from "node:fs"
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  applyShellEnvironmentPolicy,
  createUserShellEnv,
  isSparsePath,
  mergeShellEnvironment,
  parseNullEnvironment,
  parsePrintenvEnvironment,
  resolveCommandShell,
  wrapWithShellSnapshot,
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
  it("prefers the account shell and ignores the parent SHELL variable", async () => {
    const candidates: string[] = []
    const result = await resolveCommandShell({
      accountShell: () => "/opt/homebrew/bin/bash",
      path: "/parent/bin:/usr/local/bin",
      resolveCandidate: async (candidate) => {
        candidates.push(candidate)
        return candidate === "/opt/homebrew/bin/bash" ? candidate : undefined
      },
    })

    expect(result).toEqual({ shell: "/opt/homebrew/bin/bash", warnings: [] })
    expect(candidates).toEqual(["/opt/homebrew/bin/bash"])
  })

  it("uses PATH zsh before bash and then fixed macOS fallbacks", async () => {
    const candidates: string[] = []
    const result = await resolveCommandShell({
      accountShell: () => "/opt/homebrew/bin/fish",
      path: "/custom/bin:/usr/local/bin",
      resolveCandidate: async (candidate) => {
        candidates.push(candidate)
        return candidate === "/usr/local/bin/zsh" ? candidate : undefined
      },
    })

    expect(result).toEqual({ shell: "/usr/local/bin/zsh", warnings: [] })
    expect(candidates).toEqual(["/custom/bin/zsh", "/usr/local/bin/zsh"])
  })

  it("falls back to a verified fixed shell", async () => {
    const candidates: string[] = []
    const result = await resolveCommandShell({
      accountShell: () => null,
      path: "",
      resolveCandidate: async (candidate) => {
        candidates.push(candidate)
        return candidate === "/bin/bash" ? candidate : undefined
      },
    })

    expect(result).toEqual({ shell: "/bin/bash", warnings: [] })
    expect(candidates).toEqual(["/bin/zsh", "/bin/bash"])
  })

  it("inherits user credentials by default and scrubs internal process control", () => {
    expect(
      applyShellEnvironmentPolicy({
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
      TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      AWS_ACCESS_KEY_ID: "secret",
      SERVICE_DATABASE_URL: "secret",
      ACCOUNT_CREDENTIAL: "secret",
      BASH_ENV: "/tmp/bash-env",
      ENV: "/tmp/sh-env",
      ZDOTDIR: "/tmp/zsh",
      YAKITORI_STORE_DIR: "secret",
    })
  })

  it("applies Codex-style inherit, exclude, set, and include-only policy", () => {
    expect(
      applyShellEnvironmentPolicy(
        {
          PATH: "/bin",
          HOME: "/Users/test",
          API_KEY: "secret",
          ACCESS_TOKEN: "secret",
          ACME_VISIBLE: "yes",
          DROP_ME: "no",
        },
        {
          inherit: "all",
          ignoreDefaultExcludes: false,
          exclude: ["DROP_*"],
          set: { ADDED: "1" },
          includeOnly: ["PATH", "HOME", "ACME_*", "ADDED"],
        },
      ),
    ).toEqual({
      PATH: "/bin",
      HOME: "/Users/test",
      ACME_VISIBLE: "yes",
      ADDED: "1",
    })
    expect(
      applyShellEnvironmentPolicy(
        { PATH: "/bin", HOME: "/Users/test", CUSTOM: "value" },
        {
          inherit: "core",
          ignoreDefaultExcludes: true,
          exclude: [],
          set: {},
          includeOnly: [],
        },
      ),
    ).toEqual({ PATH: "/bin", HOME: "/Users/test" })
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

  it("exposes the resolved shell basename for environment context", async () => {
    const environment = createUserShellEnv({
      appEnv: { PATH: "/usr/bin:/bin" },
      resolveShell: async () => ({ shell: "/bin/zsh", warnings: [] }),
    })

    await expect(environment.shellName()).resolves.toBe("zsh")
    await expect(environment.shellName()).resolves.toBe("zsh")
  })

  it("falls back to printenv and freezes the ready map", async () => {
    const calls: string[] = []
    const logs: string[] = []
    const environment = createUserShellEnv({
      appEnv: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", PORT: "4141" },
      resolveShell: async () => ({ shell: "/bin/zsh", warnings: [] }),
      runCapture: async (_shell, command) => {
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
      "exec_command shell-env probe: pending",
      "exec_command shell-env probe: fallback_printenv (exit code 1)",
      "exec_command shell-env probe: ready",
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
      expect(command.env.ZDOTDIR).toBe(zdotdir)
    },
  )

  it.skipIf(process.platform === "win32" || !existsSync("/bin/zsh"))(
    "applies the environment policy before and after login-shell startup",
    async () => {
      const workspace = await realpath(
        await mkdtemp(join(tmpdir(), "yakitori-shell-policy-")),
      )
      workspaces.push(workspace)
      await writeFile(
        join(workspace, ".zprofile"),
        `export LEAK="\${API_KEY:-missing}"\nexport FROM_SET="\${POLICY_FLAG:-missing}"\n`,
      )
      const environment = createUserShellEnv({
        appEnv: {
          HOME: workspace,
          PATH: "/usr/bin:/bin",
          ZDOTDIR: workspace,
          API_KEY: "must-not-reach-startup",
        },
        shellEnvironmentPolicy: {
          ignoreDefaultExcludes: false,
          set: { POLICY_FLAG: "visible-to-startup" },
        },
        resolveShell: async () => ({ shell: "/bin/zsh", warnings: [] }),
        log: () => {},
      })

      await expect(environment.probe()).resolves.toBe("ready")
      const command = await environment.commandEnvironment(workspace)
      expect(command.env.API_KEY).toBeUndefined()
      expect(command.env.LEAK).toBe("missing")
      expect(command.env.FROM_SET).toBe("visible-to-startup")
      expect(command.env.POLICY_FLAG).toBe("visible-to-startup")
    },
  )
})

describe("shell snapshot", () => {
  it("generates a snapshot once and reuses it across instances", async () => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "yakitori-snapshot-")),
    )
    workspaces.push(home)
    let captureCalls = 0
    const runCapture = async (_shell: string, command: string) => {
      captureCalls += 1
      return command.startsWith("source ")
        ? { exitCode: 0, stdout: Buffer.alloc(0) }
        : { exitCode: 0, stdout: Buffer.from("alias gst='git status'\n") }
    }
    const first = createUserShellEnv({
      homeDir: home,
      resolveShell: async () => ({ shell: "/bin/zsh", warnings: [] }),
      runCapture,
      log: () => {},
    })

    const path = await first.shellSnapshot()
    if (path === undefined) throw new Error("missing snapshot path")
    expect(path.startsWith(`${join(home, "shell-snapshots")}/`)).toBe(true)
    expect(basename(path)).toMatch(/^zsh-[0-9a-f]{8}\.sh$/)
    expect(captureCalls).toBe(2)
    await expect(readFile(path, "utf8")).resolves.toContain(
      "alias gst='git status'",
    )

    const second = createUserShellEnv({
      homeDir: home,
      resolveShell: async () => ({ shell: "/bin/zsh", warnings: [] }),
      runCapture: async () => {
        throw new Error("snapshot must be reused, not regenerated")
      },
      log: () => {},
    })
    await expect(second.shellSnapshot()).resolves.toBe(path)
  })

  it("regenerates a snapshot older than the retention window", async () => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "yakitori-snapshot-")),
    )
    workspaces.push(home)
    let captures = 0
    const create = () =>
      createUserShellEnv({
        homeDir: home,
        resolveShell: async () => ({ shell: "/bin/zsh", warnings: [] }),
        runCapture: async (_shell, command) => {
          if (!command.startsWith("source ")) captures += 1
          return { exitCode: 0, stdout: Buffer.from("alias a='b'\n") }
        },
        log: () => {},
      })

    const path = await create().shellSnapshot()
    expect(captures).toBe(1)
    if (path === undefined) throw new Error("missing snapshot path")
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000)
    await utimes(path, fourDaysAgo, fourDaysAgo)

    await expect(create().shellSnapshot()).resolves.toBe(path)
    expect(captures).toBe(2)
  })

  it("returns undefined when the dump or the validation fails", async () => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "yakitori-snapshot-")),
    )
    workspaces.push(home)
    const failingDump = createUserShellEnv({
      homeDir: home,
      resolveShell: async () => ({ shell: "/bin/zsh", warnings: [] }),
      runCapture: async () => ({ exitCode: 1, stdout: Buffer.alloc(0) }),
      log: () => {},
    })
    await expect(failingDump.shellSnapshot()).resolves.toBeUndefined()

    const failingValidation = createUserShellEnv({
      homeDir: home,
      resolveShell: async () => ({ shell: "/bin/zsh", warnings: [] }),
      runCapture: async (_shell, command) =>
        command.startsWith("source ")
          ? { exitCode: 1, stdout: Buffer.alloc(0) }
          : { exitCode: 0, stdout: Buffer.from("alias a='b'\n") },
      log: () => {},
    })
    await expect(failingValidation.shellSnapshot()).resolves.toBeUndefined()
  })

  it("regenerates when the cached snapshot goes stale within one process", async () => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "yakitori-snapshot-")),
    )
    workspaces.push(home)
    let captures = 0
    const environment = createUserShellEnv({
      homeDir: home,
      resolveShell: async () => ({ shell: "/bin/zsh", warnings: [] }),
      runCapture: async (_shell, command) => {
        if (!command.startsWith("source ")) captures += 1
        return { exitCode: 0, stdout: Buffer.from("alias a='b'\n") }
      },
      log: () => {},
    })

    const path = await environment.shellSnapshot()
    expect(captures).toBe(1)
    if (path === undefined) throw new Error("missing snapshot path")
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000)
    await utimes(path, fourDaysAgo, fourDaysAgo)

    await expect(environment.shellSnapshot()).resolves.toBe(path)
    expect(captures).toBe(2)
  })

  it("degrades to undefined when the snapshot directory is not writable", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "yakitori-snapshot-")),
    )
    workspaces.push(root)
    // A regular file where the home directory should be forces mkdir to fail.
    const blocker = join(root, "not-a-directory")
    await writeFile(blocker, "")
    const environment = createUserShellEnv({
      homeDir: blocker,
      resolveShell: async () => ({ shell: "/bin/zsh", warnings: [] }),
      runCapture: async () => ({
        exitCode: 0,
        stdout: Buffer.from("alias a='b'\n"),
      }),
      log: () => {},
    })

    await expect(environment.shellSnapshot()).resolves.toBeUndefined()
    await expect(environment.shellSnapshot()).resolves.toBeUndefined()
  })

  it("skips snapshots for shells without a dump specification", async () => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "yakitori-snapshot-")),
    )
    workspaces.push(home)
    const environment = createUserShellEnv({
      homeDir: home,
      resolveShell: async () => ({ shell: "/bin/sh", warnings: [] }),
      runCapture: async () => {
        throw new Error("sh must not be snapshotted")
      },
      log: () => {},
    })

    await expect(environment.shellSnapshot()).resolves.toBeUndefined()
  })

  it("quotes snapshot paths and commands for the source-plus-eval wrapper", () => {
    expect(wrapWithShellSnapshot("/snap dir/snap.sh", "printf 'a b'")).toBe(
      "source '/snap dir/snap.sh' 2>/dev/null || true\neval 'printf '\\''a b'\\'''",
    )
  })
})
