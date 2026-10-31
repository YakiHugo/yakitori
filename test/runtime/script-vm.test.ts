import { readFile } from "node:fs/promises"
import { Worker } from "node:worker_threads"
import { expect, it } from "vitest"
import type { JsonValue } from "../../src/kernel/index.ts"
import { runScript } from "../../src/runtime/script/host.ts"
import type { ScriptWorkerMessage } from "../../src/runtime/script/protocol.ts"
import type {
  ComposedToolResult,
  ToolExecutionContext,
} from "../../src/runtime/tools/types.ts"
import { createVisibleFileObservations } from "../../src/runtime/tools/visible-file-observations.ts"

const noCalls: ToolExecutionContext = {
  workspaceRoot: "/",
  toolCalls: {
    execute: async () => {
      throw new Error("Unexpected tool invocation")
    },
  },
}
const reply = (output: JsonValue): ComposedToolResult => ({
  toolCallId: "child",
  result: { ok: true, output: output ?? null, content: "result" },
  content: [{ type: "text", text: "result" }],
})

it("computes in a fresh VM without ambient Node, network or filesystem access", async () => {
  const code = `globalThis.marker = 1; print(args.n); return [args.n * 2, typeof process, typeof require, typeof fetch, typeof setTimeout, typeof readFile, typeof WebAssembly]`
  expect(await runScript(code, { n: 7 }, noCalls)).toMatchObject({
    outcome: {
      ok: true,
      value: [
        14,
        "undefined",
        "undefined",
        "undefined",
        "undefined",
        "undefined",
        "undefined",
      ],
    },
    text: ["7"],
  })
  expect(
    (await runScript("return typeof marker", null, noCalls)).outcome,
  ).toEqual({ ok: true, value: "undefined" })
})

it("delivers tool results before resuming the guest and forwards only owned media", async () => {
  const observations = createVisibleFileObservations(),
    hash = "a".repeat(64),
    received: string[] = []
  const image = {
    type: "image" as const,
    mediaType: "image/png" as const,
    data: "fixture",
  }
  const result = await runScript(
    `const r = await tools.call('read', {}); const e = await tools.call('edit', {}); show(r); return e.output`,
    null,
    {
      workspaceRoot: "/",
      visibleFileObservations: observations,
      toolCalls: {
        async execute(name) {
          received.push(name)
          if (name === "read")
            return {
              ...reply({
                fileObservation: {
                  path: "/file",
                  kind: "whole_file_read",
                  complete: true,
                  sha256: hash,
                },
              }),
              content: [image],
            }
          expect(observations.latest("/file")).toMatchObject({
            sha256: hash,
            complete: true,
          })
          return reply({ edited: true })
        },
      },
    },
  )
  expect(received).toEqual(["read", "edit"])
  expect(result.outcome).toEqual({ ok: true, value: { edited: true } })
  expect(result.shown.flatMap((entry) => entry.content)).toEqual([image])
  expect(result.fileObservations).toHaveLength(1)
  expect(
    (await runScript("show({callId:99}); return 1", null, noCalls)).outcome,
  ).toMatchObject({ ok: false, code: "script_invalid_result" })
})

it("marks oversized completed replies without granting unseen file revisions", async () => {
  const observations = createVisibleFileObservations()
  const result = await runScript("return await tools.call('large', {})", null, {
    workspaceRoot: "/",
    visibleFileObservations: observations,
    toolCalls: {
      async execute() {
        return reply({
          text: "x".repeat(2 * 1024 * 1024),
          fileObservation: {
            path: "/file",
            kind: "whole_file_read",
            complete: true,
            sha256: "a".repeat(64),
          },
        })
      },
    },
  })
  expect(result.outcome).toMatchObject({
    ok: true,
    value: { ok: true, truncated: true },
  })
  expect(observations.latest("/file")).toBeUndefined()
  expect(result.fileObservations).toEqual([])
})

it("does not acknowledge a tool reply that the guest cannot decode", async () => {
  const wasm = await WebAssembly.compile(
    await readFile(new URL(import.meta.resolve("quickjs-wasi/quickjs.wasm"))),
  )
  const worker = new Worker(
    new URL("../../src/runtime/script/worker.ts", import.meta.url),
    {
      workerData: {
        code: "try { await tools.call('read',{}) } catch {} return 'caught'",
        argumentsJson: "null",
        wasm,
        interrupt: new SharedArrayBuffer(4),
      },
    },
  )
  const done = Promise.withResolvers<string>(),
    acknowledgements: number[] = []
  const timeout = setTimeout(
    () => done.reject(new Error("VM bridge did not settle")),
    5000,
  )
  try {
    worker.on("message", (message: ScriptWorkerMessage) => {
      if (message.type === "call")
        worker.postMessage({ type: "reply", id: message.id, resultJson: "{" })
      else if (message.type === "received") acknowledgements.push(message.id)
      else if (message.type === "done") done.resolve(message.outcomeJson)
      else if (message.type === "failed")
        done.reject(new Error(message.message))
    })
    worker.once("error", done.reject)
    expect(JSON.parse(await done.promise)).toEqual({
      ok: true,
      value: "caught",
    })
    expect(acknowledgements).toEqual([])
  } finally {
    clearTimeout(timeout)
    await worker.terminate()
  }
})

