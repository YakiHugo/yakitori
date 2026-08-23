import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  boundCommandContent,
  createReadSessionFileTool,
  createRunCommandTool,
  createSessionFiles,
  createSessionId,
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

  it("retains complete stdout and stderr as readable Session files", async () => {
    const workspace = await makeWorkspace()
    const sessionId = createSessionId()
    const sessionFiles = createSessionFiles(join(workspace, ".sessions"))
    const script = [
      'process.stdout.write("head\\n" + "x".repeat(4096) + "\\ntail\\n")',
      'process.stderr.write("warning\\n")',
    ].join(";")
    const context = {
      workspaceRoot: workspace,
      sessionId,
      toolCallId: "call_output",
      sessionFiles,
    }
    const result = await createRunCommandTool({ maxOutputBytes: 64 }).execute(
      {
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      },
      context,
    )

    expect(result).toMatchObject({
      ok: true,
      output: {
        truncated: true,
        files: {
          stdout: { sessionId, path: "tools/call_output/stdout.log" },
          stderr: { sessionId, path: "tools/call_output/stderr.log" },
        },
        totalBytes: { stdout: 4_107, stderr: 8 },
      },
    })
    expect(result.content).toContain("read_session_file")

    const read = await createReadSessionFileTool().execute(
      { path: "tools/call_output/stdout.log", offset: 4_100, limit: 32 },
      context,
    )
    expect(read).toMatchObject({
      ok: true,
      output: { totalBytes: 4_107, hasMore: false },
    })
    expect(read.content).toContain("tail")
  })

  it("caps retained output and reports that the Session file is incomplete", async () => {
    const workspace = await makeWorkspace()
    const sessionId = createSessionId()
    const sessionFiles = createSessionFiles(join(workspace, ".sessions"))
    const result = await createRunCommandTool({
      maxOutputBytes: 32,
      maxPersistedOutputBytes: 64,
    }).execute(
      {
        command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(256))'`,
      },
      {
        workspaceRoot: workspace,
        sessionId,
        toolCallId: "call_capped",
        sessionFiles,
      },
    )

    expect(result).toMatchObject({
      ok: true,
      output: {
        totalBytes: { stdout: 256 },
        filesTruncated: { stdout: true, stderr: false },
      },
    })
    expect(result.content).toContain("64-byte limit")
    await expect(
      sessionFiles.read({
        sessionId,
        path: "tools/call_capped/stdout.log",
      }),
    ).resolves.toEqual(Buffer.from("x".repeat(64)))
  })

  it("pages UTF-8 without broken characters and encodes binary pages", async () => {
    const workspace = await makeWorkspace()
    const sessionId = createSessionId()
    const sessionFiles = createSessionFiles(join(workspace, ".sessions"))
    const context = {
      workspaceRoot: workspace,
      sessionId,
      toolCallId: "call_read",
      sessionFiles,
    }
    const textFile = await sessionFiles.prepareCommandFiles(
      sessionId,
      "call_unicode",
    )
    await writeFile(textFile.stdout.path, "你好吗")
    const reader = createReadSessionFileTool()

    const first = await reader.execute(
      { path: textFile.stdout.reference.path, limit: 4 },
      context,
    )
    expect(first).toMatchObject({
      ok: true,
      output: {
        content: "你好",
        encoding: "utf8",
        offset: 0,
        endOffset: 6,
        hasMore: true,
      },
    })
    expect(first.content).not.toContain("�")
    const second = await reader.execute(
      { path: textFile.stdout.reference.path, offset: 6, limit: 4 },
      context,
    )
    expect(second).toMatchObject({
      ok: true,
      output: { content: "吗", offset: 6, endOffset: 9, hasMore: false },
    })

    await writeFile(textFile.stdout.path, "你".repeat(20 * 1024))
    const largeText = await reader.execute(
      { path: textFile.stdout.reference.path },
      context,
    )
    expect(largeText).toMatchObject({
      ok: true,
      output: { encoding: "utf8", hasMore: true },
    })
    expect(largeText.content).not.toContain("�")
    expect(Buffer.byteLength(largeText.content)).toBeLessThan(50 * 1024)

    const binaryFile = await sessionFiles.prepareCommandFiles(
      sessionId,
      "call_binary",
    )
    await writeFile(binaryFile.stdout.path, Buffer.alloc(60 * 1024, 0xff))
    const binary = await reader.execute(
      { path: binaryFile.stdout.reference.path },
      context,
    )
    expect(binary).toMatchObject({
      ok: true,
      output: {
        encoding: "base64",
        endOffset: 32 * 1024,
        hasMore: true,
      },
    })
    expect(Buffer.byteLength(binary.content)).toBeLessThan(50 * 1024)
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

  it.skipIf(process.platform === "win32" || !existsSync("/bin/zsh"))(
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
    "returns and finishes Session files when a detached descendant keeps stdout open",
    async () => {
      const workspace = await makeWorkspace()
      const sessionId = createSessionId()
      const sessionFiles = createSessionFiles(join(workspace, ".sessions"))
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
        {
          workspaceRoot: workspace,
          sessionId,
          toolCallId: "call_timeout",
          sessionFiles,
        },
      )

      expect(result).toMatchObject({
        ok: false,
        code: "command_timeout",
        output: {
          timedOut: true,
          truncated: true,
          files: {
            stdout: { path: "tools/call_timeout/stdout.log" },
            stderr: { path: "tools/call_timeout/stderr.log" },
          },
        },
      })
      expect(Date.now() - startedAt).toBeLessThan(2_000)
      await expect(
        sessionFiles.read({
          sessionId,
          path: "tools/call_timeout/stdout.log",
        }),
      ).resolves.toBeInstanceOf(Buffer)
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
    expect(bounded).toContain("read_session_file")
    expect(bounded).toContain("for complete output when available")
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
