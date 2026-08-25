import { spawn, type ChildProcess } from "node:child_process"
import { createWriteStream } from "node:fs"
import { basename } from "node:path"
import { Transform } from "node:stream"
import { ToolLimitDefaults } from "../limits.ts"
import { createUserShellEnv, type UserShellEnv } from "../user-shell-env.ts"
import { commandApprovalRequirement } from "./approval-requirements.ts"
import { matchCatastrophicCommand } from "./command-fuse.ts"
import {
  commandExecution,
  completeCommandExecution,
} from "./execution-descriptors.ts"
import { resolveCommandCwd } from "./path-policy.ts"
import type { RuntimeTool, ToolExecutionResult } from "./types.ts"

const DESCRIPTION_MAX_CHARACTERS = 200
const BINARY_SNIFF_BYTES = 8 * 1024
const BINARY_PREVIEW_BYTES = 1_900

export type RunCommandLauncher = (input: {
  readonly command: string
  readonly cwd: string
  readonly shell: string
  readonly env: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly maxPersistedOutputBytes: number
  readonly killGraceMs: number
  readonly outputFiles?: { readonly stdout: string; readonly stderr: string }
}) => Promise<CommandLaunchResult>

export type CommandLaunchResult = {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly timedOut: boolean
  readonly aborted?: boolean
  readonly durationMs?: number
  readonly spawnError?: string
  readonly stdoutBytes?: number
  readonly stderrBytes?: number
  readonly persisted?: { readonly stdout: boolean; readonly stderr: boolean }
  readonly persistenceTruncated?: {
    readonly stdout: boolean
    readonly stderr: boolean
  }
  readonly binary?: {
    readonly stdout: boolean
    readonly stderr: boolean
    readonly stdoutBytes: number
    readonly stderrBytes: number
  }
}

export type RunCommandOutput = {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly timedOut: boolean
  readonly durationMs: number
  readonly cwd: string
  readonly shell: string
  readonly warnings?: readonly string[]
  readonly totalBytes: { readonly stdout: number; readonly stderr: number }
  readonly files?: {
    readonly stdout?: string
    readonly stderr?: string
  }
  readonly filesTruncated?: {
    readonly stdout: boolean
    readonly stderr: boolean
  }
  readonly blocked?: { readonly rule: string }
  readonly binary?: {
    readonly stdout: boolean
    readonly stderr: boolean
    readonly stdoutBytes: number
    readonly stderrBytes: number
  }
}

