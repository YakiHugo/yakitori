import { readFile } from "node:fs/promises"
import { Worker } from "node:worker_threads"
import { settleTaskResources } from "../../core/session-task.ts"
import {
  isJsonObject,
  isJsonValue,
  type JsonValue,
} from "../../kernel/index.ts"
import type {
  ComposedToolResult,
  ToolExecutionContext,
} from "../tools/types.ts"
import {
  type FileObservationGrant,
  grantsFromToolOutput,
} from "../tools/visible-file-observations.ts"
import {
  type ScriptHostMessage,
  type ScriptOutcome,
  type ScriptWorkerMessage,
  scriptSafety,
} from "./protocol.ts"

let wasm: Promise<WebAssembly.Module> | undefined
let active = 0

export type ScriptRun = Readonly<{
  outcome: ScriptOutcome
  text: string[]
  shown: ComposedToolResult[]
  fileObservations: FileObservationGrant[]
}>

export async function runScript(
  code: string,
  args: JsonValue,
  context: ToolExecutionContext,
): Promise<ScriptRun> {
  context.signal?.throwIfAborted()
  const calls = context.toolCalls
  if (!calls)
    throw new Error("Scripts require an owned composed-tool execution scope.")
  const argumentsJson = JSON.stringify(args)
  const failure = (code: string, message: string): ScriptRun => ({
    outcome: { ok: false, code, message },
    text: [],
    shown: [],
    fileObservations: [],
  })
  if (
    Buffer.byteLength(code) > scriptSafety.sourceBytes ||
    Buffer.byteLength(argumentsJson) > scriptSafety.argumentBytes
  )
    return failure(
      "script_input_limit",
      "Script source and arguments must each fit the 64KiB input safety boundary.",
    )
  if (active >= scriptSafety.workers)
    return failure(
      "script_busy",
      "The host's four-worker script safety boundary is occupied.",
    )
  active++
  let worker: Worker | undefined,
    cpuTimer: NodeJS.Timeout | undefined,
    wallTimer: NodeJS.Timeout | undefined
  const controller = new AbortController(),
    lifetime = context.signal
      ? AbortSignal.any([context.signal, controller.signal])
      : controller.signal
  const interrupt = new SharedArrayBuffer(4),
    flags = new Int32Array(interrupt)
  const terminal = Promise.withResolvers<ScriptOutcome>(),
    text: string[] = [],
    shown: ComposedToolResult[] = [],
    fileObservations: FileObservationGrant[] = []
  const pending = new Map<
    number,
    {
      state: "running" | "sent" | "received"
      result?: ComposedToolResult
      complete?: boolean
    }
  >()
  const operations: Promise<void>[] = []
  let settled = false,
    outputBytes = 0
  const stop = (outcome: ScriptOutcome) => {
    if (settled) return
    settled = true
    if (!outcome.ok) {
      Atomics.store(flags, 0, 1)
      controller.abort(
        new DOMException("Script execution stopped.", "AbortError"),
      )
    }
    terminal.resolve(outcome)
  }
  const onAbort = () => {
    Atomics.store(flags, 0, 1)
    controller.abort(context.signal?.reason)
    terminal.reject(context.signal?.reason)
  }
  try {
    wasm ??= readFile(
      new URL(
        import.meta.url.endsWith(".ts")
          ? import.meta.resolve("quickjs-wasi/quickjs.wasm")
          : "./quickjs.wasm",
        import.meta.url,
      ),
    )
      .then((bytes) => WebAssembly.compile(bytes))
      .catch((cause: unknown) => {
        wasm = undefined
        throw cause
      })
    const module = await wasm
    context.signal?.throwIfAborted()
    worker = new Worker(
      new URL(
        import.meta.url.endsWith(".ts") ? "./worker.ts" : "./script-worker.js",
        import.meta.url,
      ),
      { workerData: { code, argumentsJson, wasm: module, interrupt } },
    )
    const ownedWorker = worker
    const post = (message: ScriptHostMessage) => {
      if (!settled) ownedWorker.postMessage(message)
    }
    const handle = (message: ScriptWorkerMessage): void => {
      if (settled) return
      switch (message.type) {
        case "busy":
          clearTimeout(cpuTimer)
          cpuTimer = setTimeout(
            () =>
              stop({
                ok: false,
                code: "script_cpu_limit",
                message:
                  "The script exceeded its cumulative CPU safety budget.",
              }),
            Math.min(scriptSafety.cpuMs, Math.max(0, message.remainingMs)) +
              100,
          )
          break
        case "idle":
          clearTimeout(cpuTimer)
          break
        case "text":
          outputBytes += Buffer.byteLength(message.text) + 1
          if (outputBytes > scriptSafety.outputBytes)
            stop({
              ok: false,
              code: "script_output_limit",
              message:
                "Script output exceeded the copied-output safety boundary.",
            })
          else text.push(message.text)
          break
        case "call": {
          if (
            !Number.isSafeInteger(message.id) ||
            message.id <= 0 ||
            pending.has(message.id) ||
            pending.size >= scriptSafety.calls
          )
            throw new Error("Invalid script call identity.")
          const args: unknown = JSON.parse(message.argumentsJson)
          if (!isJsonValue(args))
            throw new Error("Invalid script tool arguments.")
          const entry: {
            state: "running" | "sent" | "received"
            result?: ComposedToolResult
            complete?: boolean
          } = { state: "running" }
          pending.set(message.id, entry)
          const operation = calls
            .execute(message.name, args, lifetime)
            .then((result) => {
              entry.result = result
              const body = {
                ...result.result,
                callId: message.id,
                content: result.content,
                presentation: undefined,
              }
              let encoded = JSON.stringify(body)
              entry.complete =
                Buffer.byteLength(encoded) <= scriptSafety.resultBytes
              if (!entry.complete)
                encoded = JSON.stringify({
                  callId: message.id,
                  ok: result.result.ok,
                  ...(result.result.ok
                    ? {}
                    : {
                        code: result.result.code,
                        message: result.result.message,
                      }),
                  truncated: true,
                  message:
                    "The operation completed, but its result exceeded the 2MiB bridge safety boundary. Inspect its execution record; do not replay it automatically.",
                })
              entry.state = "sent"
              post({ type: "reply", id: message.id, resultJson: encoded })
            })
            .catch((cause: unknown) => {
              // Unexpected child failures remain visible even if guest code catches.
              terminal.reject(cause)
              controller.abort(cause)
            })
          operations.push(operation)
          break
        }
        case "received": {
          const entry = pending.get(message.id)
          if (entry?.state !== "sent" || !entry.result)
            throw new Error("Invalid script delivery acknowledgement.")
          entry.state = "received"
          if (entry.complete && entry.result.result.output !== undefined) {
            for (const grant of grantsFromToolOutput(
              entry.result.result.output,
            )) {
              // Mutation observations are already applied at the tool boundary.
              if (
                grant.kind === "whole_file_read" ||
                grant.kind === "ranged_read"
              )
                context.visibleFileObservations?.apply(grant)
              fileObservations.push(grant)
            }
          }
          break
        }
        case "show": {
          const entry = pending.get(message.id)
          if (entry?.state !== "received" || !entry.result) {
            stop({
              ok: false,
              code: "script_invalid_result",
              message:
                "Show requires a result delivered by this script's own tool call.",
            })
            break
          }
          if (!shown.includes(entry.result)) shown.push(entry.result)
          break
        }
        case "done": {
          if (
            [...pending.values()].some((entry) => entry.state !== "received")
          ) {
            stop({
              ok: false,
              code: "script_unawaited_calls",
              message:
                "The script returned before its tool calls settled. Those calls were cancelled and drained; inspect their execution records before continuing.",
            })
            break
          }
          const value: unknown = JSON.parse(message.outcomeJson)
          if (!isJsonObject(value)) throw new Error("Invalid script outcome.")
          if (value.ok === true && isJsonValue(value.value))
            stop({ ok: true, value: value.value })
          else if (
            value.ok === false &&
            typeof value.code === "string" &&
            typeof value.message === "string"
          )
            stop({ ok: false, code: value.code, message: value.message })
          else throw new Error("Invalid script outcome envelope.")
          break
        }
        case "failed":
          stop({ ok: false, code: message.code, message: message.message })
          break
        default:
          throw new Error("Unknown script worker message.")
      }
    }
    ownedWorker.on("message", (message: ScriptWorkerMessage) => {
      try {
        handle(message)
      } catch (cause) {
        terminal.reject(cause)
      }
    })
    ownedWorker.once("error", terminal.reject)
    ownedWorker.once("exit", (exitCode) => {
      if (!settled)
        terminal.reject(
          new Error(`Script worker exited before settling (${exitCode}).`),
        )
    })
    wallTimer = setTimeout(
      () =>
        stop({
          ok: false,
          code: "script_timeout",
          message:
            "The script exceeded its two-minute wall-clock safety deadline.",
        }),
      scriptSafety.wallMs,
    )
    context.signal?.addEventListener("abort", onAbort, { once: true })
    if (context.signal?.aborted) onAbort()
    const outcome = await terminal.promise
    return { outcome, text, shown, fileObservations }
  } finally {
    settled = true
    clearTimeout(cpuTimer)
    clearTimeout(wallTimer)
    context.signal?.removeEventListener("abort", onAbort)
    Atomics.store(flags, 0, 1)
    // An exceptional host exit must also stop and drain every dispatched call.
    if (
      !controller.signal.aborted &&
      [...pending.values()].some((entry) => entry.state !== "received")
    )
      controller.abort(
        new DOMException("Script execution stopped.", "AbortError"),
      )
    try {
      await settleTaskResources(async () => {
        try {
          if (worker) await worker.terminate()
        } finally {
          await Promise.all(operations)
        }
      })
    } finally {
      active--
    }
  }
}
