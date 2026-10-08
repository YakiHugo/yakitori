import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import type { JsonObject, JsonValue } from "../kernel/index.ts"

export const HookEvent = {
  PreToolUse: "PreToolUse",
  PermissionRequest: "PermissionRequest",
  PostToolUse: "PostToolUse",
  PreCompact: "PreCompact",
  PostCompact: "PostCompact",
  SessionStart: "SessionStart",
  SessionEnd: "SessionEnd",
  UserPromptSubmit: "UserPromptSubmit",
  SubagentStart: "SubagentStart",
  SubagentStop: "SubagentStop",
  Stop: "Stop",
  Interrupt: "Interrupt",
} as const

export type HookEvent = (typeof HookEvent)[keyof typeof HookEvent]

export type HookHandler = Readonly<{
  type: "command"
  command: string
  timeoutMs?: number
  async?: boolean
  trustedHash?: string
}>

export type HookMatcherGroup = Readonly<{
  matcher?: string
  hooks: readonly HookHandler[]
}>

export type HookConfiguration = Readonly<
  Partial<Record<HookEvent, readonly HookMatcherGroup[]>>
>

export type HookRequest = Readonly<{
  event: HookEvent
  matcher?: string
  payload: JsonObject
  cwd: string
  signal?: AbortSignal
}>

export type HookOutcome = Readonly<{
  continue: boolean
  reason?: string
  additionalContext: readonly string[]
  updatedInput?: JsonValue
}>

export type HookRunner = Readonly<{
  run(request: HookRequest): Promise<HookOutcome>
  dispose(): Promise<void>
}>

export function createHookRunner(configuration: HookConfiguration): HookRunner {
  const shutdown = new AbortController()
  const asynchronousRuns = new Set<Promise<void>>()
  let disposePromise: Promise<void> | undefined

  return {
    async run(request) {
      if (shutdown.signal.aborted) throw new Error("Hook runner is disposed.")
      const groups = configuration[request.event] ?? []
      const handlers = groups.flatMap((group) =>
        matches(group.matcher, request.matcher) ? group.hooks : [],
      )
      const outcomes: HookOutcome[] = []
      for (const handler of handlers) {
        if (!hasTrustedHash(handler)) continue
        if (handler.async === true && request.event !== HookEvent.SessionEnd) {
          const run = runCommandHook(handler, {
            ...request,
            signal:
              request.signal === undefined
                ? shutdown.signal
                : AbortSignal.any([request.signal, shutdown.signal]),
          })
            .then(() => undefined)
            .catch(() => undefined)
          asynchronousRuns.add(run)
          void run.finally(() => asynchronousRuns.delete(run))
          continue
        }
        outcomes.push(await runCommandHook(handler, request))
      }
      const blocked = outcomes.find((outcome) => !outcome.continue)
      const updatedInput = [...outcomes]
        .reverse()
        .find((outcome) => outcome.updatedInput !== undefined)?.updatedInput
      return {
        continue: blocked === undefined,
        ...(blocked?.reason === undefined ? {} : { reason: blocked.reason }),
        additionalContext: outcomes.flatMap(
          (outcome) => outcome.additionalContext,
        ),
        ...(updatedInput === undefined ? {} : { updatedInput }),
      }
    },
    dispose() {
      disposePromise ??= (async () => {
        shutdown.abort()
        await Promise.allSettled([...asynchronousRuns])
      })()
      return disposePromise
    },
  }
}

export function hookHandlerHash(
  handler: Omit<HookHandler, "trustedHash">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        type: handler.type,
        command: handler.command,
        timeoutMs: handler.timeoutMs ?? 10_000,
        async: handler.async ?? false,
      }),
    )
    .digest("hex")
}

