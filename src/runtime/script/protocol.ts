import type { JsonValue } from "../../kernel/index.ts"

// Host resource guards, not product quotas. Each run owns a fresh VM/worker;
// bound retained guest memory, bridge fan-out and copied output independently.
// Scripts orchestrate tools: CPU excludes tool/approval wait, while the wall
// deadline bounds retention of the exclusive execution lease. The worker cap
// prevents simultaneous VM heaps and fan-out from growing with thread count.
export const scriptSafety = Object.freeze({
  sourceBytes: 64 * 1024,
  argumentBytes: 64 * 1024,
  resultBytes: 2 * 1024 * 1024,
  outputBytes: 128 * 1024,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 256 * 1024,
  cpuMs: 1000,
  wallMs: 120_000,
  calls: 64,
  workers: 4,
})

export type ScriptWorkerData = Readonly<{
  code: string
  argumentsJson: string
  wasm: WebAssembly.Module
  interrupt: SharedArrayBuffer
}>

export type ScriptWorkerMessage =
  | { type: "call"; id: number; name: string; argumentsJson: string }
  | { type: "received"; id: number }
  | { type: "text"; text: string }
  | { type: "show"; id: number }
  | { type: "busy"; remainingMs: number }
  | { type: "idle" }
  | { type: "done"; outcomeJson: string }
  | { type: "failed"; code: string; message: string }

export type ScriptHostMessage = {
  type: "reply"
  id: number
  resultJson: string
}

export type ScriptOutcome =
  | { ok: true; value: JsonValue }
  | { ok: false; code: string; message: string }
