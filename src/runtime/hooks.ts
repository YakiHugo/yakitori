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
}>

export function createHookRunner(configuration: HookConfiguration): HookRunner {
  return {
    async run(request) {
      const groups = configuration[request.event] ?? []
      const handlers = groups.flatMap((group) =>
        matches(group.matcher, request.matcher) ? group.hooks : [],
      )
      const outcomes: HookOutcome[] = []
      for (const handler of handlers) {
        if (!hasTrustedHash(handler)) continue
        if (handler.async === true) {
          void runCommandHook(handler, request).catch(() => undefined)
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
  const child = spawn(process.env.SHELL ?? "/bin/sh", ["-c", handler.command], {
    cwd: request.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  })
  child.stdin.end(
    `${JSON.stringify({ hook_event_name: request.event, ...request.payload })}\n`,
  )
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
      const timeout = setTimeout(() => {
        child.kill("SIGKILL")
        reject(
          new Error(`${request.event} hook timed out after ${timeoutMs}ms.`),
        )
      }, timeoutMs)
      timeout.unref()
      const onAbort = () => {
        child.kill("SIGTERM")
        reject(new DOMException("The operation was aborted.", "AbortError"))
      }
      request.signal?.addEventListener("abort", onAbort, { once: true })
      child.once("error", reject)
      child.once("exit", (code) => {
        clearTimeout(timeout)
        request.signal?.removeEventListener("abort", onAbort)
        resolve({ code })
      })
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
