import { type ChildProcess, spawn } from "node:child_process"
import { randomInt } from "node:crypto"
import { basename } from "node:path"
import { type IPty, spawn as spawnPty } from "node-pty"
import type { JsonValue } from "../../kernel/index.ts"
import { ToolLimitDefaults } from "../limits.ts"
import {
  createUserShellEnv,
  type UserShellEnv,
  wrapWithShellSnapshot,
} from "../user-shell-env.ts"
import { commandApprovalRequirement } from "./approval-requirements.ts"
import { matchCatastrophicCommand } from "./command-fuse.ts"
import {
  commandExecution,
  completeCommandExecution,
} from "./execution-descriptors.ts"
import { resolveCommandCwd } from "./path-policy.ts"
import { plainToolName } from "./tool-name.ts"
import type { RuntimeTool, ToolExecutionResult } from "./types.ts"

const DEFAULT_EXEC_YIELD_MS = 10_000
const MIN_YIELD_MS = 250
const MAX_YIELD_MS = 30_000
const DEFAULT_EMPTY_POLL_MS = 5_000
const MAX_EMPTY_POLL_MS = 300_000
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000
const DEFAULT_BACKGROUND_TIMEOUT_MS = 300_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_PROCESSES = 64
const PROTECTED_RECENT_PROCESSES = 8
const OUTPUT_HEAD_RATIO = 0.3

export type UnifiedExecOutput = Readonly<{
  chunk_id: string
  wall_time_seconds: number
  output: string
  original_token_count: number
  exit_code?: number
  session_id?: number
}>

type ExecInput = Readonly<{
  cmd: string
  workdir?: string
  tty: boolean
  yieldTimeMs: number
  maxOutputTokens: number
}>

type WriteInput = Readonly<{
  sessionId: number
  chars: string
  yieldTimeMs: number
  maxOutputTokens: number
}>

type ProcessExit = Readonly<{ exitCode: number; signal?: string }>

type ProcessHandle = Readonly<{
  pid: number
  write(chars: string): void
  terminate(signal: NodeJS.Signals): void
}>

type ProcessEntry = {
  readonly id: number
  readonly handle: ProcessHandle
  readonly output: IntervalOutputBuffer
  readonly exit: Promise<ProcessExit>
  readonly timeout: NodeJS.Timeout
  readonly tty: boolean
  interaction: Promise<void>
  interactionCount: number
  lastUsedAt: number
  exited?: ProcessExit
}

export type UnifiedExecProcessManager = Readonly<{
  exec(input: {
    readonly command: string
    readonly cwd: string
    readonly shell: string
    readonly env: NodeJS.ProcessEnv
    readonly tty: boolean
    readonly yieldTimeMs: number
    readonly maxOutputTokens: number
    readonly signal?: AbortSignal
  }): Promise<UnifiedExecOutput>
  write(input: WriteInput, signal?: AbortSignal): Promise<UnifiedExecOutput>
  close(): Promise<void>
}>

