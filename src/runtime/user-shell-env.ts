import { spawn } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import { userInfo } from "node:os"
import { basename, delimiter, join } from "node:path"

const PROBE_TIMEOUT_MS = 5_000
const PROBE_CAPTURE_BYTES = 1024 * 1024
const PROBE_FORCE_COMPLETION_MS = 100
const PROBE_SENTINEL = "__YAKITORI_ENV_START_7F31B6A9__"
// Executor safety bounds follow Codex v2: bound cached shell state and retry
// failed startup scripts without retrying on every tool invocation.
const MAX_SNAPSHOT_BYTES = 512 * 1024
const MAX_CACHED_SNAPSHOTS = 16
const MAX_SNAPSHOT_ATTEMPTS = 3
const SNAPSHOT_RETRY_MS = 1_000
const SUPPORTED_SHELLS = new Set(["zsh", "bash", "sh"])
const NON_INHERITABLE_ENV_NAMES = new Set([
  "ELECTRON_RUN_AS_NODE",
  "NODE_REPL_AUTH_TOKEN",
])
const CORE_ENV_NAMES = new Set(
  [
    "PATH",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "USER",
  ].map((name) => name.toUpperCase()),
)

export type ShellEnvironmentPolicy = Readonly<{
  inherit: "all" | "core" | "none"
  ignoreDefaultExcludes: boolean
  exclude: readonly string[]
  set: Readonly<Record<string, string>>
  includeOnly: readonly string[]
}>

export type CommandEnvironment = {
  readonly shell: string
  readonly env: NodeJS.ProcessEnv
  readonly warnings: readonly string[]
}

export type UserShellEnv = {
  commandEnvironment(cwd: string): Promise<CommandEnvironment>
  probe(): Promise<"ready" | "unavailable">
  shellName(): Promise<string>
  shellSnapshot(cwd: string): Promise<ShellSnapshot | undefined>
}

export type ShellSnapshot = Readonly<{
  state: string
  environment: NodeJS.ProcessEnv
}>

export type ShellProbeResult = {
  readonly exitCode: number | null
  readonly stdout: Buffer
  readonly error?: string
  readonly truncated?: boolean
}

