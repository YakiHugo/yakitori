import { spawn, type ChildProcess } from "node:child_process"
import { basename } from "node:path"
import { RuntimeLimits } from "../limits.ts"
import { createUserShellEnv, type UserShellEnv } from "../user-shell-env.ts"
import { matchCatastrophicCommand } from "./command-fuse.ts"
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
  readonly killGraceMs: number
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
    readonly defaultTimeoutSeconds?: number
    readonly maxTimeoutSeconds?: number
    readonly killGraceMs?: number
    readonly launch?: RunCommandLauncher
    readonly userShellEnv?: UserShellEnv
    readonly log?: (message: string) => void
  } = {},
): RuntimeTool {
  const maxCommandBytes =
    input.maxCommandBytes ?? RuntimeLimits.commandTextBytes
  const maxOutputBytes =
    input.maxOutputBytes ?? RuntimeLimits.commandOutputBytes
  const defaultTimeoutSeconds =
    input.defaultTimeoutSeconds ?? RuntimeLimits.runCommandDefaultTimeoutSeconds
  const maxTimeoutSeconds =
    input.maxTimeoutSeconds ?? RuntimeLimits.runCommandMaxTimeoutSeconds
  const killGraceMs = input.killGraceMs ?? RuntimeLimits.commandKillGraceMs
  const launch = input.launch ?? launchCommand
  const userShellEnv =
    input.userShellEnv ?? createUserShellEnv({ log: () => {} })
  const log = input.log ?? (() => {})

  return {
    name: "run_command",
    description:
      "Run one non-interactive shell command, optionally from an in-workspace cwd. Use it for git, package managers, builds, and tests; prefer glob, grep, read_file, edit_file, and write_file for file work. It runs immediately with the host user's full files, process, and network authority and is not sandboxed. A small, bypassable fuse blocks only obvious catastrophic commands. Use timeoutSeconds for long work; there are no timeout/workdir aliases and no interactive stdin. Redirect large output to a workspace file and use read_file.",
    autoAllow: true,
    effect: "opaque",
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
      const result = await launch({
        command: parsed.command,
        cwd: cwd.absolutePath,
        shell: commandEnvironment.shell,
        env: commandEnvironment.env,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        timeoutMs: parsed.timeoutSeconds * 1_000,
        maxOutputBytes,
        killGraceMs,
      })
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
        ...(commandEnvironment.warnings.length === 0
          ? {}
          : { warnings: [...commandEnvironment.warnings] }),
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
  const maxBytes = limits.maxBytes ?? RuntimeLimits.modelVisibleToolResultBytes
  const maxLines = limits.maxLines ?? RuntimeLimits.modelVisibleToolResultLines
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
  readonly killGraceMs: number
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
  return `...[truncated: showing first ${headBytes} + last ${tailBytes} of ${totalBytes} bytes; ${omittedLines} lines omitted. Full captured output is not available in model context; bytes beyond the capture cap are not retained. Redirect to a workspace file (\`cmd > out.log 2>&1\`) and use read_file, or rerun with a narrower command.]...`
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
