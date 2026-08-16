import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  boundCommandContent,
  createRunCommandTool,
  createUserShellEnv,
  type RunCommandLauncher,
} from "../../../src/index.ts"

const workspaces: string[] = []

afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((workspace) => rm(workspace, { recursive: true, force: true })),
  )
})

describe("run_command contract", () => {
  it("is auto-allowed and exposes cwd and description without aliases", () => {
    const tool = createRunCommandTool()
    expect(tool).toMatchObject({
      name: "run_command",
      autoAllow: true,
      effect: "opaque",
      inputSchema: {
        additionalProperties: false,
        required: ["command"],
        properties: {
          cwd: { type: "string" },
          description: { type: "string", maxLength: 200 },
        },
      },
    })
    expect(tool.description).toContain("not sandboxed")
  })

  it("renders non-zero exit as a successful observation", async () => {
    const workspace = await makeWorkspace()
    const result = await createRunCommandTool({
      launch: async () => ({
        exitCode: 2,
        signal: null,
        stdout: "out",
        stderr: "warning",
        truncated: false,
        timedOut: false,
        durationMs: 4_100,
      }),
    }).execute({ command: "example" }, { workspaceRoot: workspace })

    expect(result).toMatchObject({
      ok: true,
      content: "out\n[stderr]\nwarning\n(exit 2, 4.1s)",
      output: {
        exitCode: 2,
        cwd: workspace,
      },
    })
  })

  it("rejects multiline descriptions before launch", async () => {
    const workspace = await makeWorkspace()
    let launches = 0
    const result = await createRunCommandTool({
      launch: async () => {
        launches += 1
        return successfulLaunch()
      },
    }).execute(
      { command: "true", description: "first\nsecond" },
      { workspaceRoot: workspace },
    )
    expect(result).toMatchObject({ ok: false, code: "invalid_tool_input" })
    expect(launches).toBe(0)
  })

  it("rejects unsupported timeout and workdir aliases", async () => {
    const workspace = await makeWorkspace()
    const tool = createRunCommandTool()
    await expect(
      tool.execute(
        { command: "true", timeout: 1_000 },
        { workspaceRoot: workspace },
      ),
    ).resolves.toMatchObject({ ok: false, code: "invalid_tool_input" })
    await expect(
      tool.execute(
        { command: "true", workdir: "." },
        { workspaceRoot: workspace },
      ),
    ).resolves.toMatchObject({ ok: false, code: "invalid_tool_input" })
  })

  it("resolves relative and absolute cwd only inside the workspace", async () => {
    const workspace = await makeWorkspace()
    const nested = join(workspace, "packages", "gui")
    await mkdir(nested, { recursive: true })
    const file = join(workspace, "not-a-directory")
    await writeFile(file, "x")
    const seen: string[] = []
    const launch: RunCommandLauncher = async (input) => {
      seen.push(input.cwd)
      expect(input.env.PWD).toBe(input.cwd)
      return successfulLaunch()
    }
    const tool = createRunCommandTool({ launch })

    await expect(
      tool.execute(
        { command: "pwd", cwd: "packages/gui" },
        { workspaceRoot: workspace },
      ),
    ).resolves.toMatchObject({ ok: true })
    await expect(
      tool.execute(
        { command: "pwd", cwd: nested },
        { workspaceRoot: workspace },
      ),
    ).resolves.toMatchObject({ ok: true })
    await expect(
      tool.execute(
        { command: "pwd", cwd: "../" },
        { workspaceRoot: workspace },
      ),
    ).resolves.toMatchObject({ ok: false, code: "invalid_cwd" })
    await expect(
      tool.execute(
        { command: "pwd", cwd: "missing" },
        { workspaceRoot: workspace },
      ),
    ).resolves.toMatchObject({ ok: false, code: "invalid_cwd" })
    await expect(
      tool.execute({ command: "pwd", cwd: file }, { workspaceRoot: workspace }),
    ).resolves.toMatchObject({ ok: false, code: "invalid_cwd" })
    expect(seen).toEqual([nested, nested])
  })

  it("passes an explicit supported shell and -c launcher inputs", async () => {
    const workspace = await makeWorkspace()
    const shellEnv = createUserShellEnv({
      appEnv: { PATH: "/usr/bin:/bin", VISIBLE_TEST_VAR: "visible" },
      resolveShell: async () => ({ shell: "/bin/zsh", warnings: [] }),
      log: () => {},
    })
    const logs: string[] = []
    let seen: Parameters<RunCommandLauncher>[0] | undefined
    const result = await createRunCommandTool({
      userShellEnv: shellEnv,
      log: (message) => logs.push(message),
      launch: async (input) => {
        seen = input
        return successfulLaunch()
      },
    }).execute(
      { command: "echo $VISIBLE_TEST_VAR" },
      { workspaceRoot: workspace },
    )

    expect(result.ok).toBe(true)
    expect(seen).toMatchObject({
      command: "echo $VISIBLE_TEST_VAR",
      cwd: workspace,
      shell: "/bin/zsh",
      env: {
        PATH: "/usr/bin:/bin",
        VISIBLE_TEST_VAR: "visible",
        TERM: "dumb",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        PWD: workspace,
      },
    })
    expect(logs).toEqual(["run_command start token=echo bytes=22"])
  })

  it("reports abort before spawn and lets abort win a timer race", async () => {
    const workspace = await makeWorkspace()
    const before = new AbortController()
    before.abort()
    let launches = 0
    const tool = createRunCommandTool({
      launch: async () => {
        launches += 1
        return { ...successfulLaunch(), timedOut: true, aborted: true }
      },
    })
    await expect(
      tool.execute(
        { command: "sleep 1" },
        { workspaceRoot: workspace, signal: before.signal },
      ),
    ).resolves.toMatchObject({ ok: false, code: "aborted" })

    const after = new AbortController()
    const raceTool = createRunCommandTool({
      launch: async () => {
        launches += 1
        after.abort()
        return { ...successfulLaunch(), timedOut: true, aborted: true }
      },
    })
    await expect(
      raceTool.execute(
        { command: "sleep 1" },
        { workspaceRoot: workspace, signal: after.signal },
      ),
    ).resolves.toMatchObject({ ok: false, code: "aborted" })
    expect(launches).toBe(1)
  })

  it("returns timeout guidance with captured output", async () => {
    const workspace = await makeWorkspace()
    const result = await createRunCommandTool({
      launch: async () => ({
        ...successfulLaunch(),
        exitCode: null,
        signal: "SIGTERM",
        stdout: "partial",
        timedOut: true,
      }),
    }).execute(
      { command: "slow", timeoutSeconds: 3 },
      { workspaceRoot: workspace },
    )
    expect(result).toMatchObject({
      ok: false,
      code: "command_timeout",
      output: { timedOut: true, stdout: "partial" },
    })
    expect(result.content).toContain("Raise timeoutSeconds")
    expect(result.content).toContain("do not retry it unchanged")
  })
})

