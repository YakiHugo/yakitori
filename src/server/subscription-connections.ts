import type { SubscriptionConnection } from "../protocol/providers.ts"

export type { SubscriptionConnection } from "../protocol/providers.ts"

import { type ChildProcess, spawn } from "node:child_process"
import { ConfigurationError } from "./config-errors.ts"

export type SubscriptionConnections = {
  read(): Promise<readonly SubscriptionConnection[]>
  login(id: string): Promise<readonly SubscriptionConnection[]>
  cancel(id: string): Promise<readonly SubscriptionConnection[]>
  importAccount(
    id: string,
    text?: string,
  ): Promise<readonly SubscriptionConnection[]>
  refresh(): Promise<void>
  close(): Promise<void>
}

// The first-party CLI owns browser authentication and its credential file.
// Yakitori owns only this short-lived login process and imports its result.
export function createSubscriptionConnections(input: {
  readAvailability(): Promise<Readonly<Record<"codex" | "grok", boolean>>>
  refresh(): Promise<void>
  importAccount(id: "codex" | "grok", text?: string): Promise<void>
  loginCompleted(id: "codex" | "grok"): Promise<void>
}): SubscriptionConnections {
  let closed = false
  const imports = new Set<Promise<void>>()
  const jobs = new Map<
    string,
    {
      child?: ChildProcess
      completion?: Promise<void>
      state: "running" | "succeeded" | "failed"
      url?: string
      message?: string
    }
  >()
  const read = async () => {
    const available = await input.readAvailability()
    return (["codex", "grok"] as const).map((id) => {
      const job = jobs.get(id)
      return {
        id,
        name: id === "codex" ? "Codex CLI" : "Grok",
        available: available[id],
        ...(job === undefined
          ? {}
          : {
              login: {
                state: job.state,
                ...(job.url ? { url: job.url } : {}),
                ...(job.message ? { message: job.message } : {}),
              },
            }),
      }
    })
  }
  const stop = async (child: ChildProcess) => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000)
      child.once("close", () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill("SIGTERM")
    })
  }
  return {
    read,
    refresh: input.refresh,
    async importAccount(id, text) {
      if (closed) throw new ConfigurationError("Subscription login is closed.")
      if (id !== "codex" && id !== "grok")
        throw new ConfigurationError(
          "Unknown subscription. Choose ChatGPT or Grok.",
        )
      if (jobs.get(id)?.state === "running")
        throw new ConfigurationError(
          "Cancel the current sign-in before importing an account.",
        )
      const importing = input.importAccount(id, text)
      imports.add(importing)
      try {
        await importing
      } finally {
        imports.delete(importing)
      }
      const available = await input.readAvailability()
      if (!available[id])
        throw new ConfigurationError(
          "The account could not be connected. Sign in and try again.",
        )
      jobs.delete(id)
      return read()
    },
    async cancel(id) {
      const job = jobs.get(id)
      if (job?.state === "running") {
        job.state = "failed"
        if (job.child) await stop(job.child)
        await job.completion
        if (jobs.get(id) === job) jobs.delete(id)
      }
      return read()
    },
    async login(id) {
      if (closed) throw new ConfigurationError("Subscription login is closed.")
      if (id !== "codex" && id !== "grok")
        throw new ConfigurationError(
          "Unknown subscription. Choose ChatGPT or Grok.",
        )
      if (jobs.get(id)?.state === "running") return read()
      const child = spawn(id, ["login"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      })
      const job: {
        child?: ChildProcess
        completion?: Promise<void>
        state: "running" | "succeeded" | "failed"
        url?: string
        message?: string
      } = { child, state: "running" }
      jobs.set(id, job)
      let tail = ""
      const receive = (chunk: Buffer) => {
        tail = (tail + chunk.toString("utf8")).slice(-16_384)
        // CLI output may contain ANSI escapes around the URL.
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal escape sequences before URL parsing.
        const plain = tail.replace(/\u001b\[[0-9;]*m/g, "")
        const urls = plain.match(/https:\/\/[^\s<>"]+/g)
        const url = urls?.find((value) => {
          try {
            return ["auth.openai.com", "auth.x.ai"].includes(
              new URL(value).hostname,
            )
          } catch {
            return false
          }
        })
        if (url) job.url = url
      }
      child.stdout?.on("data", receive)
      child.stderr?.on("data", receive)
      child.once("error", (cause: NodeJS.ErrnoException) => {
        job.state = "failed"
        job.message =
          cause.code === "ENOENT"
            ? `Install the ${id} CLI first, then try signing in again.`
            : `Could not start ${id}: ${cause.message}`
        delete job.child
      })
      child.once("exit", (code) => {
        delete job.child
        if (job.state === "failed") return
        if (code !== 0 || closed) {
          job.state = "failed"
          job.message = `The ${id} login ended before authentication completed. Try again.`
          return
        }
        const importing = input
          .loginCompleted(id)
          .then(async () => {
            const available = await input.readAvailability()
            if (!available[id])
              throw new ConfigurationError(
                "Sign-in finished without a usable account. Try signing in again.",
              )
          })
          .then(
            () => {
              if (job.state === "running") job.state = "succeeded"
            },
            (cause: unknown) => {
              if (job.state === "running") {
                job.state = "failed"
                job.message =
                  cause instanceof Error
                    ? cause.message
                    : "Could not import the login."
              }
            },
          )
        job.completion = importing
        imports.add(importing)
        void importing.finally(() => imports.delete(importing))
      })
      return read()
    },
    async close() {
      closed = true
      await Promise.all(
        [...jobs.values()].map(async (job) => {
          const child = job.child
          if (!child) return
          await stop(child)
        }),
      )
      // Each failure is delivered to its import request or login job; shutdown
      // still waits for credential persistence without replaying that failure.
      await Promise.allSettled(imports)
    },
  }
}
