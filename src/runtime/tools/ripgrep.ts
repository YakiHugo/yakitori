import { spawn } from "node:child_process"

const RAW_OUTPUT_LIMIT = 5 * 1024 * 1024

export type RipgrepRecordStopReason =
  | "aborted"
  | "consumer_limit"
  | "raw_byte_limit"
  | "record_byte_limit"
  | "timeout"

export type RipgrepRecordResult =
  | {
      readonly ok: true
      readonly stopReason?: RipgrepRecordStopReason
    }
  | { readonly ok: false; readonly message: string }

export async function runRipgrep(
  args: readonly string[],
  input: { readonly cwd: string; readonly signal?: AbortSignal },
): Promise<
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly message: string }
> {
  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let overflow = false
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > RAW_OUTPUT_LIMIT) {
        overflow = true
        child.kill()
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.on("error", (error) => {
      if (error.name === "AbortError") reject(error)
      else resolve({ ok: false, message: "ripgrep could not be launched." })
    })
    child.on("close", (code) => {
      if (overflow) {
        resolve({ ok: false, message: "ripgrep produced too much raw output." })
        return
      }
      if (code === 0 || code === 1) {
        resolve({ ok: true, stdout: Buffer.concat(stdout).toString("utf8") })
        return
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim()
      resolve({
        ok: false,
        message:
          detail.length === 0 ? `ripgrep exited with code ${code}.` : detail,
      })
    })
  })
}

export async function runRipgrepRecords(
  args: readonly string[],
  input: {
    readonly cwd: string
    readonly signal?: AbortSignal
    readonly timeoutMs: number
    readonly maxBytes: number
    readonly maxRecordBytes: number
    readonly delimiter: "newline" | "null"
    readonly onRecord: (record: string) => boolean
  },
): Promise<RipgrepRecordResult> {
  return new Promise((resolve) => {
    const child = spawn("rg", args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const delimiter = input.delimiter === "newline" ? 0x0a : 0x00
    const stderr: Buffer[] = []
    let stderrBytes = 0
    let pending = Buffer.alloc(0)
    let bytes = 0
    let settled = false
    let stopReason: RipgrepRecordStopReason | undefined

    const stop = (reason: RipgrepRecordStopReason) => {
      if (stopReason !== undefined) return
      stopReason = reason
      child.kill()
    }
    const consume = (chunk: Buffer) => {
      if (stopReason !== undefined) return
      const remaining = input.maxBytes - bytes
      const accepted = chunk.subarray(0, Math.max(0, remaining))
      bytes += accepted.byteLength
      pending = Buffer.concat([pending, accepted])

      let boundary = pending.indexOf(delimiter)
      while (boundary >= 0 && stopReason === undefined) {
        if (boundary > input.maxRecordBytes) {
          stop("record_byte_limit")
          return
        }
        const record = pending.subarray(0, boundary).toString("utf8")
        pending = pending.subarray(boundary + 1)
        if (!input.onRecord(record)) {
          stop("consumer_limit")
          return
        }
        boundary = pending.indexOf(delimiter)
      }
      if (pending.byteLength > input.maxRecordBytes) {
        stop("record_byte_limit")
      } else if (accepted.byteLength < chunk.byteLength) {
        stop("raw_byte_limit")
      }
    }
    const abort = () => stop("aborted")
    const timer = setTimeout(() => stop("timeout"), input.timeoutMs)
    input.signal?.addEventListener("abort", abort, { once: true })
    if (input.signal?.aborted === true) abort()

    child.stdout.on("data", consume)
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = 64 * 1024 - stderrBytes
      if (remaining <= 0) return
      const accepted = chunk.subarray(0, remaining)
      stderr.push(accepted)
      stderrBytes += accepted.byteLength
    })
    child.on("error", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener("abort", abort)
      resolve({ ok: false, message: "ripgrep could not be launched." })
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener("abort", abort)
      if (stopReason !== undefined) {
        resolve({ ok: true, stopReason })
        return
      }
      if (pending.byteLength > 0) {
        if (pending.byteLength > input.maxRecordBytes) {
          resolve({ ok: true, stopReason: "record_byte_limit" })
          return
        }
        input.onRecord(pending.toString("utf8"))
      }
      if (code === 0 || code === 1) {
        resolve({ ok: true })
        return
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim()
      resolve({
        ok: false,
        message:
          detail.length === 0 ? `ripgrep exited with code ${code}.` : detail,
      })
    })
  })
}