export function createUnifiedExecTools(
  options: {
    readonly userShellEnv?: UserShellEnv
    readonly maxCommandBytes?: number
    readonly backgroundTimeoutMs?: number
    readonly killGraceMs?: number
    readonly log?: (message: string) => void
  } = {},
): ReadonlyArray<RuntimeTool> {
  const userShellEnv =
    options.userShellEnv ?? createUserShellEnv({ log: () => {} })
  const maxCommandBytes =
    options.maxCommandBytes ?? ToolLimitDefaults.commandTextBytes
  const manager = createUnifiedExecProcessManager({
    backgroundTimeoutMs:
      options.backgroundTimeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT_MS,
    killGraceMs: options.killGraceMs ?? ToolLimitDefaults.commandKillGraceMs,
  })
  const log = options.log ?? (() => {})

  const execCommand: RuntimeTool = {
    toolName: plainToolName("exec_command"),
    description:
      "Run a shell command in plain pipes or a PTY. Commands that finish within the yield interval return their exit code; longer commands return a session_id for write_stdin. Runs with the host user's full filesystem, process, environment, and network authority and is not sandboxed.",
    async approvalRequirement(rawInput, context) {
      const parsed = parseExecInput(rawInput, maxCommandBytes)
      if (!parsed.ok || matchCatastrophicCommand(parsed.value.cmd)) {
        return { kind: "none" }
      }
      const cwd = await resolveCommandCwd(
        context.workspaceRoot,
        parsed.value.workdir,
      )
      return cwd.ok
        ? commandApprovalRequirement({
            command: parsed.value.cmd,
            cwd: cwd.absolutePath,
          })
        : { kind: "none" }
    },
    effect: "opaque",
    supportsParallelToolCalls: true,
    describeExecution(input) {
      const cmd =
        typeof input === "object" &&
        input !== null &&
        !Array.isArray(input) &&
        typeof Reflect.get(input, "cmd") === "string"
          ? (Reflect.get(input, "cmd") as string)
          : ""
      return commandExecution({ command: cmd })
    },
    completeExecution: completeCommandExecution,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cmd: { type: "string", description: "Shell command to execute." },
        workdir: {
          type: "string",
          description:
            "Working directory. Relative paths resolve from the workspace; absolute paths may point anywhere.",
        },
        tty: {
          type: "boolean",
          description:
            "True allocates a PTY; false or omitted uses plain pipes.",
        },
        "yield-time_ms": {
          type: "integer",
          minimum: MIN_YIELD_MS,
          maximum: MAX_YIELD_MS,
          description: `Wait before yielding output. Defaults to ${DEFAULT_EXEC_YIELD_MS} ms.`,
        },
        max_output_tokens: {
          type: "integer",
          minimum: 1,
          description: `Output budget. Defaults to ${DEFAULT_MAX_OUTPUT_TOKENS} approximate tokens.`,
        },
      },
      required: ["cmd"],
    },
    async execute(rawInput, context) {
      const parsed = parseExecInput(rawInput, maxCommandBytes)
      if (!parsed.ok) return parsed.result
      if (context.signal?.aborted) return abortedBeforeStart()
      const cwd = await resolveCommandCwd(
        context.workspaceRoot,
        parsed.value.workdir,
      )
      if (!cwd.ok) return failure("invalid_cwd", cwd.error.message)
      const blocked = matchCatastrophicCommand(parsed.value.cmd)
      if (blocked !== undefined) {
        return failure(
          "command_blocked",
          `Command blocked by catastrophic-command fuse (${blocked.rule}). No process was started.`,
          { blocked },
        )
      }
      const environment = await userShellEnv.commandEnvironment(
        cwd.absolutePath,
      )
      const snapshot = await userShellEnv.shellSnapshot()
      log(
        `exec_command start token=${firstCommandToken(parsed.value.cmd)} bytes=${Buffer.byteLength(parsed.value.cmd, "utf8")}`,
      )
      try {
        const output = await manager.exec({
          command:
            snapshot === undefined
              ? parsed.value.cmd
              : wrapWithShellSnapshot(snapshot, parsed.value.cmd),
          cwd: cwd.absolutePath,
          shell: environment.shell,
          env: environment.env,
          tty: parsed.value.tty,
          yieldTimeMs: parsed.value.yieldTimeMs,
          maxOutputTokens: parsed.value.maxOutputTokens,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        })
        return success(output)
      } catch (error) {
        return failure(
          "exec_command_failed",
          error instanceof Error ? error.message : "Command failed to start.",
        )
      }
    },
    dispose: () => manager.close(),
  }

  const writeStdin: RuntimeTool = {
    toolName: plainToolName("write_stdin"),
    description:
      "Write characters to a running exec_command session, or poll it with empty chars. Returns only output produced since the preceding interaction.",
    approvalRequirement: { kind: "none" },
    effect: "opaque",
    supportsParallelToolCalls: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        session_id: {
          type: "integer",
          description: "Session identifier returned by exec_command.",
        },
        chars: {
          type: "string",
          description:
            "Characters to write. Defaults to empty, which polls without writing.",
        },
        "yield-time_ms": {
          type: "integer",
          minimum: MIN_YIELD_MS,
          maximum: MAX_EMPTY_POLL_MS,
          description:
            "Wait before yielding. Non-empty writes default to 250 ms; empty polls default to 5000 ms.",
        },
        max_output_tokens: {
          type: "integer",
          minimum: 1,
          description: `Output budget. Defaults to ${DEFAULT_MAX_OUTPUT_TOKENS} approximate tokens.`,
        },
      },
      required: ["session_id"],
    },
    async execute(rawInput, context) {
      const parsed = parseWriteInput(rawInput)
      if (!parsed.ok) return parsed.result
      try {
        return success(await manager.write(parsed.value, context.signal))
      } catch (error) {
        return failure(
          "write_stdin_failed",
          error instanceof Error ? error.message : "write_stdin failed.",
        )
      }
    },
  }

  return [execCommand, writeStdin]
}