export function createUserShellEnv(
  options: {
    readonly appEnv?: NodeJS.ProcessEnv
    readonly now?: () => number
    readonly resolveShell?: () => Promise<ResolvedCommandShell>
    readonly runCapture?: (
      shell: string,
      command: string,
      login: boolean,
      cwd?: string,
    ) => Promise<ShellProbeResult>
    readonly shellEnvironmentPolicy?: Partial<ShellEnvironmentPolicy>
    readonly log?: (message: string) => void
  } = {},
): UserShellEnv {
  const appEnv = { ...(options.appEnv ?? process.env) }
  const now = options.now ?? Date.now
  const shellEnvironmentPolicy = resolveShellEnvironmentPolicy(
    options.shellEnvironmentPolicy,
  )
  const resolveShell = options.resolveShell ?? resolveCommandShell
  const captureEnv = applyShellEnvironmentPolicy(appEnv, shellEnvironmentPolicy)
  const runCapture =
    options.runCapture ??
    ((shell, command, login, cwd) =>
      runShellProbe(shell, command, captureEnv, login, cwd))
  const log = options.log ?? ((message: string) => console.log(message))
  const shellPromise = resolveShell()
  const fallback = Object.freeze(captureEnv)
  let probed: Readonly<NodeJS.ProcessEnv> | undefined
  let probePromise: Promise<"ready" | "unavailable"> | undefined
  const snapshots = new Map<
    string,
    {
      attempts: number
      retryAt: number
      promise: Promise<ShellSnapshot | undefined>
    }
  >()

  return {
    async shellName() {
      return basename((await shellPromise).shell)
    },
    async shellSnapshot(cwd) {
      const resolved = await shellPromise
      const cached = snapshots.get(cwd)
      if (cached !== undefined) {
        const result = await cached.promise
        if (
          result !== undefined ||
          cached.attempts >= MAX_SNAPSHOT_ATTEMPTS ||
          now() < cached.retryAt
        )
          return result
        // Another caller may already have started the retry while we awaited.
        if (snapshots.get(cwd) !== cached) return snapshots.get(cwd)?.promise
      }
      const entry = {
        attempts: (cached?.attempts ?? 0) + 1,
        retryAt: Number.POSITIVE_INFINITY,
        promise: captureShellSnapshot(
          resolved,
          cwd,
          runCapture,
          shellEnvironmentPolicy,
          log,
        ),
      }
      snapshots.delete(cwd)
      snapshots.set(cwd, entry)
      if (snapshots.size > MAX_CACHED_SNAPSHOTS) {
        const oldest = snapshots.keys().next().value
        if (oldest !== undefined) snapshots.delete(oldest)
      }
      const result = await entry.promise
      if (result === undefined) entry.retryAt = now() + SNAPSHOT_RETRY_MS
      return result
    },
    async commandEnvironment(cwd) {
      const resolved = await shellPromise
      const env: NodeJS.ProcessEnv = {
        ...(probed ?? fallback),
        TERM: "dumb",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        PWD: cwd,
      }
      // These hooks are inputs to snapshot capture. Passing them to the real
      // command would source startup files again after policy filtering.
      delete env.BASH_ENV
      delete env.ENV
      return {
        shell: resolved.shell,
        warnings: resolved.warnings,
        env,
      }
    },
    async probe() {
      if (probePromise !== undefined) return probePromise
      log("exec_command shell-env probe: pending")
      probePromise = (async () => {
        const resolved = await shellPromise
        const nul = await runCapture(resolved.shell, "env -0", true)
        let parsed =
          nul.exitCode === 0 && nul.truncated !== true && nul.stdout.includes(0)
            ? parseNullEnvironment(nul.stdout)
            : undefined
        if (parsed === undefined) {
          log(
            `exec_command shell-env probe: fallback_printenv (${probeFailureReason(nul)})`,
          )
          const lines = await runCapture(resolved.shell, "printenv", true)
          if (lines.exitCode === 0 && lines.truncated !== true)
            parsed = parsePrintenvEnvironment(lines.stdout)
          if (parsed === undefined) {
            log(
              `exec_command shell-env probe: unavailable (${probeFailureReason(lines)})`,
            )
            return "unavailable"
          }
        }
        probed = Object.freeze(
          mergeShellEnvironment(appEnv, parsed, shellEnvironmentPolicy),
        )
        log("exec_command shell-env probe: ready")
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

export async function resolveCommandShell(
  options: {
    readonly accountShell?: () => string | null
    readonly path?: string
    readonly resolveCandidate?: (path: string) => Promise<string | undefined>
  } = {},
): Promise<ResolvedCommandShell> {
  let accountShell: string | null = null
  try {
    accountShell = (options.accountShell ?? (() => userInfo().shell))()
  } catch {
    // Directory-service failures still have PATH and fixed fallbacks.
  }
  const pathEntries = (options.path ?? process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0)
  const candidates = [
    ...(accountShell !== null &&
    accountShell.trim() !== "" &&
    SUPPORTED_SHELLS.has(basename(accountShell))
      ? [accountShell]
      : []),
    ...pathEntries.map((entry) => join(entry, "zsh")),
    ...pathEntries.map((entry) => join(entry, "bash")),
    "/bin/zsh",
    "/bin/bash",
    "/bin/sh",
  ]
  const resolveCandidate = options.resolveCandidate ?? verifyShellCandidate

  for (const candidate of new Set(candidates)) {
    const shell = await resolveCandidate(candidate)
    if (shell !== undefined) return { shell, warnings: [] }
  }
  return {
    shell: "/bin/sh",
    warnings: [
      "No supported user shell could be verified; falling back to /bin/sh.",
    ],
  }
}

async function verifyShellCandidate(
  candidate: string,
): Promise<string | undefined> {
  try {
    const shell = await realpath(candidate)
    const info = await stat(shell)
    if (info.isFile() && SUPPORTED_SHELLS.has(basename(shell))) return shell
  } catch {
    // Try the next supported shell.
  }
}

export function applyShellEnvironmentPolicy(
  environment: NodeJS.ProcessEnv,
  policy: ShellEnvironmentPolicy = resolveShellEnvironmentPolicy(),
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(environment).filter(([name, value]) => {
      if (value === undefined || policy.inherit === "none") return false
      return policy.inherit === "all" || CORE_ENV_NAMES.has(name.toUpperCase())
    }),
  )
  if (!policy.ignoreDefaultExcludes) {
    removeMatching(inherited, ["*KEY*", "*SECRET*", "*TOKEN*"])
  }
  removeMatching(inherited, policy.exclude)
  Object.assign(inherited, policy.set)
  if (policy.includeOnly.length > 0) {
    for (const name of Object.keys(inherited)) {
      if (!matchesAnyPattern(name, policy.includeOnly)) delete inherited[name]
    }
  }
  return scrubNonInheritableEnvironment(inherited)
}

export function mergeShellEnvironment(
  appEnv: NodeJS.ProcessEnv,
  shellEnv: NodeJS.ProcessEnv,
  policy: ShellEnvironmentPolicy = resolveShellEnvironmentPolicy(),
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...shellEnv, ...appEnv }
  const sparsePath = isSparsePath(appEnv.PATH)
  for (const name of ["PATH", "MANPATH"] as const) {
    const appValue = appEnv[name]
    const shellValue = shellEnv[name]
    const selected = sparsePath
      ? (shellValue ?? appValue)
      : (appValue ?? shellValue)
    if (selected !== undefined) merged[name] = selected
  }
  return applyShellEnvironmentPolicy(merged, policy)
}

function resolveShellEnvironmentPolicy(
  input: Partial<ShellEnvironmentPolicy> = {},
): ShellEnvironmentPolicy {
  return {
    inherit: input.inherit ?? "all",
    ignoreDefaultExcludes: input.ignoreDefaultExcludes ?? true,
    exclude: [...(input.exclude ?? [])],
    set: { ...(input.set ?? {}) },
    includeOnly: [...(input.includeOnly ?? [])],
  }
}

function scrubNonInheritableEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) =>
        value !== undefined &&
        !NON_INHERITABLE_ENV_NAMES.has(name.toUpperCase()),
    ),
  )
}