describe("run_command process lifecycle", () => {
  it.skipIf(process.platform === "win32")(
    "kills descendants that ignore SIGTERM when the Turn is aborted",
    async () => {
      const workspace = await makeWorkspace()
      const controller = new AbortController()
      const script = [
        'require("node:fs").writeFileSync("started.txt", "yes")',
        'process.on("SIGTERM", () => undefined)',
        'setTimeout(() => require("node:fs").writeFileSync("survived.txt", "yes"), 250)',
        "setInterval(() => undefined, 1000)",
      ].join(";")
      const execution = createRunCommandTool({ killGraceMs: 20 }).execute(
        {
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
        },
        { workspaceRoot: workspace, signal: controller.signal },
      )

      await waitForFile(join(workspace, "started.txt"))
      controller.abort()
      await expect(execution).resolves.toMatchObject({
        ok: false,
        code: "aborted",
      })
      await new Promise((resolve) => setTimeout(resolve, 350))
      await expect(
        access(join(workspace, "survived.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" })
    },
  )

  it("hides provider and app secrets but keeps ordinary variables", async () => {
    process.env.GITHUB_TOKEN = "github-secret"
    process.env.AWS_ACCESS_KEY_ID = "aws-secret"
    process.env.TOKEN = "generic-secret"
    process.env.YAKITORI_TEST_VISIBLE = "app-secret"
    process.env.ELECTRON_RUN_AS_NODE = "1"
    process.env.VISIBLE_TEST_VAR = "visible-value"
    try {
      const result = await createRunCommandTool().execute(
        {
          command:
            'printf "github=%s aws=%s token=%s app=%s electron=%s visible=%s" "$GITHUB_TOKEN" "$AWS_ACCESS_KEY_ID" "$TOKEN" "$YAKITORI_TEST_VISIBLE" "$ELECTRON_RUN_AS_NODE" "$VISIBLE_TEST_VAR"',
        },
        { workspaceRoot: process.cwd() },
      )
      expect(result.content).toContain("visible=visible-value")
      expect(result.content).not.toContain("github-secret")
      expect(result.content).not.toContain("aws-secret")
      expect(result.content).not.toContain("generic-secret")
      expect(result.content).not.toContain("app-secret")
    } finally {
      delete process.env.GITHUB_TOKEN
      delete process.env.AWS_ACCESS_KEY_ID
      delete process.env.TOKEN
      delete process.env.YAKITORI_TEST_VISIBLE
      delete process.env.ELECTRON_RUN_AS_NODE
      delete process.env.VISIBLE_TEST_VAR
    }
  })

  it.skipIf(process.platform === "win32")(
    "does not let zsh startup files restore filtered secrets",
    async () => {
      const workspace = await makeWorkspace()
      await writeFile(
        join(workspace, ".zshenv"),
        'export OPENAI_API_KEY="restored-by-zshenv"\n',
      )
      const userShellEnv = createUserShellEnv({
        appEnv: {
          HOME: workspace,
          PATH: "/usr/bin:/bin",
          ZDOTDIR: workspace,
          OPENAI_API_KEY: "provider-secret",
        },
        resolveShell: async () => ({ shell: "/bin/zsh", warnings: [] }),
        log: () => {},
      })
      const result = await createRunCommandTool({ userShellEnv }).execute(
        { command: `printf "%s" "\${OPENAI_API_KEY:-missing}"` },
        { workspaceRoot: workspace },
      )

      expect(result).toMatchObject({ ok: true, output: { stdout: "missing" } })
      expect(result.content).not.toContain("restored-by-zshenv")
      expect(result.content).not.toContain("provider-secret")
    },
  )

  it.skipIf(process.platform === "win32")(
    "returns at the hard timeout even when a detached descendant keeps stdout open",
    async () => {
      const workspace = await makeWorkspace()
      const descendant = "setTimeout(() => undefined, 4000)"
      const script = [
        'const { spawn } = require("node:child_process")',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { detached: true, stdio: ["ignore", 1, 2] })`,
        "child.unref()",
      ].join(";")
      const startedAt = Date.now()
      const result = await createRunCommandTool({ killGraceMs: 20 }).execute(
        {
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
          timeoutSeconds: 1,
        },
        { workspaceRoot: workspace },
      )

      expect(result).toMatchObject({
        ok: false,
        code: "command_timeout",
        output: { timedOut: true, truncated: true },
      })
      expect(Date.now() - startedAt).toBeLessThan(2_000)
    },
  )

  it("marks NUL output as binary and omits the bytes from model content", async () => {
    const workspace = await makeWorkspace()
    const result = await createRunCommandTool().execute(
      {
        command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write(Buffer.from([65,0,66]))'`,
      },
      { workspaceRoot: workspace },
    )
    expect(result).toMatchObject({
      ok: true,
      output: { binary: { stdout: true, stdoutBytes: 3 } },
    })
    expect(result.content).toContain("binary stdout omitted")
    expect(result.content).not.toContain("410042")
  })
})

