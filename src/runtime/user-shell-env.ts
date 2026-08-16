import { spawn } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import { userInfo } from "node:os"
import { basename } from "node:path"

const PROBE_TIMEOUT_MS = 5_000
const PROBE_CAPTURE_BYTES = 1024 * 1024
const PROBE_FORCE_COMPLETION_MS = 100
const PROBE_SENTINEL = "__YAKITORI_ENV_START_7F31B6A9__"
const SUPPORTED_SHELLS = new Set(["zsh", "bash", "sh", "dash"])
const SHELL_STARTUP_ENV_NAMES = new Set(["BASH_ENV", "ENV", "ZDOTDIR"])
const SECRET_ENV_NAMES = new Set(
  [
    "TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "NPM_TOKEN",
    "NPM_AUTH_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "DATABASE_URL",
    "MYSQL_PWD",
    "SSH_PRIVATE_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
  ].map((name) => name.toUpperCase()),
)
const SECRET_ENV_PATTERN =
  /(api[_-]?key|_token$|^token_|[_-]token[_-]|auth[_-]?token|secret|password|passwd|credential|private[_-]?key|bearer)/i

export type CommandEnvironment = {
  readonly shell: string
  readonly env: NodeJS.ProcessEnv
  readonly warnings: readonly string[]
}

export type UserShellEnv = {
  commandEnvironment(cwd: string): Promise<CommandEnvironment>
  probe(): Promise<"ready" | "unavailable">
}

export type ShellProbeResult = {
  readonly exitCode: number | null
  readonly stdout: Buffer
  readonly error?: string
  readonly truncated?: boolean
}

export function createUserShellEnv(
  options: {
    readonly appEnv?: NodeJS.ProcessEnv
    readonly platform?: NodeJS.Platform
    readonly resolveShell?: () => Promise<ResolvedCommandShell>
    readonly runProbe?: (
      shell: string,
      command: "env -0" | "printenv",
    ) => Promise<ShellProbeResult>
    readonly log?: (message: string) => void
  } = {},
): UserShellEnv {
  const appEnv = { ...(options.appEnv ?? process.env) }
  const platform = options.platform ?? process.platform
  const resolveShell = options.resolveShell ?? resolveCommandShell
  const runProbe =
    options.runProbe ??
    ((shell, command) =>
      runShellProbe(shell, command, filterProbeEnvironment(appEnv), platform))
  const log = options.log ?? ((message: string) => console.log(message))
  const shellPromise =
    platform === "win32"
      ? Promise.resolve({
          shell: appEnv.ComSpec ?? "cmd.exe",
          warnings: [] as readonly string[],
        })
      : resolveShell()
  const fallback = Object.freeze(filterCommandEnvironment(appEnv))
  let probed: Readonly<NodeJS.ProcessEnv> | undefined
  let probePromise: Promise<"ready" | "unavailable"> | undefined

  return {
    async commandEnvironment(cwd) {
      const resolved = await shellPromise
      return {
        shell: resolved.shell,
        warnings: resolved.warnings,
        env: {
          ...(probed ?? fallback),
          TERM: "dumb",
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          PWD: cwd,
        },
      }
    },
    async probe() {
      if (probePromise !== undefined) return probePromise
      if (platform === "win32") return "unavailable"
      log("run_command shell-env probe: pending")
      probePromise = (async () => {
        const resolved = await shellPromise
        const nul = await runProbe(resolved.shell, "env -0")
        let parsed =
          nul.exitCode === 0 && nul.truncated !== true && nul.stdout.includes(0)
            ? parseNullEnvironment(nul.stdout)
            : undefined
        if (parsed === undefined) {
          log("run_command shell-env probe: fallback_printenv")
          const lines = await runProbe(resolved.shell, "printenv")
          if (lines.exitCode === 0 && lines.truncated !== true)
            parsed = parsePrintenvEnvironment(lines.stdout)
        }
        if (parsed === undefined) {
          log("run_command shell-env probe: unavailable")
          return "unavailable"
        }
        probed = Object.freeze(mergeShellEnvironment(appEnv, parsed))
        log("run_command shell-env probe: ready")
        return "ready"
      })()
      return probePromise
    },
  }
}

export type ResolvedCommandShell = {
  readonly shell: string
  readonly warnings: readonly string[]
}

export async function resolveCommandShell(): Promise<ResolvedCommandShell> {
  const candidates: string[] = []
  const envShell = process.env.SHELL
  if (
    envShell !== undefined &&
    envShell.trim() !== "" &&
    envShell !== "unknown"
  ) {
    candidates.push(envShell)
  }
  try {
    const accountShell = userInfo().shell
    if (accountShell !== null && accountShell.trim() !== "") {
      candidates.push(accountShell)
    }
  } catch {
    // Containers and directory-service failures still have fixed fallbacks.
  }
  candidates.push("/bin/zsh", "/bin/bash", "/bin/sh")

  for (const candidate of new Set(candidates)) {
    try {
      const shell = await realpath(candidate)
      const info = await stat(shell)
      if (info.isFile() && SUPPORTED_SHELLS.has(basename(shell))) {
        return { shell, warnings: [] }
      }
    } catch {
      // Try the next supported shell.
    }
  }
  return {
    shell: "/bin/sh",
    warnings: [
      "No supported user shell could be verified; falling back to /bin/sh.",
    ],
  }
}

export function filterCommandEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([name, value]) => {
      if (value === undefined) return false
      const upper = name.toUpperCase()
      if (upper.startsWith("YAKITORI_") || upper.startsWith("ELECTRON_")) {
        return false
      }
      if (SHELL_STARTUP_ENV_NAMES.has(upper)) return false
      if (SECRET_ENV_NAMES.has(upper) || /_DATABASE_URL$/i.test(name))
        return false
      return !SECRET_ENV_PATTERN.test(name)
    }),
  )
}

function filterProbeEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const filtered = filterCommandEnvironment(environment)
  if (environment.ZDOTDIR !== undefined) filtered.ZDOTDIR = environment.ZDOTDIR
  return filtered
}

export function mergeShellEnvironment(
  appEnv: NodeJS.ProcessEnv,
  shellEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...filterCommandEnvironment(shellEnv) }
  const sparsePath = isSparsePath(appEnv.PATH)
  for (const name of ["PATH", "MANPATH"] as const) {
    const appValue = appEnv[name]
    const shellValue = shellEnv[name]
    const selected = sparsePath
      ? (shellValue ?? appValue)
      : (appValue ?? shellValue)
    if (selected !== undefined) merged[name] = selected
  }
  for (const [name, value] of Object.entries(appEnv)) {
    if (
      value !== undefined &&
      (name === "PORT" ||
        name === "NODE_ENV" ||
        name.startsWith("YAKITORI_") ||
        name.startsWith("ELECTRON_"))
    ) {
      merged[name] = value
    }
  }
  return filterCommandEnvironment(merged)
}

export function isSparsePath(path: string | undefined): boolean {
  if (path === undefined) return true
  const entries = path.split(":").filter((entry) => entry.length > 0)
  const sparse = new Set(["/usr/bin", "/bin", "/usr/sbin", "/sbin"])
  return entries.length === 0 || entries.every((entry) => sparse.has(entry))
}

export function parseNullEnvironment(output: Buffer): NodeJS.ProcessEnv {
  return parseEnvironmentBindings(output.toString("utf8").split("\0"))
}

export function parsePrintenvEnvironment(output: Buffer): NodeJS.ProcessEnv {
  const bindings: string[] = []
  let previousIndex: number | undefined
  for (const line of output.toString("utf8").split(/\r?\n/)) {
    if (line.length === 0) continue
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) {
      bindings.push(line)
      previousIndex = bindings.length - 1
      continue
    }
    // A continuation proves the previous printenv value contained a newline.
    if (previousIndex !== undefined) bindings.splice(previousIndex, 1)
    previousIndex = undefined
  }
  return parseEnvironmentBindings(bindings)
}

function parseEnvironmentBindings(
  bindings: readonly string[],
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const binding of bindings) {
    const separator = binding.indexOf("=")
    if (separator <= 0) continue
    const name = binding.slice(0, separator)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
    environment[name] = binding.slice(separator + 1)
  }
  return environment
}

async function runShellProbe(
  shell: string,
  command: "env -0" | "printenv",
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<ShellProbeResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, ["-l", "-c", shellProbeCommand(command)], {
        detached: platform !== "win32",
        env,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      })
    } catch (error) {
      resolve({
        exitCode: null,
        stdout: Buffer.alloc(0),
        error: error instanceof Error ? error.message : "Shell probe failed.",
      })
      return
    }
    const chunks: Buffer[] = []
    let captured = 0
    let truncated = false
    let settled = false
    let timedOut = false
    let forceCompletion: NodeJS.Timeout | undefined
    const finish = (result: ShellProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (forceCompletion !== undefined) clearTimeout(forceCompletion)
      const stdout = stripProbePreamble(command, result.stdout)
      resolve({
        ...result,
        ...(stdout === undefined
          ? {
              exitCode: null,
              error: result.error ?? "Shell probe sentinel was not observed.",
            }
          : { stdout }),
        ...(truncated ? { truncated: true } : {}),
      })
    }
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (captured >= PROBE_CAPTURE_BYTES) {
        truncated = true
        return
      }
      const remaining = PROBE_CAPTURE_BYTES - captured
      const kept = buffer.subarray(0, remaining)
      chunks.push(kept)
      captured += kept.byteLength
      if (kept.byteLength < buffer.byteLength) truncated = true
    })
    const timeout = setTimeout(() => {
      timedOut = true
      signalProbe(child, platform)
      forceCompletion = setTimeout(() => {
        child.stdout?.destroy()
        finish({
          exitCode: null,
          stdout: Buffer.concat(chunks),
          error: "Shell probe timed out.",
        })
      }, PROBE_FORCE_COMPLETION_MS)
    }, PROBE_TIMEOUT_MS)
    child.once("error", (error) => {
      finish({
        exitCode: null,
        stdout: Buffer.concat(chunks),
        error: error.message,
      })
    })
    child.once("close", (exitCode) => {
      finish({
        exitCode: timedOut ? null : exitCode,
        stdout: Buffer.concat(chunks),
        ...(timedOut ? { error: "Shell probe timed out." } : {}),
      })
    })
  })
}

function shellProbeCommand(command: "env -0" | "printenv"): string {
  if (command === "env -0") {
    return `printf '\\0${PROBE_SENTINEL}\\0'; env -0`
  }
  return `printf '${PROBE_SENTINEL}\\n'; printenv`
}

function stripProbePreamble(
  command: "env -0" | "printenv",
  output: Buffer,
): Buffer | undefined {
  const marker = Buffer.from(
    command === "env -0" ? `\0${PROBE_SENTINEL}\0` : `${PROBE_SENTINEL}\n`,
  )
  const index = output.indexOf(marker)
  return index < 0 ? undefined : output.subarray(index + marker.byteLength)
}

function signalProbe(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform,
): void {
  try {
    if (platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, "SIGKILL")
      return
    }
    child.kill("SIGKILL")
  } catch {
    // The probe process or process group already exited.
  }
}