function removeMatching(
  environment: NodeJS.ProcessEnv,
  patterns: readonly string[],
): void {
  for (const name of Object.keys(environment)) {
    if (matchesAnyPattern(name, patterns)) delete environment[name]
  }
}

function matchesAnyPattern(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globPattern(pattern).test(name))
}

function globPattern(pattern: string): RegExp {
  const source = [...pattern]
    .map((character) => {
      if (character === "*") return ".*"
      if (character === "?") return "."
      return character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
    })
    .join("")
  return new RegExp(`^${source}$`, "i")
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

function probeFailureReason(result: ShellProbeResult): string {
  if (result.error !== undefined) return result.error
  if (result.truncated === true) return "output truncated"
  if (result.exitCode !== 0) return `exit code ${result.exitCode ?? "unknown"}`
  return "unparseable output"
}

async function runShellProbe(
  shell: string,
  command: string,
  env: NodeJS.ProcessEnv,
  login: boolean,
  cwd?: string,
): Promise<ShellProbeResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(
        shell,
        [...(login ? ["-l"] : []), "-c", shellProbeCommand(command)],
        {
          detached: true,
          cwd,
          env,
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        },
      )
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
      const stdout = stripProbePreamble(result.stdout)
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
      signalProbe(child)
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

function shellProbeCommand(command: string): string {
  return `printf '\\0${PROBE_SENTINEL}\\0'; ${command}`
}

function stripProbePreamble(output: Buffer): Buffer | undefined {
  const marker = Buffer.from(`\0${PROBE_SENTINEL}\0`)
  const index = output.indexOf(marker)
  return index < 0 ? undefined : output.subarray(index + marker.byteLength)
}

function signalProbe(child: ReturnType<typeof spawn>): void {
  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, "SIGKILL")
      return
    }
    child.kill("SIGKILL")
  } catch {
    // The probe process or process group already exited.
  }
}

