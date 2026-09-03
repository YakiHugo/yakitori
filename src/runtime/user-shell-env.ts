import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { basename, delimiter, join } from "node:path"

const PROBE_TIMEOUT_MS = 5_000
const PROBE_CAPTURE_BYTES = 1024 * 1024
const PROBE_FORCE_COMPLETION_MS = 100
const PROBE_SENTINEL = "__YAKITORI_ENV_START_7F31B6A9__"
const SNAPSHOT_TTL_MS = 3 * 24 * 60 * 60 * 1000
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
  shellSnapshot(): Promise<string | undefined>
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
    readonly homeDir?: string
    readonly now?: () => number
    readonly resolveShell?: () => Promise<ResolvedCommandShell>
    readonly runCapture?: (
      shell: string,
      command: string,
      login: boolean,
    ) => Promise<ShellProbeResult>
    readonly shellEnvironmentPolicy?: Partial<ShellEnvironmentPolicy>
    readonly log?: (message: string) => void
  } = {},
): UserShellEnv {
  const appEnv = { ...(options.appEnv ?? process.env) }
  const homeDir =
    options.homeDir ?? process.env.YAKITORI_HOME ?? join(homedir(), ".yakitori")
  const now = options.now ?? Date.now
  const shellEnvironmentPolicy = resolveShellEnvironmentPolicy(
    options.shellEnvironmentPolicy,
  )
  const resolveShell = options.resolveShell ?? resolveCommandShell
  const captureEnv = applyShellEnvironmentPolicy(appEnv, shellEnvironmentPolicy)
  const runCapture =
    options.runCapture ??
    ((shell, command, login) =>
      runShellProbe(shell, command, captureEnv, login))
  const log = options.log ?? ((message: string) => console.log(message))
  const shellPromise = resolveShell()
  const fallback = Object.freeze(captureEnv)
  let probed: Readonly<NodeJS.ProcessEnv> | undefined
  let probePromise: Promise<"ready" | "unavailable"> | undefined
  let snapshotPromise: Promise<string | undefined> | undefined

  return {
    async shellName() {
      return basename((await shellPromise).shell)
    },
    async shellSnapshot() {
      snapshotPromise ??= captureShellSnapshot({
        resolved: await shellPromise,
        homeDir,
        now,
        runCapture,
        log,
      })
      const path = await snapshotPromise
      if (path === undefined) return undefined
      // The TTL must hold for long-lived processes too, and a deleted
      // snapshot must regenerate; both reduce to one stat per call.
      const info = await stat(path).catch(() => undefined)
      if (info?.isFile() === true && now() - info.mtimeMs < SNAPSHOT_TTL_MS) {
        return path
      }
      snapshotPromise = captureShellSnapshot({
        resolved: await shellPromise,
        homeDir,
        now,
        runCapture,
        log,
      })
      return snapshotPromise
    },
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
): Promise<ShellProbeResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(
        shell,
        [...(login ? ["-l"] : []), "-c", shellProbeCommand(command)],
        {
          detached: true,
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

// The snapshot captures only alias and function definitions. Environment
// variables are deliberately excluded: the merged env from
// `commandEnvironment` owns them, so sourcing rc-file exports here would
// reintroduce variables that `shell_environment_policy` filtered out. rc
// exports therefore remain unavailable to model commands, as before. The
// login shell sources the interactive rc file once at generation time, so rc
// side effects (banners, hooks) never reach per-command shells.
function snapshotSpec(
  shellName: string,
): { readonly header: string; readonly dumpCommand: string } | undefined {
  switch (shellName) {
    case "zsh":
      return {
        header: "",
        dumpCommand: `[ -r "\${ZDOTDIR:-$HOME}/.zshrc" ] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1; typeset -f; alias -L`,
      }
    case "bash":
      return {
        header: "shopt -s expand_aliases\n",
        dumpCommand: `[ -r "$HOME/.bashrc" ] && source "$HOME/.bashrc" >/dev/null 2>&1; declare -f; alias -p`,
      }
    default:
      return undefined
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

// Aliases expand only when the command text is parsed after the definitions
// exist, so the snapshot is sourced and the command re-parsed via eval.
export function wrapWithShellSnapshot(
  snapshotPath: string,
  command: string,
): string {
  return `source ${shellQuote(snapshotPath)} 2>/dev/null || true\neval ${shellQuote(command)}`
}

async function captureShellSnapshot(input: {
  readonly resolved: ResolvedCommandShell
  readonly homeDir: string
  readonly now: () => number
  readonly runCapture: (
    shell: string,
    command: string,
    login: boolean,
  ) => Promise<ShellProbeResult>
  readonly log: (message: string) => void
}): Promise<string | undefined> {
  const name = basename(input.resolved.shell).toLowerCase()
  const spec = snapshotSpec(name)
  if (spec === undefined) return undefined
  const key = createHash("sha256")
    .update(input.resolved.shell)
    .digest("hex")
    .slice(0, 8)
  const directory = join(input.homeDir, "shell-snapshots")
  const target = join(directory, `${name}-${key}.sh`)

  const existing = await stat(target).catch(() => undefined)
  if (
    existing?.isFile() === true &&
    input.now() - existing.mtimeMs < SNAPSHOT_TTL_MS
  ) {
    return target
  }

  const capture = await input.runCapture(
    input.resolved.shell,
    spec.dumpCommand,
    true,
  )
  if (capture.exitCode !== 0 || capture.truncated === true) {
    input.log(
      `exec_command shell snapshot: unavailable (${probeFailureReason(capture)})`,
    )
    return undefined
  }
  const content = `# Yakitori shell snapshot for ${input.resolved.shell}.\n# Reused across sessions for up to three days; delete this file to regenerate.\n${spec.header}${capture.stdout.toString("utf8").trim()}\n`

  // A filesystem failure must degrade to plain exec, never fail the command.
  const temporary = join(
    directory,
    `.${name}-${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
  )
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(temporary, content, { mode: 0o600 })
    const validation = await input.runCapture(
      input.resolved.shell,
      `source ${shellQuote(temporary)}`,
      false,
    )
    if (validation.exitCode !== 0) {
      input.log(
        `exec_command shell snapshot: validation failed (${probeFailureReason(validation)})`,
      )
      return undefined
    }
    await rename(temporary, target)
    await removeStaleSnapshots(directory, input.now, input.log)
    return target
  } catch (error) {
    input.log(
      `exec_command shell snapshot: unavailable (${error instanceof Error ? error.message : String(error)})`,
    )
    return undefined
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

async function removeStaleSnapshots(
  directory: string,
  now: () => number,
  log: (message: string) => void,
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (error) {
    log(
      `exec_command shell snapshot: cleanup could not list ${directory} (${error instanceof Error ? error.message : String(error)})`,
    )
    return
  }
  for (const entry of entries) {
    if (!entry.endsWith(".sh") && !entry.endsWith(".tmp")) continue
    const path = join(directory, entry)
    const info = await stat(path).catch(() => undefined)
    if (info === undefined || now() - info.mtimeMs < SNAPSHOT_TTL_MS) continue
    await rm(path, { force: true }).catch((error: unknown) => {
      log(
        `exec_command shell snapshot: cleanup could not remove ${path} (${error instanceof Error ? error.message : String(error)})`,
      )
    })
  }
}