export function createRunCommandTool(
  input: {
    readonly maxCommandBytes?: number
    readonly maxOutputBytes?: number
    readonly maxPersistedOutputBytes?: number
    readonly defaultTimeoutSeconds?: number
    readonly maxTimeoutSeconds?: number
    readonly killGraceMs?: number
    readonly launch?: RunCommandLauncher
    readonly userShellEnv?: UserShellEnv
    readonly log?: (message: string) => void
  } = {},
): RuntimeTool {
  const maxCommandBytes =
    input.maxCommandBytes ?? ToolLimitDefaults.commandTextBytes
  const maxOutputBytes =
    input.maxOutputBytes ?? ToolLimitDefaults.commandOutputBytes
  const maxPersistedOutputBytes =
    input.maxPersistedOutputBytes ??
    ToolLimitDefaults.commandPersistedOutputBytes
  const defaultTimeoutSeconds =
    input.defaultTimeoutSeconds ??
    ToolLimitDefaults.runCommandDefaultTimeoutSeconds
  const maxTimeoutSeconds =
    input.maxTimeoutSeconds ?? ToolLimitDefaults.runCommandMaxTimeoutSeconds
  const killGraceMs = input.killGraceMs ?? ToolLimitDefaults.commandKillGraceMs
  const launch = input.launch ?? launchCommand
  const userShellEnv =
    input.userShellEnv ?? createUserShellEnv({ log: () => {} })
  const log = input.log ?? (() => {})

  return {
    name: "run_command",
    description: `Run one non-interactive shell command, optionally from an in-workspace cwd. Use it for git, package managers, builds, and tests; prefer glob, grep, read_file, edit_file, and write_file for file work. It runs immediately with the host user's full files, process, and network authority and is not sandboxed. A small, bypassable fuse blocks only obvious catastrophic commands. Use timeoutSeconds for long work; there are no timeout/workdir aliases and no interactive stdin. Up to ${maxPersistedOutputBytes} bytes from each stdout/stderr stream are retained as files when Session storage is available; use read_file on a returned absolute path after preview truncation.`,
    async approvalRequirement(rawInput, context) {
      const parsed = parseRunCommandInput(rawInput, {
        maxCommandBytes,
        defaultTimeoutSeconds,
        maxTimeoutSeconds,
      })
      if (
        !parsed.ok ||
        matchCatastrophicCommand(parsed.command) !== undefined
      ) {
        return { kind: "none" }
      }
      const cwd = await resolveCommandCwd(context.workspaceRoot, parsed.cwd)
      return cwd.ok
        ? commandApprovalRequirement({
            command: parsed.command,
            cwd: cwd.absolutePath,
          })
        : { kind: "none" }
    },
    effect: "opaque",
    describeExecution: commandExecution,
    completeExecution: completeCommandExecution,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: {
          type: "string",
          description:
            "The shell command to execute. Pipelines, command lists, and heredocs are supported.",
        },
        cwd: {
          type: "string",
          description:
            "Optional workspace-relative directory or absolute directory inside the workspace. Applies only to this call.",
        },
        timeoutSeconds: {
          type: "integer",
          minimum: 1,
          maximum: maxTimeoutSeconds,
          description: `Timeout in seconds. Defaults to ${defaultTimeoutSeconds}; maximum ${maxTimeoutSeconds}.`,
        },
        description: {
          type: "string",
          maxLength: DESCRIPTION_MAX_CHARACTERS,
          description:
            "Optional one-line summary shown in the collapsed terminal row. It is display text and is not executed.",
        },
      },
      required: ["command"],
    },
    async execute(rawInput, context): Promise<ToolExecutionResult> {
      const parsed = parseRunCommandInput(rawInput, {
        maxCommandBytes,
        defaultTimeoutSeconds,
        maxTimeoutSeconds,
      })
      if (!parsed.ok) return parsed.result

      if (context.signal?.aborted) return abortedBeforeStart()
      const cwd = await resolveCommandCwd(context.workspaceRoot, parsed.cwd)
      if (!cwd.ok) return invalid(cwd.error.message, "invalid_cwd").result
      if (context.signal?.aborted) return abortedBeforeStart()

      const commandEnvironment = await userShellEnv.commandEnvironment(
        cwd.absolutePath,
      )
      const baseOutput = {
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
        durationMs: 0,
        cwd: cwd.absolutePath,
        shell: commandEnvironment.shell,
        totalBytes: { stdout: 0, stderr: 0 },
        ...(commandEnvironment.warnings.length === 0
          ? {}
          : { warnings: [...commandEnvironment.warnings] }),
      }
      const blocked = matchCatastrophicCommand(parsed.command)
      if (blocked !== undefined) {
        const output: RunCommandOutput = { ...baseOutput, blocked }
        const message = `Command blocked by catastrophic-command fuse (${blocked.rule}). No process was started. Narrow the command; this fuse is not a sandbox.`
        return {
          ok: false,
          code: "command_blocked",
          message,
          content: message,
          output,
        }
      }
      if (context.signal?.aborted) return abortedBeforeStart()

      log(
        `run_command start token=${firstCommandToken(parsed.command)} bytes=${Buffer.byteLength(parsed.command, "utf8")}`,
      )
      const startedAt = Date.now()
      let commandFiles:
        | Awaited<
            ReturnType<
              NonNullable<typeof context.sessionFiles>["prepareCommandFiles"]
            >
          >
        | undefined
      const persistenceWarnings: string[] = []
      if (
        context.sessionFiles !== undefined &&
        context.sessionId !== undefined &&
        context.toolCallId !== undefined
      ) {
        try {
          commandFiles = await context.sessionFiles.prepareCommandFiles(
            context.sessionId,
            context.toolCallId,
          )
        } catch (error) {
          persistenceWarnings.push(
            `Complete command output could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      const result = await launch({
        command: parsed.command,
        cwd: cwd.absolutePath,
        shell: commandEnvironment.shell,
        env: commandEnvironment.env,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        timeoutMs: parsed.timeoutSeconds * 1_000,
        maxOutputBytes,
        maxPersistedOutputBytes,
        killGraceMs,
        ...(commandFiles === undefined
          ? {}
          : {
              outputFiles: {
                stdout: commandFiles.stdout.path,
                stderr: commandFiles.stderr.path,
              },
            }),
      })
      const files =
        commandFiles === undefined || result.persisted === undefined
          ? undefined
          : {
              ...(result.persisted.stdout
                ? { stdout: commandFiles.stdout.path }
                : {}),
              ...(result.persisted.stderr
                ? { stderr: commandFiles.stderr.path }
                : {}),
            }
      if (commandFiles !== undefined && result.persisted?.stdout === false) {
        persistenceWarnings.push("Complete stdout could not be persisted.")
      }
      if (commandFiles !== undefined && result.persisted?.stderr === false) {
        persistenceWarnings.push("Complete stderr could not be persisted.")
      }
      if (result.persistenceTruncated?.stdout === true) {
        persistenceWarnings.push(
          `Session stdout reached its ${maxPersistedOutputBytes}-byte limit and is incomplete.`,
        )
      }
      if (result.persistenceTruncated?.stderr === true) {
        persistenceWarnings.push(
          `Session stderr reached its ${maxPersistedOutputBytes}-byte limit and is incomplete.`,
        )
      }
      const warnings = [...commandEnvironment.warnings, ...persistenceWarnings]
      const output: RunCommandOutput = {
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        timedOut: result.timedOut,
        durationMs: result.durationMs ?? Date.now() - startedAt,
        cwd: cwd.absolutePath,
        shell: commandEnvironment.shell,
        totalBytes: {
          stdout: result.stdoutBytes ?? Buffer.byteLength(result.stdout),
          stderr: result.stderrBytes ?? Buffer.byteLength(result.stderr),
        },
        ...(warnings.length === 0 ? {} : { warnings }),
        ...(files === undefined || Object.keys(files).length === 0
          ? {}
          : { files }),
        ...(result.persistenceTruncated === undefined
          ? {}
          : { filesTruncated: result.persistenceTruncated }),
        ...(result.binary === undefined ? {} : { binary: result.binary }),
      }

      if (result.aborted === true || context.signal?.aborted) {
        const message = "Command aborted. Partial output is preserved."
        return {
          ok: false,
          code: "aborted",
          message,
          content: boundCommandContent(renderCommandContent(output, message)),
          output,
        }
      }
      if (result.spawnError !== undefined) {
        return {
          ok: false,
          code: "spawn_error",
          message: result.spawnError,
          content: boundCommandContent(
            renderCommandContent(
              output,
              `Command failed to start: ${result.spawnError}`,
            ),
          ),
          output,
        }
      }
      if (result.timedOut) {
        const message = `Command timed out after ${parsed.timeoutSeconds}s.`
        return {
          ok: false,
          code: "command_timeout",
          message,
          content: boundCommandContent(
            renderCommandContent(
              output,
              `${message} Raise timeoutSeconds or change the command; do not retry it unchanged.`,
            ),
          ),
          output,
        }
      }

      return {
        ok: true,
        output,
        content: boundCommandContent(renderCommandContent(output)),
      }
    },
  }
}

export function boundCommandContent(
  text: string,
  limits: {
    readonly maxBytes?: number
    readonly maxLines?: number
  } = {},
): string {
  const maxBytes = limits.maxBytes ?? ToolLimitDefaults.toolPreviewBytes
  const maxLines = limits.maxLines ?? ToolLimitDefaults.toolPreviewLines
  const totalBytes = Buffer.byteLength(text, "utf8")
  const totalLines = countLines(text)
  if (totalBytes <= maxBytes && totalLines <= maxLines) return text

  const markerReserve = Buffer.byteLength(
    truncationMarker(totalBytes, totalBytes, totalBytes, totalLines),
    "utf8",
  )
  const payloadBytes = Math.max(0, maxBytes - markerReserve - 2)
  const payloadLines = Math.max(0, maxLines - 1)
  const headByteLimit = Math.floor(payloadBytes * 0.3)
  const tailByteLimit = payloadBytes - headByteLimit
  const headLineLimit = Math.floor(payloadLines * 0.3)
  const tailLineLimit = payloadLines - headLineLimit

  const head = takeHead(text, headByteLimit, headLineLimit).replace(/\n$/, "")
  const tail = takeTail(text, tailByteLimit, tailLineLimit).replace(/^\n/, "")
  const headBytes = Buffer.byteLength(head, "utf8")
  const tailBytes = Buffer.byteLength(tail, "utf8")
  const omittedLines = Math.max(
    0,
    totalLines - countLines(head) - countLines(tail),
  )
  const marker = truncationMarker(
    headBytes,
    tailBytes,
    totalBytes,
    omittedLines,
  )
  return [head, marker, tail].filter((part) => part.length > 0).join("\n")
}

function renderCommandContent(
  output: RunCommandOutput,
  status?: string,
): string {
  const binaryStdout = output.binary?.stdout === true
  const binaryStderr = output.binary?.stderr === true
  const stdout = binaryStdout
    ? "(binary stdout omitted)"
    : output.stdout.length === 0
      ? "(no stdout)"
      : output.stdout
  const sections = [stdout]
  if (!binaryStderr && output.stderr.length > 0) {
    sections.push(`[stderr]\n${output.stderr}`)
  }
  if (status !== undefined) sections.push(status)
  if (output.warnings !== undefined) {
    sections.push(`[warning]\n${output.warnings.join("\n")}`)
  }
  if (output.files !== undefined) {
    const paths = [
      ...(output.files.stdout === undefined
        ? []
        : [`Full stdout: ${output.files.stdout}`]),
      ...(output.files.stderr === undefined
        ? []
        : [`Full stderr: ${output.files.stderr}`]),
    ]
    if (paths.length > 0) {
      sections.push(
        `Session output retained; use read_file with an absolute path below:\n${paths.join("\n")}`,
      )
    }
  }
  sections.push(
    `(${[
      ...(output.exitCode === null ? [] : [`exit ${String(output.exitCode)}`]),
      formatDuration(output.durationMs),
      ...(output.signal === null ? [] : [`signal ${output.signal}`]),
      ...(output.timedOut ? ["timed out"] : []),
      ...(output.truncated ? ["capture truncated"] : []),
      ...(binaryStdout ? ["binary stdout"] : []),
      ...(binaryStderr ? ["binary stderr"] : []),
    ].join(", ")})`,
  )
  return sections.join("\n")
}

function parseRunCommandInput(
  input: unknown,
  limits: {
    readonly maxCommandBytes: number
    readonly defaultTimeoutSeconds: number
    readonly maxTimeoutSeconds: number
  },
):
  | {
      readonly ok: true
      readonly command: string
      readonly cwd?: string
      readonly timeoutSeconds: number
      readonly description?: string
    }
  | { readonly ok: false; readonly result: ToolExecutionResult } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return invalid("run_command input must be an object.")
  }
  const record = input as Record<string, unknown>
  if (
    typeof record.command !== "string" ||
    record.command.trim().length === 0
  ) {
    return invalid("run_command command must be a non-empty string.")
  }
  if (Buffer.byteLength(record.command, "utf8") > limits.maxCommandBytes) {
    return invalid(
      `run_command command exceeds ${limits.maxCommandBytes} bytes.`,
      "command_too_large",
    )
  }
  if (record.cwd !== undefined && typeof record.cwd !== "string") {
    return invalid("run_command cwd must be a string.")
  }
  if (record.description !== undefined) {
    if (
      typeof record.description !== "string" ||
      [...record.description].length > DESCRIPTION_MAX_CHARACTERS ||
      /[\r\n]/.test(record.description)
    ) {
      return invalid(
        `run_command description must be one line of at most ${DESCRIPTION_MAX_CHARACTERS} characters.`,
      )
    }
  }
  const unknown = Object.keys(record).filter(
    (name) =>
      name !== "command" &&
      name !== "cwd" &&
      name !== "timeoutSeconds" &&
      name !== "description",
  )
  if (unknown.length > 0) {
    return invalid(`run_command does not accept: ${unknown.join(", ")}.`)
  }
  let timeoutSeconds = limits.defaultTimeoutSeconds
  if (record.timeoutSeconds !== undefined) {
    if (
      typeof record.timeoutSeconds !== "number" ||
      !Number.isInteger(record.timeoutSeconds) ||
      record.timeoutSeconds < 1 ||
      record.timeoutSeconds > limits.maxTimeoutSeconds
    ) {
      return invalid(
        `run_command timeoutSeconds must be an integer from 1 to ${limits.maxTimeoutSeconds}.`,
      )
    }
    timeoutSeconds = record.timeoutSeconds
  }
  return {
    ok: true,
    command: record.command,
    timeoutSeconds,
    ...(record.cwd === undefined ? {} : { cwd: record.cwd as string }),
    ...(record.description === undefined
      ? {}
      : { description: record.description as string }),
  }
}

function invalid(
  message: string,
  code = "invalid_tool_input",
): { readonly ok: false; readonly result: ToolExecutionResult } {
  return {
    ok: false,
    result: { ok: false, code, message, content: message },
  }
}

function abortedBeforeStart(): ToolExecutionResult {
  const message = "Command aborted before start. No process was started."
  return { ok: false, code: "aborted", message, content: message }
}

async function launchCommand(input: {
  readonly command: string
  readonly cwd: string
  readonly shell: string
  readonly env: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly maxPersistedOutputBytes: number
  readonly killGraceMs: number
  readonly outputFiles?: { readonly stdout: string; readonly stderr: string }
}): Promise<CommandLaunchResult> {
  const startedAt = Date.now()
  if (input.signal?.aborted)
    return emptyLaunchResult(startedAt, { aborted: true })

  let child: ChildProcess
  try {
    child =
      process.platform === "win32"
        ? spawn(input.command, {
            cwd: input.cwd,
            shell: input.shell,
            env: input.env,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          })
        : spawn(
            input.shell,
            commandShellArguments(input.shell, input.command),
            {
              cwd: input.cwd,
              detached: true,
              env: input.env,
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
            },
          )
  } catch (error) {
    return emptyLaunchResult(startedAt, {
      spawnError:
        error instanceof Error ? error.message : "Failed to spawn command.",
    })
  }

  const stdout = createCaptureState()
  const stderr = createCaptureState()
  let captured = 0
  let truncated = false
  let timeoutFired = false
  let abortFired = false

  const capture = (
    stream: NodeJS.ReadableStream | null,
    target: CaptureState,
  ) => {
    if (stream === null) return
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const sniffRemaining = Math.max(0, BINARY_SNIFF_BYTES - target.bytes)
      if (
        sniffRemaining > 0 &&
        buffer.subarray(0, sniffRemaining).includes(0)
      ) {
        target.binary = true
      }
      target.bytes += buffer.byteLength
      if (captured >= input.maxOutputBytes) {
        truncated = true
        return
      }
      const remaining = input.maxOutputBytes - captured
      const kept =
        buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer
      target.chunks.push(kept)
      captured += kept.byteLength
      if (kept.byteLength < buffer.byteLength) truncated = true
    })
  }
  capture(child.stdout, stdout)
  capture(child.stderr, stderr)
  const persisted = awaitCommandPersistence(
    child,
    input.outputFiles,
    input.maxPersistedOutputBytes,
  )

  type ExitObservation = {
    readonly exitCode: number | null
    readonly signal: string | null
    readonly spawnError?: string
  }
  let hardCompletion: NodeJS.Timeout | undefined
  let settled = false
  let settleExit: (value: ExitObservation) => void = () => {}
  const exitPromise = new Promise<ExitObservation>((resolve) => {
    settleExit = (value) => {
      if (settled) return
      settled = true
      if (hardCompletion !== undefined) clearTimeout(hardCompletion)
      resolve(value)
    }
    child.once("error", (error) => {
      settleExit({ exitCode: null, signal: null, spawnError: error.message })
    })
    child.once("close", (exitCode, signal) => settleExit({ exitCode, signal }))
  })
  const forceCompletion = () => {
    truncated = true
    settleExit({
      exitCode: child.exitCode,
      signal: child.signalCode,
    })
    child.stdout?.destroy()
    child.stderr?.destroy()
  }
  const stopCommand = () => {
    terminate(child, input.killGraceMs)
    hardCompletion ??= setTimeout(forceCompletion, input.killGraceMs + 25)
    hardCompletion.unref()
  }
  const timeout = setTimeout(() => {
    timeoutFired = true
    stopCommand()
  }, input.timeoutMs)
  const onAbort = () => {
    abortFired = true
    stopCommand()
  }
  input.signal?.addEventListener("abort", onAbort, { once: true })

  try {
    const exit = await exitPromise
    const persistence = await persisted
    const aborted = abortFired || input.signal?.aborted === true
    return {
      exitCode: exit.exitCode,
      signal: exit.signal,
      stdout: capturedText("stdout", stdout),
      stderr: capturedText("stderr", stderr),
      truncated,
      timedOut: timeoutFired && !aborted,
      aborted,
      durationMs: Date.now() - startedAt,
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
      ...(persistence === undefined
        ? {}
        : {
            persisted: {
              stdout: persistence.stdout.ok,
              stderr: persistence.stderr.ok,
            },
            persistenceTruncated: {
              stdout: persistence.stdout.truncated,
              stderr: persistence.stderr.truncated,
            },
          }),
      ...(exit.spawnError === undefined ? {} : { spawnError: exit.spawnError }),
      ...(stdout.binary || stderr.binary
        ? {
            binary: {
              stdout: stdout.binary,
              stderr: stderr.binary,
              stdoutBytes: stdout.bytes,
              stderrBytes: stderr.bytes,
            },
          }
        : {}),
    }
  } finally {
    clearTimeout(timeout)
    if (hardCompletion !== undefined) clearTimeout(hardCompletion)
    input.signal?.removeEventListener("abort", onAbort)
  }
}

async function awaitCommandPersistence(
  child: ChildProcess,
  files: { readonly stdout: string; readonly stderr: string } | undefined,
  maxBytes: number,
): Promise<
  | {
      readonly stdout: PersistedStreamResult
      readonly stderr: PersistedStreamResult
    }
  | undefined
> {
  if (files === undefined) return undefined
  const [stdout, stderr] = await Promise.all([
    persistStream(child.stdout, files.stdout, maxBytes),
    persistStream(child.stderr, files.stderr, maxBytes),
  ])
  return { stdout, stderr }
}

function persistStream(
  stream: NodeJS.ReadableStream | null,
  path: string,
  maxBytes: number,
): Promise<PersistedStreamResult> {
  if (stream === null) return Promise.resolve({ ok: true, truncated: false })
  let writtenBytes = 0
  let truncated = false
  const limiter = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const remaining = Math.max(0, maxBytes - writtenBytes)
      const retained = bytes.subarray(0, remaining)
      if (retained.byteLength > 0) this.push(retained)
      writtenBytes += retained.byteLength
      if (retained.byteLength < bytes.byteLength) truncated = true
      callback()
    },
  })
  const file = createWriteStream(path, { flags: "a", mode: 0o600, flush: true })
  stream.pipe(limiter).pipe(file)
  return new Promise((resolve) => {
    file.once("finish", () => resolve({ ok: true, truncated }))
    file.once("error", () => {
      stream.unpipe(limiter)
      limiter.destroy()
      resolve({ ok: false, truncated })
    })
    stream.once("close", () => {
      if (!limiter.destroyed && !limiter.writableEnded) limiter.end()
    })
  })
}

type PersistedStreamResult = {
  readonly ok: boolean
  readonly truncated: boolean
}

type CaptureState = {
  readonly chunks: Buffer[]
  bytes: number
  binary: boolean
}

function createCaptureState(): CaptureState {
  return { chunks: [], bytes: 0, binary: false }
}

function capturedText(
  stream: "stdout" | "stderr",
  state: CaptureState,
): string {
  const captured = Buffer.concat(state.chunks)
  if (!state.binary) return captured.toString("utf8")
  const preview = captured.subarray(0, BINARY_PREVIEW_BYTES).toString("hex")
  return `[binary ${stream}: ${state.bytes} bytes; hexadecimal preview]\n${preview}`
}

function emptyLaunchResult(
  startedAt: number,
  detail: { readonly aborted?: boolean; readonly spawnError?: string },
): CommandLaunchResult {
  return {
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    timedOut: false,
    durationMs: Date.now() - startedAt,
    ...(detail.aborted === undefined ? {} : { aborted: detail.aborted }),
    ...(detail.spawnError === undefined
      ? {}
      : { spawnError: detail.spawnError }),
  }
}

function terminate(child: ChildProcess, killGraceMs: number): void {
  if (process.platform === "win32" && hasExited(child)) return
  signalCommand(child, "SIGTERM")
  setTimeout(() => signalCommand(child, "SIGKILL"), killGraceMs).unref()
}

function signalCommand(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal)
      return
    }
    child.kill(signal)
  } catch {
    // The process or process group already exited.
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function truncationMarker(
  headBytes: number,
  tailBytes: number,
  totalBytes: number,
  omittedLines: number,
): string {
  return `...[truncated: showing first ${headBytes} + last ${tailBytes} of ${totalBytes} captured bytes; ${omittedLines} lines omitted. Use read_file on the returned stdout/stderr path for complete output when available, or rerun with a narrower command.]...`
}

function takeHead(text: string, maxBytes: number, maxLines: number): string {
  if (maxBytes <= 0 || maxLines <= 0) return ""
  const buffer = Buffer.from(text)
  let end = Math.min(buffer.byteLength, maxBytes)
  while (end > 0 && isUtf8Continuation(buffer[end])) end -= 1
  return buffer
    .subarray(0, end)
    .toString("utf8")
    .split("\n")
    .slice(0, maxLines)
    .join("\n")
}

function takeTail(text: string, maxBytes: number, maxLines: number): string {
  if (maxBytes <= 0 || maxLines <= 0) return ""
  const buffer = Buffer.from(text)
  let start = Math.max(0, buffer.byteLength - maxBytes)
  while (start < buffer.byteLength && isUtf8Continuation(buffer[start]))
    start += 1
  return buffer
    .subarray(start)
    .toString("utf8")
    .split("\n")
    .slice(-maxLines)
    .join("\n")
}

function isUtf8Continuation(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80
}

function countLines(text: string): number {
  if (text.length === 0) return 0
  return text.split("\n").length
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`
  return `${(durationMs / 1_000).toFixed(1)}s`
}

function firstCommandToken(command: string): string {
  const token = command.trim().match(/^[A-Za-z0-9_./-]+/)?.[0]
  return token === undefined ? "(complex)" : token.slice(0, 80)
}

function commandShellArguments(shell: string, command: string): string[] {
  const name = basename(shell)
  if (name === "zsh") return ["-f", "-c", command]
  if (name === "bash") return ["--noprofile", "--norc", "-c", command]
  return ["-c", command]
}