export function createUnifiedExecProcessManager(
  options: {
    readonly backgroundTimeoutMs?: number
    readonly killGraceMs?: number
    readonly nextSessionId?: () => number
  } = {},
): UnifiedExecProcessManager {
  const backgroundTimeoutMs = options.backgroundTimeoutMs ?? 300_000
  const killGraceMs = options.killGraceMs ?? 2_000
  const entries = new Map<number, ProcessEntry>()
  let closed = false
  const terminateEntry = (entry: ProcessEntry, signal: NodeJS.Signals) => {
    entry.handle.terminate(signal)
    const force = setTimeout(
      () => entry.handle.terminate("SIGKILL"),
      killGraceMs,
    )
    force.unref()
    void entry.exit.finally(() => clearTimeout(force))
  }

  const pruneIfNeeded = () => {
    if (entries.size < MAX_PROCESSES) return
    const byRecency = [...entries.values()].sort(
      (left, right) => right.lastUsedAt - left.lastUsedAt,
    )
    const protectedIds = new Set(
      byRecency.slice(0, PROTECTED_RECENT_PROCESSES).map((entry) => entry.id),
    )
    const candidates = [...byRecency].reverse()
    const candidate =
      candidates.find(
        (entry) =>
          !protectedIds.has(entry.id) &&
          entry.exited !== undefined &&
          entry.interactionCount === 0,
      ) ??
      candidates.find(
        (entry) => !protectedIds.has(entry.id) && entry.interactionCount === 0,
      )
    if (candidate === undefined) return
    entries.delete(candidate.id)
    clearTimeout(candidate.timeout)
    if (candidate.exited === undefined) terminateEntry(candidate, "SIGTERM")
  }

  const allocateId = () => {
    pruneIfNeeded()
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const id = options.nextSessionId?.() ?? randomInt(1_000, 100_000)
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error("Unified exec session IDs must be positive integers.")
      }
      if (!entries.has(id)) return id
    }
    throw new Error("Unable to allocate a unique unified exec session ID.")
  }

  const manager: UnifiedExecProcessManager = {
    async exec(input) {
      if (closed) throw new Error("Unified exec manager is closed.")
      if (input.signal?.aborted) throw abortError()
      const id = allocateId()
      const output = new IntervalOutputBuffer(MAX_OUTPUT_BYTES)
      const spawned = input.tty
        ? launchPty(input, output)
        : launchPipe(input, output)
      const timeout = setTimeout(() => {
        const entry = entries.get(id)
        if (entry !== undefined) terminateEntry(entry, "SIGTERM")
      }, backgroundTimeoutMs)
      timeout.unref()
      const entry: ProcessEntry = {
        id,
        handle: spawned.handle,
        output,
        exit: spawned.exit,
        timeout,
        tty: input.tty,
        interaction: Promise.resolve(),
        interactionCount: 1,
        lastUsedAt: Date.now(),
      }
      entries.set(id, entry)
      void entry.exit.then((exit) => {
        entry.exited = exit
        clearTimeout(timeout)
      })

      const onAbort = () => terminateEntry(entry, "SIGTERM")
      input.signal?.addEventListener("abort", onAbort, { once: true })
      if (input.signal?.aborted) onAbort()
      const startedAt = Date.now()
      try {
        await waitForExitOrYield(
          entry,
          clamp(input.yieldTimeMs, MIN_YIELD_MS, MAX_YIELD_MS),
        )
        return observe(
          entry,
          Date.now() - startedAt,
          input.maxOutputTokens,
          entries,
        )
      } finally {
        entry.interactionCount -= 1
        input.signal?.removeEventListener("abort", onAbort)
      }
    },
    async write(input, signal) {
      if (closed) throw new Error("Unified exec manager is closed.")
      const entry = entries.get(input.sessionId)
      if (entry === undefined) {
        throw new Error(`Unknown unified exec session_id: ${input.sessionId}`)
      }
      entry.interactionCount += 1
      entry.lastUsedAt = Date.now()
      const interaction = entry.interaction.then(async () => {
        try {
          if (entries.get(input.sessionId) !== entry) {
            throw new Error(
              `Unknown unified exec session_id: ${input.sessionId}`,
            )
          }
          if (signal?.aborted) throw abortError()
          if (input.chars.length > 0 && entry.exited === undefined) {
            if (!entry.tty && input.chars !== "\u0003") {
              throw new Error(
                "stdin is closed for plain-pipe sessions; use tty: true for interactive input.",
              )
            }
            entry.handle.write(input.chars)
          }
          const startedAt = Date.now()
          const yieldTimeMs =
            input.chars.length === 0
              ? clamp(
                  input.yieldTimeMs,
                  DEFAULT_EMPTY_POLL_MS,
                  MAX_EMPTY_POLL_MS,
                )
              : clamp(input.yieldTimeMs, MIN_YIELD_MS, MAX_YIELD_MS)
          await waitForExitOrYield(entry, yieldTimeMs, signal)
          return observe(
            entry,
            Date.now() - startedAt,
            input.maxOutputTokens,
            entries,
          )
        } finally {
          entry.interactionCount -= 1
        }
      })
      entry.interaction = interaction.then(
        () => undefined,
        () => undefined,
      )
      return interaction
    },
    async close() {
      if (closed) return
      closed = true
      const active = [...entries.values()]
      for (const entry of active) terminateEntry(entry, "SIGTERM")
      await Promise.allSettled(active.map((entry) => entry.exit))
      for (const entry of active) clearTimeout(entry.timeout)
      entries.clear()
    },
  }
  return manager
}

