import { parentPort, workerData } from "node:worker_threads"
import {
  type Deferred,
  JSException,
  type JSValueHandle,
  QuickJS,
} from "quickjs-wasi"
import { scriptPrelude } from "./prelude.ts"
import {
  type ScriptHostMessage,
  type ScriptWorkerData,
  type ScriptWorkerMessage,
  scriptSafety,
} from "./protocol.ts"

if (!parentPort) throw new Error("The script VM requires an owned worker port.")
const port = parentPort
const data = workerData as ScriptWorkerData,
  interrupt = new Int32Array(data.interrupt),
  pending = new Map<number, Deferred>(),
  unhandled = new Map<number, JSValueHandle>(),
  shown = new Set<number>(),
  deliveries = new Set<number>()
let finished = false,
  pumping = false,
  scheduled = false,
  issued = 0,
  outputBytes = 0,
  cpuMs = 0,
  sliceStart = 0,
  running = false,
  outcomeJson: string | undefined
const post = (message: ScriptWorkerMessage) => port.postMessage(message)
const interrupted = () =>
  Atomics.load(interrupt, 0) !== 0 ||
  cpuMs + (running ? performance.now() - sliceStart : 0) >= scriptSafety.cpuMs

function fail(code: string, message: string): void {
  if (finished) return
  finished = true
  Atomics.store(interrupt, 0, 1)
  post({ type: "failed", code, message })
}

function guest<T>(operation: () => T): T {
  if (running) throw new Error("The script VM cannot be entered recursively.")
  running = true
  sliceStart = performance.now()
  post({ type: "busy", remainingMs: Math.max(0, scriptSafety.cpuMs - cpuMs) })
  try {
    return operation()
  } finally {
    cpuMs += performance.now() - sliceStart
    running = false
    post({ type: "idle" })
  }
}

// This SDK copies host Error stacks into the guest. Primitive bridge errors
// keep host paths out of guest-visible errors.
function guestError(message: string): never {
  throw message
}