it.each([
  "while(true) {}",
  "while(true) await null",
  "return {toJSON(){while(true){}}}",
])("bounds guest CPU, including promise jobs and result serialization: %s", async (code) => {
  expect((await runScript(code, null, noCalls)).outcome).toMatchObject({
    ok: false,
  })
  expect((await runScript("return 42", null, noCalls)).outcome).toEqual({
    ok: true,
    value: 42,
  })
})

it("bounds guest allocation, printed output and call fan-out", async () => {
  expect(
    (
      await runScript(
        "const xs=[]; while(true) xs.push(new Array(100000).fill(1))",
        null,
        noCalls,
      )
    ).outcome,
  ).toMatchObject({ ok: false })
  expect(
    (await runScript("print('x'.repeat(131073))", null, noCalls)).outcome,
  ).toMatchObject({ ok: false, code: "script_output_limit" })
  let calls = 0
  const result = await runScript(
    "for(let i=0;i<65;i++) await tools.call('small',{})",
    null,
    {
      workspaceRoot: "/",
      toolCalls: {
        async execute() {
          calls++
          return reply(null)
        },
      },
    },
  )
  expect(result.outcome).toMatchObject({ ok: false, code: "script_call_limit" })
  expect(calls).toBe(64)
})

it("detects unhandled rejection and stalled promises while permitting handled rejection", async () => {
  expect(
    (await runScript("Promise.reject('unhandled'); return 1", null, noCalls))
      .outcome,
  ).toMatchObject({ ok: false, code: "script_unhandled_rejection" })
  expect(
    (await runScript("await new Promise(()=>{})", null, noCalls)).outcome,
  ).toMatchObject({ ok: false, code: "script_stalled" })
  expect(
    (
      await runScript(
        "await Promise.reject('handled').catch(()=>{}); return 1",
        null,
        noCalls,
      )
    ).outcome,
  ).toEqual({ ok: true, value: 1 })
})

it.each([
  "cancel",
  "unawaited",
] as const)("drains an owned child after %s before the script settles", async (mode) => {
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    controller = new AbortController()
  let drained = false,
    settled = false,
    childSignal: AbortSignal | undefined
  const run = runScript(
    mode === "cancel"
      ? "await tools.call('owned',{})"
      : "tools.call('owned',{}); return 1",
    null,
    {
      ...noCalls,
      signal: controller.signal,
      toolCalls: {
        async execute(_name, _args, signal) {
          childSignal = signal
          started.resolve()
          await release.promise
          drained = true
          return reply(null)
        },
      },
    },
  )
  const result = run.then(
    (value) => {
      settled = true
      return value
    },
    (error: unknown) => {
      settled = true
      throw error
    },
  )
  // Attach the rejection observer before cancellation, without suppressing it.
  void result.catch(() => {})
  await started.promise
  if (mode === "cancel")
    controller.abort(new DOMException("Stopped", "AbortError"))
  await expect.poll(() => childSignal?.aborted).toBe(true)
  expect(settled).toBe(false)
  release.resolve()
  if (mode === "cancel")
    await expect(result).rejects.toMatchObject({ name: "AbortError" })
  else
    expect((await result).outcome).toMatchObject({
      ok: false,
      code: "script_unawaited_calls",
    })
  expect(drained).toBe(true)
})

it("preserves successful child lifetimes and exposes unexpected child failures", async () => {
  let signal: AbortSignal | undefined
  expect(
    (
      await runScript("await tools.call('session',{}); return 1", null, {
        ...noCalls,
        toolCalls: {
          async execute(_name, _args, lifetime) {
            signal = lifetime
            return reply(null)
          },
        },
      })
    ).outcome,
  ).toEqual({ ok: true, value: 1 })
  expect(signal?.aborted).toBe(false)
  await expect(
    runScript("try {await tools.call('broken',{})} catch {} return 1", null, {
      ...noCalls,
      toolCalls: {
        async execute() {
          throw new Error("Owned resource failed")
        },
      },
    }),
  ).rejects.toThrow("Owned resource failed")
})