// Capture definitions and exports separately, as in Codex v2. rc-file exports
// must pass policy after startup; restoring an export script would bypass it.
async function captureShellSnapshot(
  resolved: ResolvedCommandShell,
  cwd: string,
  runCapture: (
    shell: string,
    command: string,
    login: boolean,
    cwd?: string,
  ) => Promise<ShellProbeResult>,
  policy: ShellEnvironmentPolicy,
  log: (message: string) => void,
): Promise<ShellSnapshot | undefined> {
  const name = basename(resolved.shell).toLowerCase()
  let script: string
  switch (name) {
    case "zsh":
      script = `[ -r "\${ZDOTDIR:-$HOME}/.zshrc" ] && . "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1; builtin printf '\\0'; builtin typeset -f; builtin alias -L; builtin alias -gL; builtin alias -sL`
      break
    case "bash":
      script = `[ -z "$BASH_ENV" ] && [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc" >/dev/null 2>&1; builtin printf '\\0'; builtin declare -f; builtin alias -p`
      break
    case "sh":
      script = `[ -n "$ENV" ] && [ -r "$ENV" ] && . "$ENV" >/dev/null 2>&1; printf '\\0'; if command -v typeset >/dev/null 2>&1; then typeset -f; fi; alias`
      break
    default:
      return undefined
  }
  const capture = await runCapture(
    resolved.shell,
    `${script}; printf '\\0'; /usr/bin/env -0`,
    true,
    cwd,
  )
  const start = capture.stdout.indexOf(0)
  const separator = capture.stdout.indexOf(0, start + 1)
  if (
    capture.exitCode !== 0 ||
    capture.truncated === true ||
    capture.stdout.length > MAX_SNAPSHOT_BYTES ||
    start < 0 ||
    separator < 0
  ) {
    log(
      `exec_command shell snapshot: unavailable (${probeFailureReason(capture)})`,
    )
    return undefined
  }
  const environment = applyShellEnvironmentPolicy(
    parseNullEnvironment(capture.stdout.subarray(separator + 1)) ?? {},
    { ...policy, inherit: "all" },
  )
  delete environment.PWD
  delete environment.OLDPWD
  delete environment.BASH_ENV
  delete environment.ENV
  return {
    state: capture.stdout.subarray(start + 1, separator).toString("utf8"),
    environment,
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

// State stays in executor memory and travels in bounded environment values,
// rather than a potentially oversized argv string or a file containing secrets.
export function wrapWithShellSnapshot(
  snapshot: ShellSnapshot,
  command: string,
  environment: NodeJS.ProcessEnv,
): Readonly<{ command: string; env: NodeJS.ProcessEnv }> {
  const env: NodeJS.ProcessEnv = {
    ...environment,
    ...snapshot.environment,
    PWD: environment.PWD,
    TERM: environment.TERM,
    NO_COLOR: environment.NO_COLOR,
    FORCE_COLOR: environment.FORCE_COLOR,
  }
  const keys: string[] = []
  let remaining = snapshot.state
  while (remaining.length > 0) {
    // 15k UTF-16 code units fit below Codex's 60 KiB per-value boundary.
    let end = Math.min(15 * 1024, remaining.length)
    const last = remaining.charCodeAt(end - 1)
    if (last >= 0xd800 && last <= 0xdbff) end -= 1
    const key = `__YAKITORI_SHELL_SNAPSHOT_STATE_${keys.length}`
    env[key] = remaining.slice(0, end)
    keys.push(key)
    remaining = remaining.slice(end)
  }
  const expansion = keys.map((key) => `\${${key}}`).join("")
  const restore =
    keys.length === 0
      ? ""
      : `if ! eval "unset ${keys.join(" ")}\n${expansion}"; then printf 'Failed to restore shell snapshot\n' >&2; fi\n`
  return { command: `${restore}eval ${shellQuote(command)}`, env }
}