describe("run_command model output bound", () => {
  it("keeps a 30/70 head and tail within byte and line caps", () => {
    const text = Array.from(
      { length: 3_000 },
      (_, index) => `line-${index}`,
    ).join("\n")
    const bounded = boundCommandContent(text)
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(50 * 1024)
    expect(bounded.split("\n")).toHaveLength(2_000)
    expect(bounded).toContain("line-0")
    expect(bounded).toContain("line-2999")
    expect(bounded).toContain("cmd > out.log 2>&1")
    expect(bounded).toContain(
      "Full captured output is not available in model context",
    )
    expect(bounded.indexOf("line-0")).toBeLessThan(bounded.indexOf("line-2999"))
  })

  it("does not split UTF-8 characters at byte boundaries", () => {
    const bounded = boundCommandContent("烧".repeat(30_000), {
      maxBytes: 1_000,
      maxLines: 10,
    })
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(1_000)
    expect(bounded).not.toContain("�")
  })
})

function successfulLaunch() {
  return {
    exitCode: 0,
    signal: null,
    stdout: "ok",
    stderr: "",
    truncated: false,
    timedOut: false,
  } as const
}

async function makeWorkspace(): Promise<string> {
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "yakitori-command-")),
  )
  workspaces.push(workspace)
  return workspace
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  throw new Error(`Command did not create its start marker: ${path}`)
}
