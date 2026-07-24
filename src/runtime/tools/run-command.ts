import { spawn, type ChildProcess } from "node:child_process"
import { RuntimeLimits } from "../limits.ts"
import type { RuntimeTool, ToolExecutionResult } from "./types.ts"

export type RunCommandLauncher = (input: {
  readonly command: string
  readonly cwd: string
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
  readonly spawnError?: string
}

export function createRunCommandTool(
  input: {
    readonly maxCommandBytes?: number
    readonly maxOutputBytes?: number
    readonly defaultTimeoutSeconds?: number
    readonly maxTimeoutSeconds?: number
    readonly killGraceMs?: number
    readonly launch?: RunCommandLauncher
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

  return {
    name: "run_command",
    description:
      "Run a shell command in the session workspace. Requires explicit user approval. The command runs with the host user's full authority.",
    autoAllow: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        timeoutSeconds: {
          type: "integer",
          minimum: 1,
          maximum: maxTimeoutSeconds,
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

      const result = await launch({
        command: parsed.command,
        cwd: context.workspaceRoot,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        timeoutMs: parsed.timeoutSeconds * 1_000,
        maxOutputBytes,
        killGraceMs,
      })

      if (result.spawnError !== undefined) {
        return {
          ok: false,
          code: "spawn_error",
          message: result.spawnError,
          content: result.spawnError,
        }
      }
      if (result.timedOut) {
        return {
          ok: false,
          code: "command_timeout",
          message: `Command timed out after ${parsed.timeoutSeconds}s.`,
          content: JSON.stringify({
            timedOut: true,
            stdout: result.stdout,
            stderr: result.stderr,
            truncated: result.truncated,
          }),
          output: {
            timedOut: true,
            stdout: result.stdout,
            stderr: result.stderr,
            truncated: result.truncated,
          },
        }
      }

      const output = {
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
      }
      return {
        ok: true,
        output,
        content: JSON.stringify(output),
      }
    },
  }
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
      readonly timeoutSeconds: number
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
  let timeoutSeconds = limits.defaultTimeoutSeconds
  if (record.timeoutSeconds !== undefined) {
    if (
      !(
        Number.isInteger(record.timeoutSeconds) &&
        typeof record.timeoutSeconds === "number" &&
        record.timeoutSeconds > 0 &&
        record.timeoutSeconds <= limits.maxTimeoutSeconds
      )
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
  }
}

function invalid(
  message: string,
  code = "invalid_tool_input",
): { readonly ok: false; readonly result: ToolExecutionResult } {
  return {
    ok: false,
    result: {
      ok: false,
      code,
      message,
      content: message,
    },
  }
}

async function launchCommand(input: {
  readonly command: string
  readonly cwd: string
  readonly signal?: AbortSignal
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly killGraceMs: number
}): Promise<CommandLaunchResult> {
  if (input.signal?.aborted) {
    return {
      exitCode: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
      spawnError: "Command aborted before start.",
    }
  }

  let child: ChildProcess
  try {
    child = spawn(input.command, {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (error) {
    return {
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
      spawnError:
        error instanceof Error ? error.message : "Failed to spawn command.",
    }
  }

  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  let captured = 0
  let truncated = false
  let timedOut = false

  const capture = (stream: NodeJS.ReadableStream | null, target: Buffer[]) => {
    if (!stream) return
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      // Always drain; only keep bytes under the capture cap.
      if (captured >= input.maxOutputBytes) {
        truncated = true
        return
      }
      const remaining = input.maxOutputBytes - captured
      if (buffer.byteLength > remaining) {
        target.push(buffer.subarray(0, remaining))
        captured += remaining
        truncated = true
        return
      }
      target.push(buffer)
      captured += buffer.byteLength
    })
  }

  capture(child.stdout, stdoutChunks)
  capture(child.stderr, stderrChunks)

  const timeout = setTimeout(() => {
    timedOut = true
    terminate(child, input.killGraceMs)
  }, input.timeoutMs)

  const onAbort = () => terminate(child, input.killGraceMs)
  input.signal?.addEventListener("abort", onAbort, { once: true })

  try {
    const exit = await new Promise<{
      exitCode: number | null
      signal: string | null
      spawnError?: string
    }>((resolve) => {
      child.once("error", (error) => {
        resolve({
          exitCode: null,
          signal: null,
          spawnError: error.message,
        })
      })
      child.once("close", (code, signal) => {
        resolve({
          exitCode: code,
          signal: signal,
        })
      })
    })

    return {
      exitCode: exit.exitCode,
      signal: exit.signal,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      truncated,
      timedOut,
      ...(exit.spawnError === undefined ? {} : { spawnError: exit.spawnError }),
    }
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener("abort", onAbort)
  }
}

function terminate(child: ChildProcess, killGraceMs: number): void {
  if (hasExited(child)) return
  signalCommand(child, "SIGTERM")
  setTimeout(() => {
    // A shell may exit after SIGTERM while one of its descendants ignores it.
    // Always signal the POSIX process group after the grace period.
    if (process.platform !== "win32" || !hasExited(child)) {
      signalCommand(child, "SIGKILL")
    }
  }, killGraceMs).unref()
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