async function main(): Promise<void> {
  const vm = await QuickJS.create({
    wasm: data.wasm,
    memoryLimit: scriptSafety.memoryBytes,
    maxStackSize: scriptSafety.stackBytes,
    interruptHandler: interrupted,
    wasi: () => ({ fd_write: () => 8 }),
    onUnhandledRejection(promise, _reason, handled) {
      const key = vm._getExports().qjs_get_value_ptr(promise.ptr)
      if (handled) {
        unhandled.get(key)?.dispose()
        unhandled.delete(key)
      } else if (!unhandled.has(key)) unhandled.set(key, promise.dup())
    },
  })
  // The pinned SDK's queue-to-empty convenience method cannot bound a chain
  // of tiny promise jobs. Poll between individual jobs, with bounded batches.
  const native = vm._getExports()
  const check = () => {
    if (finished || native.qjs_is_job_pending()) return
    if (outcomeJson !== undefined) {
      if (unhandled.size)
        fail(
          "script_unhandled_rejection",
          "The script left an unhandled promise rejection.",
        )
      else {
        finished = true
        post({ type: "done", outcomeJson })
      }
    } else if (pending.size === 0)
      fail(
        "script_stalled",
        "The script is waiting on a promise with no owned operation that can resume it.",
      )
  }
  const pump = () => {
    scheduled = false
    if (finished || pumping) return
    pumping = true
    try {
      guest(() => {
        for (let jobs = 0; jobs < 128 && native.qjs_is_job_pending(); jobs++) {
          if (interrupted()) {
            fail(
              "script_cpu_limit",
              "The script exceeded its one-second cumulative CPU safety budget.",
            )
            return
          }
          if (native.qjs_execute_pending_job() < 0) {
            vm.getException().dispose()
            fail(
              "script_vm_failure",
              "A script promise job failed or exceeded the VM resource safety bounds.",
            )
            return
          }
        }
      })
    } catch (cause) {
      if (!(cause instanceof JSException)) throw cause
      cause.dispose()
      fail(
        "script_vm_failure",
        "The script exceeded the VM resource safety bounds.",
      )
    } finally {
      pumping = false
    }
    if (!finished && native.qjs_is_job_pending()) schedule()
    else setImmediate(check)
  }
  const schedule = () => {
    if (scheduled || finished) return
    scheduled = true
    setImmediate(pump)
  }
  const call = vm.newFunction("tool_call", (name, argumentsJson) => {
    if (!name?.isString || !argumentsJson?.isString)
      return guestError("Use a tool name and JSON arguments.")
    const target = name.toString(),
      encoded = argumentsJson.toString()
    if (
      target.length > 512 ||
      Buffer.byteLength(encoded) > scriptSafety.argumentBytes
    )
      return guestError("Tool arguments exceed the bridge safety bounds.")
    if (issued >= scriptSafety.calls) {
      fail(
        "script_call_limit",
        "The script exceeded the 64-call fan-out safety boundary.",
      )
      return vm.undefined
    }
    const id = ++issued,
      promise = vm.newPromise()
    pending.set(id, promise)
    post({ type: "call", id, name: target, argumentsJson: encoded })
    return promise.handle
  })
  const text = vm.newFunction("script_print", (value) => {
    if (!value?.isString) return guestError("Print accepts serialized text.")
    const text = value.toString()
    outputBytes += Buffer.byteLength(text) + 1
    if (outputBytes > scriptSafety.outputBytes)
      fail(
        "script_output_limit",
        "Script output exceeded the 128KiB copied-output safety boundary.",
      )
    else post({ type: "text", text })
    return vm.undefined
  })
  const show = vm.newFunction("script_show", (value) => {
    if (!value?.isNumber || !Number.isSafeInteger(value.toNumber()))
      return guestError("Show requires a completed tool result.")
    const id = value.toNumber()
    if (!shown.has(id)) {
      shown.add(id)
      post({ type: "show", id })
    }
    return vm.undefined
  })
  const prelude = guest(() => vm.evalCode(scriptPrelude)),
    received = vm.newFunction("script_received", (value) => {
      if (!value?.isNumber || !deliveries.delete(value.toNumber()))
        throw new Error("Invalid script result delivery.")
      // Parsing must succeed before read observations become visible to edits.
      post({ type: "received", id: value.toNumber() })
      return vm.undefined
    }),
    runner = guest(() =>
      vm.callFunction(prelude, vm.undefined, call, text, show, received),
    )
  prelude.dispose()
  call.dispose()
  text.dispose()
  show.dispose()
  received.dispose()
  port.on("message", (message: ScriptHostMessage) => {
    if (finished) return
    if (message.type !== "reply" || typeof message.resultJson !== "string")
      throw new Error("Invalid script bridge reply.")
    const promise = pending.get(message.id)
    if (!promise) throw new Error("An unknown script call received a reply.")
    pending.delete(message.id)
    const value = vm.newString(message.resultJson)
    try {
      if (!value.isString) {
        vm.getException().dispose()
        fail(
          "script_vm_failure",
          "The script VM could not retain the tool reply within its resource safety bounds.",
        )
        return
      }
      deliveries.add(message.id)
      guest(() => promise.resolve(value))
    } finally {
      value.dispose()
      promise.handle.dispose()
    }
    schedule()
  })
  try {
    const source = vm.newString(data.code),
      args = vm.newString(data.argumentsJson)
    let task: JSValueHandle
    try {
      task = guest(() => vm.callFunction(runner, vm.undefined, source, args))
    } finally {
      source.dispose()
      args.dispose()
      runner.dispose()
    }
    void vm.resolvePromise(task).then((settled) => {
      const value = "value" in settled ? settled.value : settled.error
      try {
        if (!("value" in settled) || !value.isString) {
          fail(
            "script_vm_failure",
            "The script VM did not produce a serialized outcome.",
          )
          return
        }
        outcomeJson = value.toString()
        if (
          Buffer.byteLength(outcomeJson) + outputBytes >
          scriptSafety.outputBytes
        ) {
          fail(
            "script_output_limit",
            "The script result exceeded the 128KiB copied-output safety boundary.",
          )
          return
        }
      } finally {
        value.dispose()
      }
      setImmediate(check)
    })
    task.dispose()
    schedule()
  } catch (cause) {
    if (!(cause instanceof JSException)) throw cause
    cause.dispose()
    fail(
      "script_vm_failure",
      "The script exceeded the VM resource safety bounds.",
    )
  }
}

void main().catch((cause: unknown) => {
  throw cause
})