function launchPipe(
  input: {
    readonly command: string
    readonly cwd: string
    readonly shell: string
    readonly env: NodeJS.ProcessEnv
  },
  output: IntervalOutputBuffer,
): { readonly handle: ProcessHandle; readonly exit: Promise<ProcessExit> } {
  const child =
    process.platform === "win32"
      ? spawn(input.command, {
          cwd: input.cwd,
          shell: input.shell,
          env: input.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        })
      : spawn(input.shell, shellArguments(input.shell, input.command), {
          cwd: input.cwd,
          detached: true,
          env: input.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        })
  child.stdout?.on("data", (chunk: Buffer | string) => output.append(chunk))
  child.stderr?.on("data", (chunk: Buffer | string) => output.append(chunk))
  const exit = observeChildExit(child, output)
  return {
    handle: {
      pid: child.pid ?? -1,
      write(chars) {
        if (chars === "\u0003" && process.platform !== "win32") {
          signalProcess(child, "SIGINT")
        } else {
          child.stdin?.write(chars)
        }
      },
      terminate(signal) {
        signalProcess(child, signal)
      },
    },
    exit,
  }
}

function launchPty(
  input: {
    readonly command: string
    readonly cwd: string
    readonly shell: string
    readonly env: NodeJS.ProcessEnv
  },
  output: IntervalOutputBuffer,
): { readonly handle: ProcessHandle; readonly exit: Promise<ProcessExit> } {
  let terminal: IPty
  try {
    terminal = spawnPty(
      input.shell,
      shellArguments(input.shell, input.command),
      {
        cwd: input.cwd,
        env: definedEnvironment(input.env),
        name: "xterm-256color",
        cols: 120,
        rows: 40,
      },
    )
  } catch (error) {
    throw new Error(
      `Failed to spawn PTY: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  terminal.onData((data) => output.append(data))
  const exit = new Promise<ProcessExit>((resolve) => {
    terminal.onExit(({ exitCode, signal }) => {
      const terminatedBySignal = signal !== undefined && signal !== 0
      resolve({
        exitCode: terminatedBySignal ? 128 + signal : exitCode,
        ...(terminatedBySignal ? { signal: String(signal) } : {}),
      })
    })
  })
  return {
    handle: {
      pid: terminal.pid,
      write: (chars) => terminal.write(chars),
      terminate: (signal) => terminal.kill(signal),
    },
    exit,
  }
}

function observeChildExit(
  child: ChildProcess,
  output: IntervalOutputBuffer,
): Promise<ProcessExit> {
  return new Promise((resolve) => {
    child.once("error", (error) => {
      output.append(`Failed to spawn command: ${error.message}`)
      resolve({ exitCode: -1 })
    })
    child.once("close", (code, signal) =>
      resolve({
        exitCode: code ?? -1,
        ...(signal === null ? {} : { signal }),
      }),
    )
  })
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal)
    } else {
      child.kill(signal)
    }
  } catch {
    // The process group already exited.
  }
}

async function waitForExitOrYield(
  entry: ProcessEntry,
  yieldTimeMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (entry.exited !== undefined) return
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  const yielded = new Promise<void>((resolve, reject) => {
    timer = setTimeout(resolve, yieldTimeMs)
    if (signal !== undefined) {
      onAbort = () => reject(abortError())
      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
  try {
    await Promise.race([entry.exit.then(() => undefined), yielded])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort)
    }
  }
}

function observe(
  entry: ProcessEntry,
  wallTimeMs: number,
  maxOutputTokens: number,
  entries: Map<number, ProcessEntry>,
): UnifiedExecOutput {
  const captured = entry.output.drain(
    Math.min(MAX_OUTPUT_BYTES, maxOutputTokens * 4),
  )
  const exit = entry.exited
  if (exit !== undefined) {
    entries.delete(entry.id)
    clearTimeout(entry.timeout)
  }
  return {
    chunk_id: globalThis.crypto.randomUUID().slice(0, 6),
    wall_time_seconds: wallTimeMs / 1_000,
    output: captured.text,
    original_token_count: Math.ceil(captured.originalBytes / 4),
    ...(exit === undefined
      ? { session_id: entry.id }
      : { exit_code: exit.exitCode }),
  }
}

class IntervalOutputBuffer {
  readonly #headLimit: number
  readonly #tailLimit: number
  #head = Buffer.alloc(0)
  #tail = Buffer.alloc(0)
  #totalBytes = 0

  constructor(maxBytes: number) {
    this.#headLimit = Math.floor(maxBytes * OUTPUT_HEAD_RATIO)
    this.#tailLimit = maxBytes - this.#headLimit
  }

  append(value: Buffer | string): void {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
    this.#totalBytes += bytes.byteLength
    let remaining = bytes
    if (this.#head.byteLength < this.#headLimit) {
      const take = Math.min(
        remaining.byteLength,
        this.#headLimit - this.#head.byteLength,
      )
      this.#head = Buffer.concat([this.#head, remaining.subarray(0, take)])
      remaining = remaining.subarray(take)
    }
    if (remaining.byteLength > 0) {
      this.#tail = Buffer.concat([this.#tail, remaining])
      if (this.#tail.byteLength > this.#tailLimit) {
        this.#tail = this.#tail.subarray(
          this.#tail.byteLength - this.#tailLimit,
        )
      }
    }
  }

  drain(maxBytes: number): {
    readonly text: string
    readonly originalBytes: number
  } {
    const originalBytes = this.#totalBytes
    let retained = Buffer.concat([this.#head, this.#tail])
    const omittedByStorage = Math.max(0, originalBytes - retained.byteLength)
    if (retained.byteLength > maxBytes) {
      const headBytes = Math.floor(maxBytes * OUTPUT_HEAD_RATIO)
      const tailBytes = maxBytes - headBytes
      retained = Buffer.concat([
        retained.subarray(0, headBytes),
        retained.subarray(retained.byteLength - tailBytes),
      ])
    }
    const omitted = Math.max(
      omittedByStorage,
      originalBytes - retained.byteLength,
    )
    const text =
      omitted === 0
        ? retained.toString("utf8")
        : `${retained.subarray(0, Math.floor(retained.byteLength * OUTPUT_HEAD_RATIO)).toString("utf8")}\n... ${omitted} bytes omitted ...\n${retained.subarray(Math.floor(retained.byteLength * OUTPUT_HEAD_RATIO)).toString("utf8")}`
    this.#head = Buffer.alloc(0)
    this.#tail = Buffer.alloc(0)
    this.#totalBytes = 0
    return { text, originalBytes }
  }
}

function parseExecInput(
  input: unknown,
  maxCommandBytes: number,
):
  | { readonly ok: true; readonly value: ExecInput }
  | { readonly ok: false; readonly result: ToolExecutionResult } {
  if (!isRecord(input)) return invalid("exec_command input must be an object.")
  if (typeof input.cmd !== "string" || input.cmd.trim().length === 0) {
    return invalid("exec_command cmd must be a non-empty string.")
  }
  if (Buffer.byteLength(input.cmd, "utf8") > maxCommandBytes) {
    return invalid(
      `exec_command cmd exceeds ${maxCommandBytes} bytes.`,
      "command_too_large",
    )
  }
  if (input.workdir !== undefined && typeof input.workdir !== "string") {
    return invalid("exec_command workdir must be a string.")
  }
  if (input.tty !== undefined && typeof input.tty !== "boolean") {
    return invalid("exec_command tty must be a boolean.")
  }
  const yieldTimeMs = integerField(
    input["yield-time_ms"],
    DEFAULT_EXEC_YIELD_MS,
    MIN_YIELD_MS,
    MAX_YIELD_MS,
  )
  if (!yieldTimeMs.ok) return invalid(`exec_command ${yieldTimeMs.message}`)
  const maxOutputTokens = positiveIntegerField(
    input.max_output_tokens,
    DEFAULT_MAX_OUTPUT_TOKENS,
  )
  if (!maxOutputTokens.ok)
    return invalid(`exec_command ${maxOutputTokens.message}`)
  const unknown = Object.keys(input).filter(
    (name) =>
      !["cmd", "workdir", "tty", "yield-time_ms", "max_output_tokens"].includes(
        name,
      ),
  )
  if (unknown.length > 0) {
    return invalid(`exec_command does not accept: ${unknown.join(", ")}.`)
  }
  return {
    ok: true,
    value: {
      cmd: input.cmd,
      tty: input.tty ?? false,
      yieldTimeMs: yieldTimeMs.value,
      maxOutputTokens: maxOutputTokens.value,
      ...(input.workdir === undefined ? {} : { workdir: input.workdir }),
    },
  }
}

function parseWriteInput(
  input: unknown,
):
  | { readonly ok: true; readonly value: WriteInput }
  | { readonly ok: false; readonly result: ToolExecutionResult } {
  if (!isRecord(input)) return invalid("write_stdin input must be an object.")
  if (
    !Number.isInteger(input.session_id) ||
    (input.session_id as number) <= 0
  ) {
    return invalid("write_stdin session_id must be a positive integer.")
  }
  if (input.chars !== undefined && typeof input.chars !== "string") {
    return invalid("write_stdin chars must be a string.")
  }
  const chars = input.chars ?? ""
  const yieldTimeMs = integerField(
    input["yield-time_ms"],
    chars.length === 0 ? DEFAULT_EMPTY_POLL_MS : MIN_YIELD_MS,
    MIN_YIELD_MS,
    MAX_EMPTY_POLL_MS,
  )
  if (!yieldTimeMs.ok) return invalid(`write_stdin ${yieldTimeMs.message}`)
  const maxOutputTokens = positiveIntegerField(
    input.max_output_tokens,
    DEFAULT_MAX_OUTPUT_TOKENS,
  )
  if (!maxOutputTokens.ok)
    return invalid(`write_stdin ${maxOutputTokens.message}`)
  const unknown = Object.keys(input).filter(
    (name) =>
      !["session_id", "chars", "yield-time_ms", "max_output_tokens"].includes(
        name,
      ),
  )
  if (unknown.length > 0) {
    return invalid(`write_stdin does not accept: ${unknown.join(", ")}.`)
  }
  return {
    ok: true,
    value: {
      sessionId: input.session_id as number,
      chars,
      yieldTimeMs: yieldTimeMs.value,
      maxOutputTokens: maxOutputTokens.value,
    },
  }
}

function integerField(
  value: unknown,
  defaultValue: number,
  minimum: number,
  maximum: number,
):
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly message: string } {
  const resolved = value ?? defaultValue
  return typeof resolved === "number" &&
    Number.isInteger(resolved) &&
    resolved >= minimum &&
    resolved <= maximum
    ? { ok: true, value: resolved }
    : {
        ok: false,
        message: `yield-time-ms must be an integer from ${minimum} to ${maximum}.`,
      }
}

function positiveIntegerField(
  value: unknown,
  defaultValue: number,
):
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly message: string } {
  const resolved = value ?? defaultValue
  return typeof resolved === "number" &&
    Number.isInteger(resolved) &&
    resolved > 0
    ? { ok: true, value: resolved }
    : {
        ok: false,
        message: "max_output_tokens must be a positive integer.",
      }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalid(
  message: string,
  code = "invalid_tool_input",
): { readonly ok: false; readonly result: ToolExecutionResult } {
  return { ok: false, result: failure(code, message) }
}

function success(output: UnifiedExecOutput): ToolExecutionResult {
  return { ok: true, output, content: JSON.stringify(output) }
}

function failure(
  code: string,
  message: string,
  output?: JsonValue,
): ToolExecutionResult {
  return {
    ok: false,
    code,
    message,
    content: message,
    ...(output === undefined ? {} : { output }),
  }
}

function abortedBeforeStart(): ToolExecutionResult {
  return failure(
    "aborted",
    "Command aborted before start. No process was started.",
  )
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError")
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function shellArguments(shell: string, command: string): string[] {
  const name = basename(shell).toLowerCase()
  if (name === "cmd" || name === "cmd.exe") return ["/d", "/s", "/c", command]
  if (name === "powershell" || name === "powershell.exe" || name === "pwsh") {
    return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
  }
  return ["-c", command]
}

function definedEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

function firstCommandToken(command: string): string {
  return command.trimStart().split(/\s+/u, 1)[0]?.slice(0, 80) ?? ""
}
