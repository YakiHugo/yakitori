import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"

export type AcpCommand = {
  command: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export class AcpRpcError extends Error {
  code: number
  data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
    this.name = "AcpRpcError"
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an ACP object")
  }
  return value as Record<string, unknown>
}

// ACP v1 stdio is newline-delimited JSON-RPC, not LSP Content-Length framing.
export class AcpStdioConnection {
  private process: ChildProcessWithoutNullStreams
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
    }
  >()
  private nextId = 0
  private buffer = ""
  private failure: Error | undefined
  private completion: Promise<void>
  private termination: Promise<void> | undefined
  private closed = false
  private handlers: {
    notification: (method: string, params: unknown) => void
    request: (method: string, params: unknown) => Promise<unknown>
    disconnected: (error: Error) => void
    stderr?: (text: string) => void
  }

  constructor(command: AcpCommand, handlers: AcpStdioConnection["handlers"]) {
    this.handlers = handlers
    this.process = spawn(command.command, command.args ?? [], {
      ...(command.cwd ? { cwd: command.cwd } : {}),
      ...(command.env ? { env: { ...process.env, ...command.env } } : {}),
      stdio: "pipe",
      shell: false,
      detached: process.platform !== "win32",
    })
    this.completion = new Promise((resolve) =>
      this.process.once("close", () => {
        this.closed = true
        resolve()
      }),
    )
    this.process.stdout.setEncoding("utf8")
    this.process.stderr.setEncoding("utf8")
    this.process.stderr.on("data", (text: string) => handlers.stderr?.(text))
    this.process.stdout.on("data", (chunk: string) => {
      if (this.failure) return
      try {
        this.buffer += chunk
        // Implementation memory boundary, not an ACP or product quota.
        if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) {
          throw new Error(
            "ACP frame exceeds the 16 MiB transport safety boundary",
          )
        }
        let end = this.buffer.indexOf("\n")
        while (end !== -1) {
          const line = this.buffer.slice(0, end)
          this.buffer = this.buffer.slice(end + 1)
          if (line.trim()) this.receive(object(JSON.parse(line)))
          end = this.buffer.indexOf("\n")
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    this.process.on("error", (error) => this.fail(error))
    this.process.stdin.on("error", (error) => this.fail(error))
    this.process.on("exit", (code, signal) => {
      this.fail(new Error(`ACP process exited (${signal ?? code})`))
    })
    this.process.on("close", (code, signal) => {
      this.fail(new Error(`ACP process closed (${signal ?? code})`))
    })
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ jsonrpc: "2.0", id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    if (this.failure) throw this.failure
    this.write({ jsonrpc: "2.0", method, params })
  }

  async close(reason = new Error("ACP connection closed")): Promise<void> {
    this.fail(reason)
    await Promise.all([this.completion, this.termination])
  }

  private write(message: unknown): void {
    if (this.failure) return
    this.process.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) this.fail(error)
    })
  }

  private receive(message: Record<string, unknown>): void {
    if (message.jsonrpc !== "2.0")
      throw new Error("Invalid ACP JSON-RPC version")
    if (typeof message.method === "string") {
      if (message.id === undefined) {
        this.handlers.notification(message.method, message.params)
        return
      }
      if (typeof message.id !== "string" && typeof message.id !== "number") {
        throw new Error("Invalid ACP request ID")
      }
      const id = message.id
      void this.handlers.request(message.method, message.params).then(
        (result) => this.write({ jsonrpc: "2.0", id, result }),
        (error: unknown) =>
          this.write({
            jsonrpc: "2.0",
            id,
            error: {
              code: error instanceof AcpRpcError ? error.code : -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
      )
      return
    }
    if (typeof message.id !== "number")
      throw new Error("Invalid ACP response ID")
    const pending = this.pending.get(message.id)
    if (!pending) return
    if (message.error !== undefined) {
      const error = object(message.error)
      this.pending.delete(message.id)
      pending.reject(
        new AcpRpcError(
          typeof error.code === "number" ? error.code : -32603,
          typeof error.message === "string"
            ? error.message
            : "ACP request failed",
          error.data,
        ),
      )
    } else if ("result" in message) {
      this.pending.delete(message.id)
      pending.resolve(message.result)
    } else {
      this.pending.delete(message.id)
      pending.reject(new Error("ACP response has neither result nor error"))
    }
  }

  private signal(signal: NodeJS.Signals): void {
    if (!this.process.pid) return
    if (process.platform === "win32") {
      this.process.kill(signal)
      return
    }
    try {
      process.kill(-this.process.pid, signal)
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ESRCH")
      )
        throw error
    }
  }

  private groupExists(): boolean {
    if (!this.process.pid) return false
    if (process.platform === "win32")
      return this.process.exitCode === null && this.process.signalCode === null
    try {
      process.kill(-this.process.pid, 0)
      return true
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH")
        return false
      throw error
    }
  }

  private terminateGroup(): Promise<void> {
    // The leader can exit while descendants retain pipes, or descendants can
    // close their pipes and keep running. Neither exitCode nor pipe closure is
    // proof that the owned process group has finished.
    this.signal("SIGTERM")
    if (!this.groupExists()) return Promise.resolve()
    return new Promise((resolve) => {
      const kill = setTimeout(() => {
        this.signal("SIGKILL")
        resolve()
      }, 1000)
      const finishIfEmpty = () => {
        if (this.groupExists()) return
        clearTimeout(kill)
        resolve()
      }
      if (this.closed) finishIfEmpty()
      else this.process.once("close", finishIfEmpty)
    })
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.process.stdin.destroy()
    this.termination = this.terminateGroup()
    this.handlers.disconnected(error)
  }
}