async function runCommandHook(
  handler: HookHandler,
  request: HookRequest,
): Promise<HookOutcome> {
  if (request.signal?.aborted === true)
    throw new DOMException("The operation was aborted.", "AbortError")
  const child = spawn(process.env.SHELL ?? "/bin/sh", ["-c", handler.command], {
    cwd: request.cwd,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    stdout = `${stdout}${chunk}`.slice(-1024 * 1024)
  })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-64 * 1024)
  })
  const timeoutMs = handler.timeoutMs ?? 10_000
  const result = await new Promise<Readonly<{ code: number | null }>>(
    (resolve, reject) => {
      let terminationError: Error | undefined
      let forceKill: ReturnType<typeof setTimeout> | undefined
      let closed = false
      let exitCode: number | null = null
      const signalProcess = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid !== undefined) {
            process.kill(-child.pid, signal)
          } else {
            child.kill(signal)
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
        }
      }
      const finish = () => {
        if (!closed || forceKill !== undefined) return
        cancelTimeout()
        request.signal?.removeEventListener("abort", onAbort)
        if (terminationError !== undefined) reject(terminationError)
        else resolve({ code: exitCode })
      }
      const cancelTimeout = scheduleHookTimeout(timeoutMs, () => {
        terminationError ??= new Error(
          `${request.event} hook timed out after ${timeoutMs}ms.`,
        )
        if (forceKill !== undefined) clearTimeout(forceKill)
        forceKill = undefined
        signalProcess("SIGKILL")
        finish()
      })
      const onAbort = () => {
        if (terminationError !== undefined) return
        terminationError = new DOMException(
          "The operation was aborted.",
          "AbortError",
        )
        signalProcess("SIGTERM")
        // A descendant may ignore SIGTERM after the shell exits and closes its
        // pipes. Keep ownership through escalation, not just the leader's exit.
        forceKill = setTimeout(() => {
          forceKill = undefined
          signalProcess("SIGKILL")
          finish()
        }, 1_000)
      }
      request.signal?.addEventListener("abort", onAbort, { once: true })
      child.once("error", (error) => {
        terminationError ??= error
      })
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        // Hooks are allowed to finish without consuming their input.
        if (error.code === "EPIPE") return
        terminationError ??= error
        signalProcess("SIGKILL")
      })
      // Like wait_with_output in the reference runners, completion includes
      // draining inherited pipes. A shell's exit alone does not end ownership.
      child.once("close", (code) => {
        closed = true
        exitCode = code
        finish()
      })
      child.stdin.end(
        `${JSON.stringify({ hook_event_name: request.event, ...request.payload })}\n`,
      )
      if (request.signal?.aborted === true) onAbort()
    },
  )
  if (result.code === 2) {
    return {
      continue: false,
      reason: stderr.trim() || `${request.event} hook blocked the operation.`,
      additionalContext: [],
    }
  }
  if (result.code !== 0) {
    throw new Error(
      `${request.event} hook exited with code ${String(result.code)}.${stderr.trim() === "" ? "" : ` ${stderr.trim()}`}`,
    )
  }
  if (stdout.trim() === "") return { continue: true, additionalContext: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (cause) {
    throw new Error(`${request.event} hook returned invalid JSON.`, { cause })
  }
  if (!isRecord(parsed)) {
    throw new Error(`${request.event} hook output must be a JSON object.`)
  }
  const hookSpecific = isRecord(parsed.hookSpecificOutput)
    ? parsed.hookSpecificOutput
    : undefined
  const reason =
    typeof parsed.stopReason === "string"
      ? parsed.stopReason
      : typeof parsed.reason === "string"
        ? parsed.reason
        : typeof hookSpecific?.permissionDecisionReason === "string"
          ? hookSpecific.permissionDecisionReason
          : undefined
  const blocked =
    parsed.continue === false ||
    parsed.decision === "block" ||
    hookSpecific?.permissionDecision === "deny"
  const additionalContext =
    typeof hookSpecific?.additionalContext === "string"
      ? [hookSpecific.additionalContext]
      : []
  return {
    continue: !blocked,
    ...(reason === undefined ? {} : { reason }),
    additionalContext,
    ...(hookSpecific?.updatedInput === undefined
      ? {}
      : { updatedInput: asJsonValue(hookSpecific.updatedInput) }),
  }
}

// Node truncates larger delays to 1ms. Preserve the configured deadline by
// scheduling bounded chunks against a monotonic clock, without capping it.
function scheduleHookTimeout(
  timeoutMs: number,
  expire: () => void,
): () => void {
  const deadline = performance.now() + timeoutMs
  let timer: ReturnType<typeof setTimeout>
  const schedule = () => {
    const remaining = deadline - performance.now()
    timer = setTimeout(
      () => {
        if (performance.now() < deadline) schedule()
        else expire()
      },
      Math.min(remaining, 2_147_483_647),
    )
    timer.unref()
  }
  schedule()
  return () => clearTimeout(timer)
}

function hasTrustedHash(handler: HookHandler): boolean {
  if (handler.trustedHash === undefined) return false
  const { trustedHash: _trustedHash, ...identity } = handler
  return hookHandlerHash(identity) === handler.trustedHash
}

function matches(
  pattern: string | undefined,
  value: string | undefined,
): boolean {
  if (pattern === undefined || pattern === "" || pattern === "*") return true
  if (value === undefined) return false
  try {
    return new RegExp(pattern).test(value)
  } catch (cause) {
    throw new Error(`Invalid hook matcher: ${pattern}`, { cause })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value
  }
  if (Array.isArray(value)) return value.map(asJsonValue)
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, asJsonValue(entry)]),
    )
  }
  throw new Error("Hook output is not JSON-compatible.")
}
